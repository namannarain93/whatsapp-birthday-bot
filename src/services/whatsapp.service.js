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

    // Parse the response
    const data = await response.json();

    // Check for HTTP errors
    if (!response.ok) {
      const errorMessage = data.error?.message || data.error?.error_user_msg || `HTTP ${response.status}`;
      console.error(`[WHATSAPP API ERROR] Status ${response.status}:`, errorMessage);
      console.error('[WHATSAPP API ERROR] Full response:', JSON.stringify(data, null, 2));
      throw new Error(`WhatsApp API error: ${errorMessage}`);
    }

    // Check for API-level errors in response body (WhatsApp API can return 200 with errors)
    if (data.error) {
      const errorMessage = data.error.message || data.error.error_user_msg || 'Unknown WhatsApp API error';
      console.error('[WHATSAPP API ERROR] Error in response:', errorMessage);
      console.error('[WHATSAPP API ERROR] Full response:', JSON.stringify(data, null, 2));
      throw new Error(`WhatsApp API error: ${errorMessage}`);
    }

    // Success - log message ID if available
    if (data.messages && data.messages[0]?.id) {
      console.log(`[WHATSAPP] Message sent successfully to ${to}, ID: ${data.messages[0].id}`);
    } else {
      console.log(`[WHATSAPP] Message sent successfully to ${to}`);
    }

    return data;
  } catch (err) {
    // Re-throw if it's already our formatted error
    if (err.message && err.message.startsWith('WhatsApp API error:')) {
      throw err;
    }
    // Handle network errors, JSON parse errors, etc.
    console.error('[WHATSAPP] Failed to send message:', err.message);
    throw new Error(`Failed to send WhatsApp message: ${err.message}`);
  }
}

module.exports = {
  safeRewrite,
  sendWhatsAppMessage
};

