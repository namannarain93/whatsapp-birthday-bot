const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
- save birthdays
- update birthdays
- delete birthdays
- list birthdays
- search birthdays

You must NOT answer any questions outside of birthdays.
If the user asks anything unrelated, respond with intent = unknown.

Always respond in strict JSON.
Never include explanations.
Never include text outside JSON.

If the user's message is ambiguous, set:
needs_clarification = true
and provide a short clarification_question.

If the user provides a name that contains numbers, treat the full string as the name.
Do NOT assume numbers are dates unless clearly associated with a month or date word.

Supported intents:
- save
- update
- delete
- list_all
- list_month
- search
- help
- unknown

OUTPUT FORMAT (always return this exact structure):
{
  "intent": "save | update | delete | list_all | list_month | search | help | unknown",
  "name": "string or null",
  "day": number or null,
  "month": "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec or null",
  "query": "string or null (for search intent)",
  "needs_clarification": boolean,
  "clarification_question": "string or null"
}

EXAMPLES:
"Papa Dec 14th" → {"intent":"save","name":"Papa","day":14,"month":"Dec","query":null,"needs_clarification":false,"clarification_question":null}
"Naman HBS'24 aug 29" → {"intent":"save","name":"Naman HBS'24","day":29,"month":"Aug","query":null,"needs_clarification":false,"clarification_question":null}
"apa on 14th Dec" → {"intent":"save","name":"apa","day":14,"month":"Dec","query":null,"needs_clarification":false,"clarification_question":null}
"delete papa" → {"intent":"delete","name":"Papa","day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}
"change name of save varun to varun" → {"intent":"update","name":"varun","day":null,"month":null,"query":null,"needs_clarification":true,"clarification_question":"What date should I update Varun's birthday to?"}
"change papa to dec 15" → {"intent":"update","name":"Papa","day":15,"month":"Dec","query":null,"needs_clarification":false,"clarification_question":null}
"complete list" → {"intent":"list_all","name":null,"day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}
"birthdays this month" → {"intent":"list_month","name":null,"day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}
"find anu" → {"intent":"search","name":null,"day":null,"month":null,"query":"anu","needs_clarification":false,"clarification_question":null}
"search momm" → {"intent":"search","name":null,"day":null,"month":null,"query":"momm","needs_clarification":false,"clarification_question":null}
"help" → {"intent":"help","name":null,"day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}
"hi" → {"intent":"unknown","name":null,"day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}
"what is the capital of france" → {"intent":"unknown","name":null,"day":null,"month":null,"query":null,"needs_clarification":false,"clarification_question":null}`.trim(),
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
      name: parsed.name || null,
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

module.exports = { rewriteForElderlyUser, parseIntentWithLLM };
