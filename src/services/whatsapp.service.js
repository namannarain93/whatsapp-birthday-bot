// WhatsApp messaging service

const { rewriteForElderlyUser } = require('../../llm.js');
const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

async function safeRewrite(text) {
  try {
    return await rewriteForElderlyUser(text);
  } catch (err) {
    console.error('LLM failed, falling back to original text:', err.message);
    return text; // fallback, never block grandma
  }
}

async function sendWhatsAppMessage(to, body) {
  const url = `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`;

  await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body }
    })
  });
}

module.exports = {
  safeRewrite,
  sendWhatsAppMessage
};

