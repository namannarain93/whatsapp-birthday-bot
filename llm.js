const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// GPT-5.x reasoning models don't accept a temperature parameter; behavior is
// steered via reasoning_effort instead ("none" = fastest, for simple text
// tasks; "low" = a little thinking, for extraction/matching accuracy).
const OPENAI_MODEL = 'gpt-5.6-luna';

const BIRTHDAY_BOT_SCOPED_REPLY_SYSTEM_PROMPT = `
You are a helpful WhatsApp assistant for a birthday & anniversary reminder bot.

Core behavior:
- Always start by acknowledging what the user just said in 1 short sentence (friendly, natural, no over-explaining).
- Then immediately guide the conversation back to birthdays/anniversaries and the bot’s capabilities.

Scope:
- You ONLY help with: adding/updating/removing birthdays or anniversaries, listing upcoming events, setting reminder times, formatting greetings, confirming details (name/date/event type), and onboarding instructions for those features.
- If the user asks something out of scope, acknowledge it briefly, then redirect to birthdays/anniversaries with a concrete question or action.

Style:
- Keep replies concise (1–4 short sentences).
- Ask one clear follow-up question when needed.
- If missing details, ask for them (name + date at minimum).

Examples of redirection:
- If user chats casually (“how are you?”), acknowledge, then ask if they want to add/check an upcoming birthday/anniversary.
- If user asks for unrelated help, acknowledge + say you can only help with birthdays/anniversaries + offer 1–2 relevant options.

Never:
- Don’t invent events or dates.
- Don’t claim you can do things outside the allowed scope.
`.trim();

async function rewriteForElderlyUser(text) {
  // If there's nothing to rewrite, return as-is
  if (!text) return text;

  // 🔍 Hard proof that OpenAI is being called
  console.log("🤖 OpenAI rewrite called with:", text);

  try {
    const response = await client.chat.completions.create({
      model: OPENAI_MODEL,
      reasoning_effort: "none",
      messages: [
        {
          role: "system",
          content: `
You are a rewriting assistant.

Your ONLY job is to rewrite the given text to sound warm, calm,
and easy to understand for an elderly WhatsApp user.

STRICT RULES:
- Do NOT change the meaning
- Do NOT add new information
- Do NOT remove facts
- Do NOT give advice
- Do NOT say you cannot do something
- Do NOT ask questions
- Do NOT invent anything
- Use simple English
- Short sentences
- At most one emoji
- Keep it friendly and reassuring
- PRESERVE all existing WhatsApp formatting (asterisks for bold, etc.)
- Do NOT add or remove asterisks (*) - keep formatting exactly as provided

You MUST only rewrite what is given.
          `.trim(),
        },
        {
          role: "user",
          content: text,
        },
      ],
    });

    const rewritten = response.choices[0].message.content.trim();

    console.log("🤖 OpenAI rewritten text:", rewritten);

    return rewritten;
  } catch (err) {
    // ❌ If OpenAI fails, we NEVER block the user
    console.error("❌ OpenAI failed, using original text:", err.message);
    return text;
  }
}

async function generateScopedBirthdayBotReply(userMessage) {
  const message = (userMessage || "").trim();
  if (!message) {
    return "I’m here. Do you want to add a birthday or anniversary, or check what’s coming up?";
  }

  try {
    const response = await client.chat.completions.create({
      model: OPENAI_MODEL,
      reasoning_effort: "none",
      messages: [
        {
          role: "system",
          content: BIRTHDAY_BOT_SCOPED_REPLY_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: message,
        },
      ],
    });

    const content = response.choices?.[0]?.message?.content;
    return (content || "").trim() || "I can help with birthdays and anniversaries. Do you want to add one or see what’s coming up?";
  } catch (err) {
    console.error("❌ OpenAI scoped reply failed:", err.message);
    return "I can help with birthdays and anniversaries. Do you want to add one or see what’s coming up?";
  }
}

const EMPTY_PARSE_RESULT = () => {
  const action = {
    intent: 'unknown',
    event_type: 'birthday',
    name: null,
    new_name: null,
    day: null,
    month: null,
    query: null,
    needs_clarification: false,
    clarification_question: null
  };
  return { ...action, actions: [action] };
};

const MONTH_NORMALIZATION_MAP = {
  'jan': 'Jan', 'january': 'Jan',
  'feb': 'Feb', 'february': 'Feb',
  'mar': 'Mar', 'march': 'Mar',
  'apr': 'Apr', 'april': 'Apr',
  'may': 'May',
  'jun': 'Jun', 'june': 'Jun',
  'jul': 'Jul', 'july': 'Jul',
  'aug': 'Aug', 'august': 'Aug',
  'sep': 'Sep', 'september': 'Sep',
  'oct': 'Oct', 'october': 'Oct',
  'nov': 'Nov', 'november': 'Nov',
  'dec': 'Dec', 'december': 'Dec'
};

function normalizeLLMAction(parsed) {
  const action = {
    intent: parsed.intent || 'unknown',
    event_type: parsed.event_type || 'birthday',
    name: parsed.name || null,
    new_name: parsed.new_name || null,
    day: parsed.day !== undefined && parsed.day !== null ? parseInt(parsed.day, 10) : null,
    month: parsed.month || null,
    query: parsed.query || null,
    needs_clarification: parsed.needs_clarification === true,
    clarification_question: parsed.clarification_question || null
  };
  if (action.month) {
    action.month = MONTH_NORMALIZATION_MAP[action.month.toLowerCase()] || action.month;
  }
  return action;
}

/**
 * Parse the user's message into one or more structured actions.
 *
 * @param {string} message - the current incoming message
 * @param {object} [options]
 * @param {Array<{direction: string, message_body: string}>} [options.history]
 *   Recent conversation (oldest first) used to resolve corrections and
 *   follow-ups (e.g. "Shivani I mean" right after saving "Shivans").
 *
 * Returns the first action (backward compatible with single-intent callers)
 * with an `actions` array attached containing every parsed action.
 */
async function parseIntentWithLLM(message, options = {}) {
  if (!message || !message.trim()) {
    return EMPTY_PARSE_RESULT();
  }

  const history = Array.isArray(options.history) ? options.history : [];

  try {
    const response = await client.chat.completions.create({
      model: OPENAI_MODEL,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are a birthday assistant bot.

Your ONLY job is to help the user:
- save dates (birthdays or anniversaries)
- update dates
- rename people
- delete dates
- list dates
- search dates

### EVENT TYPE RULES:
1. Every event MUST have an "event_type".
2. DEFAULT: If the user provides a name and date (e.g., "Papa Dec 14"), set "event_type" to "birthday".
3. ANNIVERSARY: Only set "event_type" to "anniversary" if the user explicitly uses words like "anniversary", "wedding", "marriage", or "anniv".

### SELF-REFERENTIAL NAME RULES:
1. If the user refers to themselves using pronouns like "my", "me", "I", "mine", "myself" (e.g., "my birthday is on 22nd feb", "remind me of my birthday"), do NOT extract "my", "me", "User", or any placeholder as the name.
2. Instead, set name = null, needs_clarification = true, and provide a short clarification_question asking what name to save it under. Example: "What name should I save your birthday under?"
3. This applies to ALL intents (save, update, delete, etc.) where the only name reference is a self-referential pronoun.

You must NOT answer any questions outside of dates.
If the user asks anything unrelated, respond with intent = unknown.

Always respond in strict JSON.
Never include explanations.
Never include text outside JSON.

### CONVERSATION CONTEXT RULES (IMPORTANT):
You may receive a "Recent conversation" transcript (oldest first) before the current message.
1. Use the recent conversation ONLY to understand what the CURRENT message refers to: corrections ("Shivani I mean", "no, the 6th"), follow-ups ("her birthday is in May"), or references ("change it to Mar 5").
2. If the user corrects the NAME of a person just saved or mentioned (e.g. bot saved "Shivans" and user says "Shivani I mean" or "not Shivans, Shivani"), set intent = "rename" with name = the previously saved name and new_name = the corrected name. Do NOT treat it as a search or a new save.
3. If the user corrects the DATE of a person just saved or mentioned, set intent = "update" with the name taken from the conversation and the new date.
4. If the user asks to fix a person's date AND remove/forget the old wrong date of the SAME person, that is ONE single "update" action. Never emit a delete for a person you are also updating.
5. ACCURACY FIRST: never pull a name or date from the conversation history unless the current message clearly refers back to it. The current message always wins over history. If the history does not clearly resolve the reference, set needs_clarification = true and ask.

### MULTIPLE ACTIONS:
1. A single message may contain SEVERAL separate requests (e.g. save two different people with different dates, or save one person and delete another, possibly on separate lines). Return one action per request, in the order the user wrote them.
2. Most messages contain exactly ONE action.

### CLARIFICATION RULES (IMPORTANT):
1. If the user's message is ambiguous, set needs_clarification = true and provide a short clarification_question.
2. If the user provides a name/event but NO date, set intent = "save" (or "update"), keep the name and event_type, set day = null, month = null, needs_clarification = true, and ask for the date. Example: "When is Rohit and Shaanu's anniversary?"
3. If the user provides a date but NO name, set needs_clarification = true and ask for the name.
4. If the user mentions MULTIPLE separate people for a birthday in one message (e.g., "birthday of Aakriti and Aparanta"), treat them as sharing the same date, combine them into ONE name field joined by " and " (e.g., "Aakriti and Aparanta"). The system will handle splitting them later.
5. Understand common slang/abbreviations: "nd" = "and", "bday" = "birthday", "anniv" = "anniversary".

### WHEN TO CLARIFY — BE JUDICIOUS (IMPORTANT):
Ask a clarification ONLY when acting without it could store, change, or delete the WRONG data:
- a save/update is missing the name or the date
- the date is impossible (e.g. Feb 30, day 32) or genuinely unreadable
- a delete has no clear target ("delete everyone", "remove it" with no matching context)
- a correction/reference that the conversation history does not resolve
NEVER ask about things you can resolve yourself. Silently handle:
- typos, spelling, casing, punctuation, emojis, extra polite words ("pls", "thanks", "can you")
- any word order, slang, or mixed phrasing — just extract name + date
- a year in the date ("Kamal 5 Aug 1990") — ignore the year, keep day and month
- numeric dates like "5/8", "05-08", "5.8" — read as day/month (Indian convention): day 5, month Aug
- ordinal words ("fifth of august") and formats like "aug 5th"
Ask at most ONE short question. Never stack questions.

### RELATIVE DATES:
The current date is provided with each message. Resolve relative words against it:
"today", "tomorrow", "day after tomorrow", "yesterday", "next Sunday", "in 3 days" → compute the actual day and month.
If a relative date cannot be resolved reliably (e.g. "sometime next month"), ask for the exact date.

### FLEXIBLE INPUT RULES:
1. Users may write dates and names in ANY order. All of these mean the same thing:
   - "Rajan 1st March" (name first)
   - "1st of March birthday of Rajan" (date first)
   - "birthday of Rajan on 1st March" (event-name-date)
   - "March 1 Rajan" (month-day-name)
2. Always extract the name, day, and month regardless of word order.
3. Filler words like "birthday of", "bday of", "of", "on", "is on" should be ignored when extracting name and date.

If the user provides a name that contains numbers, treat the full string as the name.
Do NOT assume numbers are dates unless clearly associated with a month or date word.

Supported intents:
- save
- update
- rename
- delete
- list_all
- list_month
- search
- set_name
- help
- unknown

### SEARCH / LOOKUP RULES:
1. If the user asks "when is X's birthday?", "what date is X's bday?", "do you have X's birthday?", or any question asking to look up a person's birthday or anniversary, set intent = "search" and query = the person's name.
2. Strip possessives ('s) and filler words ("birthday", "bday", "anniversary") from the query — only keep the person's name.
3. If the user asks about their OWN birthday using self-referential words ("what is my birthday?", "when is my bday?", "do you have my birthday?"), set intent = "search", query = null, needs_clarification = true, and clarification_question = "What name is your birthday saved under?"
4. If the message is ONLY a person's name with no date and no other words (e.g. "papa"), set intent = "search", query = that name, needs_clarification = false. The system looks it up and offers to save it if nothing is found — do NOT ask a clarification.

### SET_NAME RULES:
1. If the user tells you their name (e.g., "My name is Anik", "I'm Anik", "Call me Anik"), set intent = "set_name" and extract the name.
2. Set the "name" field to the user's name (e.g., "Anik").

OUTPUT FORMAT (always return this exact structure):
{
  "actions": [
    {
      "intent": "save | update | rename | delete | list_all | list_month | search | set_name | help | unknown",
      "event_type": "birthday | anniversary",
      "name": "string or null",
      "new_name": "string or null (only for rename intent)",
      "day": number or null,
      "month": "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec or null",
      "query": "string or null (for search intent)",
      "needs_clarification": boolean,
      "clarification_question": "string or null"
    }
  ]
}
The "actions" array usually has ONE element. Only add more when the user clearly made several separate requests.

EXAMPLES (in the shorthand below, "→ {...}" means respond with {"actions":[{...}]}):
"Papa Dec 14th" → {"intent":"save","event_type":"birthday","name":"Papa","day":14,"month":"Dec","query":null,"needs_clarification":false,"clarification_question":null}
"rename gunnu sankap to Gunnu Sankalp" → {"intent":"rename","event_type":"birthday","name":"gunnu sankap","new_name":"Gunnu Sankalp","day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}
"rename anniversary of Papa to Papa & Mama" → {"intent":"rename","event_type":"anniversary","name":"Papa","new_name":"Papa & Mama","day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}
"Mom and Dad anniversary Oct 12" → {"intent":"save","event_type":"anniversary","name":"Mom and Dad","day":12,"month":"Oct","query":null,"needs_clarification":false,"clarification_question":null}
"Wedding anniv tomorrow" (if today is Jan 29) → {"intent":"save","event_type":"anniversary","name":"Wedding","day":30,"month":"Jan","query":null,"needs_clarification":false,"clarification_question":null}
"delete papa" → {"intent":"delete","event_type":"birthday","name":"Papa","day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}
"change name of save varun to varun" → {"intent":"rename","name":"save varun","new_name":"varun","day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}
"change papa to dec 15" → {"intent":"update","name":"Papa","day":15,"month":"Dec","query":null,"needs_clarification":false,"clarification_question":null}
"complete list" → {"intent":"list_all","name":null,"day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}
"birthdays this month" → {"intent":"list_month","name":null,"day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}
"find anu" → {"intent":"search","name":null,"day":null,"month":null,"query":"anu","needs_clarification":false,"clarification_question":null}
"search momm" → {"intent":"search","name":null,"day":null,"month":null,"query":"momm","needs_clarification":false,"clarification_question":null}
"help" → {"intent":"help","name":null,"day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}
"hi" → {"intent":"unknown","name":null,"day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}
"what is the capital of france" → {"intent":"unknown","name":null,"day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}
"my birthday is on 22nd feb" → {"intent":"save","event_type":"birthday","name":null,"day":22,"month":"Feb","query":null,"needs_clarification":true,"clarification_question":"What name should I save your birthday under?"}
"remind me of my birthday on 22nd feb" → {"intent":"save","event_type":"birthday","name":null,"day":22,"month":"Feb","query":null,"needs_clarification":true,"clarification_question":"What name should I save your birthday under?"}
"My name is Anik" → {"intent":"set_name","event_type":"birthday","name":"Anik","day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}
"I'm Ravi" → {"intent":"set_name","event_type":"birthday","name":"Ravi","day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}
"Call me Priya" → {"intent":"set_name","event_type":"birthday","name":"Priya","day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}
"1st of March birthday of Rajan" → {"intent":"save","event_type":"birthday","name":"Rajan","day":1,"month":"Mar","query":null,"needs_clarification":false,"clarification_question":null}
"birthday of Aakriti on 28th Feb" → {"intent":"save","event_type":"birthday","name":"Aakriti","day":28,"month":"Feb","query":null,"needs_clarification":false,"clarification_question":null}
"28th Feb birthday of Aakriti nd Aparanta" → {"intent":"save","event_type":"birthday","name":"Aakriti and Aparanta","day":28,"month":"Feb","query":null,"needs_clarification":false,"clarification_question":null}
"Anniversary of Rohit nd Shaanu" → {"intent":"save","event_type":"anniversary","name":"Rohit and Shaanu","day":null,"month":null,"query":null,"needs_clarification":true,"clarification_question":"When is Rohit and Shaanu's anniversary?"}
"bday of Neha 5 April" → {"intent":"save","event_type":"birthday","name":"Neha","day":5,"month":"Apr","query":null,"needs_clarification":false,"clarification_question":null}
"Mama ka bday" → {"intent":"save","event_type":"birthday","name":"Mama","day":null,"month":null,"query":null,"needs_clarification":true,"clarification_question":"When is Mama's birthday?"}
"save anniversary Ritu nd Mohan 15 June" → {"intent":"save","event_type":"anniversary","name":"Ritu and Mohan","day":15,"month":"Jun","query":null,"needs_clarification":false,"clarification_question":null}
"when is sankalp's birthday?" → {"intent":"search","event_type":"birthday","name":null,"day":null,"month":null,"query":"Sankalp","needs_clarification":false,"clarification_question":null}
"when is papa's bday?" → {"intent":"search","event_type":"birthday","name":null,"day":null,"month":null,"query":"Papa","needs_clarification":false,"clarification_question":null}
"do you have Rohit's anniversary?" → {"intent":"search","event_type":"anniversary","name":null,"day":null,"month":null,"query":"Rohit","needs_clarification":false,"clarification_question":null}
"what is my birthday?" → {"intent":"search","event_type":"birthday","name":null,"day":null,"month":null,"query":null,"needs_clarification":true,"clarification_question":"What name is your birthday saved under?"}
"when is my anniversary?" → {"intent":"search","event_type":"anniversary","name":null,"day":null,"month":null,"query":null,"needs_clarification":true,"clarification_question":"What name is your anniversary saved under?"}

MESSY INPUT EXAMPLES (interpret confidently, no clarification needed):
"KAMAL BDAY 5 AUG!!!" → {"intent":"save","event_type":"birthday","name":"Kamal","day":5,"month":"Aug","query":null,"needs_clarification":false,"clarification_question":null}
"Kamal 5 Aug 1990" → {"intent":"save","event_type":"birthday","name":"Kamal","day":5,"month":"Aug","query":null,"needs_clarification":false,"clarification_question":null}
"Priya 12/4" → {"intent":"save","event_type":"birthday","name":"Priya","day":12,"month":"Apr","query":null,"needs_clarification":false,"clarification_question":null}
"pls can u save neha ka bday 5th april thanks" → {"intent":"save","event_type":"birthday","name":"Neha","day":5,"month":"Apr","query":null,"needs_clarification":false,"clarification_question":null}
"fifth of august is rakesh birthday 🎂" → {"intent":"save","event_type":"birthday","name":"Rakesh","day":5,"month":"Aug","query":null,"needs_clarification":false,"clarification_question":null}

MESSY INPUT EXAMPLES (clarification genuinely needed):
"Ramesh 30 Feb" → {"intent":"save","event_type":"birthday","name":"Ramesh","day":null,"month":null,"query":null,"needs_clarification":true,"clarification_question":"February has only 29 days at most — when is Ramesh's birthday?"}
"delete everyone" → {"intent":"delete","event_type":"birthday","name":null,"day":null,"month":null,"query":null,"needs_clarification":true,"clarification_question":"Whose birthday should I delete?"}
"🎂🎂🎂" → {"intent":"unknown","event_type":"birthday","name":null,"day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}

EXAMPLES WITH CONVERSATION CONTEXT:

Recent conversation:
User: 10th August - Shivans birthday
Bot: I've saved Shivans's birthday on Aug 10. 🎂
Current message: "Shivani I mean"
→ {"actions":[{"intent":"rename","event_type":"birthday","name":"Shivans","new_name":"Shivani","day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}]}

Recent conversation:
User: Kamal 5 Aug
Bot: I've saved Kamal's birthday on Aug 5. 🎂
Current message: "Edit:
Kamal is 6 Aug
Remove Kamal 5 Aug"
→ {"actions":[{"intent":"update","event_type":"birthday","name":"Kamal","new_name":null,"day":6,"month":"Aug","query":null,"needs_clarification":false,"clarification_question":null}]}
(fixing a wrong date is ONE update action — do NOT also delete the person)

Recent conversation:
User: when is Meera's birthday?
Bot: Meera's birthday is on Mar 4.
Current message: "change it to Mar 5"
→ {"actions":[{"intent":"update","event_type":"birthday","name":"Meera","new_name":null,"day":5,"month":"Mar","query":null,"needs_clarification":false,"clarification_question":null}]}

Recent conversation:
User: Papa Dec 14
Bot: I've saved Papa's birthday on Dec 14. 🎂
Current message: "no it's the 15th"
→ {"actions":[{"intent":"update","event_type":"birthday","name":"Papa","new_name":null,"day":15,"month":"Dec","query":null,"needs_clarification":false,"clarification_question":null}]}

MULTI-ACTION EXAMPLE (no context needed):
"Save Riya 3 May and delete Arjun"
→ {"actions":[{"intent":"save","event_type":"birthday","name":"Riya","new_name":null,"day":3,"month":"May","query":null,"needs_clarification":false,"clarification_question":null},{"intent":"delete","event_type":"birthday","name":"Arjun","new_name":null,"day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}]}`.trim(),
        },
        {
          role: 'user',
          content: buildParseUserContent(message, history),
        },
      ],
    });

    const content = response.choices[0].message.content.trim();
    const parsed = JSON.parse(content);

    // Accept both the new {"actions":[...]} format and a legacy single object.
    const rawActions = Array.isArray(parsed.actions) && parsed.actions.length > 0
      ? parsed.actions
      : [parsed];
    const actions = rawActions.slice(0, 8).map(normalizeLLMAction);

    const result = { ...actions[0], actions };
    console.log('🤖 LLM parsed intent:', JSON.stringify(actions));
    return result;
  } catch (err) {
    console.error('❌ LLM parse failed:', err.message);
    // Return safe default on parse failure
    return EMPTY_PARSE_RESULT();
  }
}

// Build the user-role content for intent parsing: today's date (so relative
// dates like "tomorrow" resolve), an optional short transcript of the recent
// conversation, and the current message.
function buildParseUserContent(message, history) {
  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'Asia/Kolkata'
  });
  let content = `Today's date: ${today}\n\n`;
  if (history.length > 0) {
    const transcript = history
      .map(m => {
        const speaker = m.direction === 'incoming' ? 'User' : 'Bot';
        const body = String(m.message_body || '').slice(0, 300);
        return `${speaker}: ${body}`;
      })
      .join('\n');
    content += `Recent conversation (oldest first):\n${transcript}\n\n`;
  }
  content += `Current user message: "${message}"`;
  return content;
}

/**
 * Use LLM to find matching names from a birthday list given a search query.
 * Returns an array of matching name strings (exact as stored), or empty array.
 */
async function searchNameWithLLM(query, nameList) {
  if (!query || !nameList || nameList.length === 0) return [];

  try {
    const response = await client.chat.completions.create({
      model: OPENAI_MODEL,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are a name-matching assistant. Given a search query and a list of names, return ONLY the names that genuinely match the query.

A name matches if:
- It is the same name (case-insensitive), e.g. "karan" matches "Karan Bhandari"
- The query is a clear nickname, abbreviation, or commonly known short form of the name, e.g. "mike" matches "Michael"
- The query has a minor typo but clearly refers to the same person, e.g. "kran" matches "Karan"

A name does NOT match if:
- It merely shares a few letters or sounds vaguely similar, e.g. "karan" does NOT match "Naman", "Varun", or "Narain"
- Only a substring happens to overlap by coincidence

Be strict. When in doubt, do NOT include the name.

Respond in JSON: { "matches": ["Name1", "Name2"] }
Return an empty array if nothing matches: { "matches": [] }
The returned names must be EXACTLY as they appear in the provided list (preserve original casing and spelling).`,
        },
        {
          role: 'user',
          content: `Search query: "${query}"\n\nNames list:\n${nameList.join('\n')}`,
        },
      ],
    });

    const content = response.choices[0].message.content.trim();
    const parsed = JSON.parse(content);
    const matches = parsed.matches || [];

    // Validate that returned names actually exist in the original list
    const nameSet = new Set(nameList.map(n => n.toLowerCase()));
    return matches.filter(m => nameSet.has(m.toLowerCase()));
  } catch (err) {
    console.error('❌ LLM name search failed:', err.message);
    return [];
  }
}

async function generateDailyMetricsSummary(snapshot) {
  console.log("🤖 OpenAI daily metrics summary called");

  const response = await client.chat.completions.create({
    model: OPENAI_MODEL,
    reasoning_effort: "low",
    messages: [
      {
        role: "system",
        content: `
You are an analyst for a WhatsApp birthday & anniversary reminder bot.

You will receive a JSON snapshot of the bot's metrics. Each metric has
"last24h" (the last 24 hours) and "previous24h" (the 24 hours before that).

Write a short daily summary (4-6 bullet points) of how the metrics moved in
the last 24 hours compared to the previous day.

Rules:
- Lead with the most significant change (biggest movement or anything concerning).
- Flag anything worrying: message failure spikes, drops in active users, high unknown-intent rates.
- Mention positives too: new users, events added, reminders delivered.
- Use concrete numbers from the snapshot. Never invent numbers.
- If both periods are zero for a metric, don't mention it.
- If overall activity is very low, just note it was a quiet day and give the totals.
- Format the output as a plain-text bullet list. Start each bullet on its own
  line with "- " (a hyphen and a space). One concise sentence per bullet.
- No headings, no bold/markdown emphasis, no numbering. Just the "- " bullets.
`.trim(),
      },
      {
        role: "user",
        content: JSON.stringify(snapshot),
      },
    ],
  });

  return response.choices[0].message.content.trim();
}

module.exports = { rewriteForElderlyUser, generateScopedBirthdayBotReply, parseIntentWithLLM, searchNameWithLLM, generateDailyMetricsSummary };
