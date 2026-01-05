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

module.exports = { rewriteForElderlyUser };
