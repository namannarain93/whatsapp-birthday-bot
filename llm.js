const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
      model: "gpt-4o-mini",
      temperature: 0.2,
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
      model: "gpt-4o-mini",
      temperature: 0.3,
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

async function parseIntentWithLLM(message) {
  if (!message || !message.trim()) {
    return {
      intent: 'unknown',
      name: null,
      day: null,
      month: null,
      query: null,
      needs_clarification: false,
      clarification_question: null
    };
  }

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.1,
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

### CLARIFICATION RULES (IMPORTANT):
1. If the user's message is ambiguous, set needs_clarification = true and provide a short clarification_question.
2. If the user provides a name/event but NO date, set intent = "save" (or "update"), keep the name and event_type, set day = null, month = null, needs_clarification = true, and ask for the date. Example: "When is Rohit and Shaanu's anniversary?"
3. If the user provides a date but NO name, set needs_clarification = true and ask for the name.
4. If the user mentions MULTIPLE separate people for a birthday in one message (e.g., "birthday of Aakriti and Aparanta"), treat them as sharing the same date, combine them into ONE name field joined by " and " (e.g., "Aakriti and Aparanta"). The system will handle splitting them later.
5. Understand common slang/abbreviations: "nd" = "and", "bday" = "birthday", "anniv" = "anniversary".

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

### SET_NAME RULES:
1. If the user tells you their name (e.g., "My name is Anik", "I'm Anik", "Call me Anik"), set intent = "set_name" and extract the name.
2. Set the "name" field to the user's name (e.g., "Anik").

OUTPUT FORMAT (always return this exact structure):
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

EXAMPLES:
"Papa Dec 14th" → {"intent":"save","event_type":"birthday","name":"Papa","day":14,"month":"Dec","query":null,"needs_clarification":false,"clarification_question":null}
"rename gunnu sankap to Gunnu Sankalp" → {"intent":"rename","event_type":"birthday","name":"gunnu sankap","new_name":"Gunnu Sankalp","day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}
"rename anniversary of Papa to Papa & Mama" → {"intent":"rename","event_type":"anniversary","name":"Papa","new_name":"Papa & Mama","day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}
"Mom and Dad anniversary Oct 12" → {"intent":"save","event_type":"anniversary","name":"Mom and Dad","day":12,"month":"Oct","query":null,"needs_clarification":false,"clarification_question":null}
"Wedding anniv tomorrow" → {"intent":"save","event_type":"anniversary","name":"Wedding","day":30,"month":"Jan","query":null,"needs_clarification":false,"clarification_question":null}
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
"when is my anniversary?" → {"intent":"search","event_type":"anniversary","name":null,"day":null,"month":null,"query":null,"needs_clarification":true,"clarification_question":"What name is your anniversary saved under?"}`.trim(),
        },
        {
          role: 'user',
          content: `User message: "${message}"`,
        },
      ],
    });

    const content = response.choices[0].message.content.trim();
    const parsed = JSON.parse(content);

    // Ensure all required fields exist with defaults
    const result = {
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

    // Normalize month to proper case (Jan, Feb, etc.)
    if (result.month) {
      const monthLower = result.month.toLowerCase();
      const monthMap = {
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
      result.month = monthMap[monthLower] || result.month;
    }

    console.log('🤖 LLM parsed intent:', result);
    return result;
  } catch (err) {
    console.error('❌ LLM parse failed:', err.message);
    // Return safe default on parse failure
    return {
      intent: 'unknown',
      name: null,
      day: null,
      month: null,
      query: null,
      needs_clarification: false,
      clarification_question: null
    };
  }
}

/**
 * Use LLM to find matching names from a birthday list given a search query.
 * Returns an array of matching name strings (exact as stored), or empty array.
 */
async function searchNameWithLLM(query, nameList) {
  if (!query || !nameList || nameList.length === 0) return [];

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
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

module.exports = { rewriteForElderlyUser, generateScopedBirthdayBotReply, parseIntentWithLLM, searchNameWithLLM };
