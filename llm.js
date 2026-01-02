const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function rewriteForElderlyUser(text) {
  if (!text) return text;

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a polite, calm, reassuring assistant chatting with an elderly user on WhatsApp. Use simple English, no technical words, at most one emoji. Never invent facts.",
      },
      {
        role: "user",
        content: text,
      },
    ],
    temperature: 0.3,
  });

  return response.choices[0].message.content.trim();
}

module.exports = { rewriteForElderlyUser };
