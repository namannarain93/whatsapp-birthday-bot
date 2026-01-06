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
    return { intent: 'unknown' };
  }

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are an intent classifier and entity extractor for a birthday reminder bot.

Your ONLY job is to extract structured data from user messages and output valid JSON.

OUTPUT FORMATS (choose exactly one):

1. Save birthday: { "intent": "save", "name": "Papa", "day": 14, "month": "Dec" }
2. Delete birthday: { "intent": "delete", "name": "Papa" }
3. Update birthday: { "intent": "update", "name": "Papa", "day": 15, "month": "Dec" }
4. List all birthdays: { "intent": "list_all" }
5. List this month: { "intent": "list_month" }
6. Unknown/unsure: { "intent": "unknown" }

STRICT RULES:
- Output ONLY valid JSON, no prose, no emojis, no explanations
- Month must be abbreviated (Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec)
- Day must be a number (extract from "14th", "14", etc.)
- Name should be the person's name (trimmed, no extra words)
- If you cannot clearly identify intent or extract required fields, return { "intent": "unknown" }
- Never guess or invent data
- For list intents, do not extract name/day/month

EXAMPLES:
"Papa Dec 14th" → { "intent": "save", "name": "Papa", "day": 14, "month": "Dec" }
"save papa 14th dec" → { "intent": "save", "name": "Papa", "day": 14, "month": "Dec" }
"apa on 14th Dec" → { "intent": "save", "name": "apa", "day": 14, "month": "Dec" }
"delete papa" → { "intent": "delete", "name": "Papa" }
"change papa to dec 15" → { "intent": "update", "name": "Papa", "day": 15, "month": "Dec" }
"what are all the birthdays" → { "intent": "list_all" }
"whose birthday is this month" → { "intent": "list_month" }
"hello" → { "intent": "unknown" }`.trim(),
        },
        {
          role: 'user',
          content: message,
        },
      ],
    });

    const content = response.choices[0].message.content.trim();
    const parsed = JSON.parse(content);

    // Validate the parsed result
    if (!parsed.intent) {
      return { intent: 'unknown' };
    }

    // Validate required fields for each intent
    if (parsed.intent === 'save' && (!parsed.name || !parsed.day || !parsed.month)) {
      return { intent: 'unknown' };
    }
    if (parsed.intent === 'delete' && !parsed.name) {
      return { intent: 'unknown' };
    }
    if (parsed.intent === 'update' && (!parsed.name || !parsed.day || !parsed.month)) {
      return { intent: 'unknown' };
    }

    console.log('🤖 LLM parsed intent:', parsed);
    return parsed;
  } catch (err) {
    console.error('❌ LLM parse failed, falling back to regex:', err.message);
    return { intent: 'unknown' };
  }
}

module.exports = { rewriteForElderlyUser, parseIntentWithLLM };
