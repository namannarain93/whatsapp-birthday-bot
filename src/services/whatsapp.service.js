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

  try {
    const response = await fetch(url, {
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

    const data = await response.json();

    if (!response.ok || data.error) {
      const error = data.error?.message || data.error?.error_user_msg || `HTTP ${response.status}`;
      console.error(`[WHATSAPP API ERROR] Status ${response.status}:`, error);
      throw new Error(`WhatsApp API error: ${error}`);
    }

    return data;
  } catch (err) {
    console.error('[WHATSAPP] Failed to send text message:', err.message);
    throw err;
  }
}

async function sendTemplateMessage(to, templateName, parametersArray = [], languageCode = 'en') {
  const url = `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`;

  try {
    const components = [];
    if (parametersArray.length > 0) {
      components.push({
        type: 'body',
        parameters: parametersArray.map(text => ({
          type: 'text',
          text: text
        }))
      });
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components
        }
      })
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      const error = data.error?.message || data.error?.error_user_msg || `HTTP ${response.status}`;
      console.error(`[WHATSAPP API ERROR] Template ${templateName} failed:`, error);
      throw new Error(`WhatsApp API error: ${error}`);
    }

    return data;
  } catch (err) {
    console.error(`[WHATSAPP] Failed to send template ${templateName}:`, err.message);
    throw err;
  }
}

module.exports = {
  safeRewrite,
  sendWhatsAppMessage,
  sendTemplateMessage
};

