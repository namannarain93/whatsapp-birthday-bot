require('dotenv').config();
const express = require('express');
const { saveBirthday, getBirthdaysForMonth } = require('./db.js');
const { rewriteForElderlyUser } = require('./llm.js');
const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();

async function safeRewrite(text) {
  try {
    return await rewriteForElderlyUser(text);
  } catch (err) {
    console.error('LLM failed, falling back to original text:', err.message);
    return text; // fallback, never block grandma
  }
}

function getCurrentMonthName() {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                  'July', 'August', 'September', 'October', 'November', 'December'];
  const now = new Date();
  return months[now.getMonth()];
}

function getCurrentMonthAbbrev() {
  const abbrevs = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const now = new Date();
  return abbrevs[now.getMonth()];
}

app.use(express.json());

app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = 'birthday_reminder_verify';

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
});


app.post('/webhook', async (req, res) => {
  try {
    console.log(req.body);

    const phone = req.body.from || '';
    const message = req.body.text?.body || '';

    if (!message) {
      const rewritten = await safeRewrite('Hello! I did not understand that message yet 😊');
      return res.send(rewritten);
    }

    const lowerMessage = message.toLowerCase();
    if (lowerMessage.includes('this month') || lowerMessage.includes('birthdays this month')) {
      const currentMonthAbbrev = getCurrentMonthAbbrev();
      const currentMonthFull = getCurrentMonthName();
      
      getBirthdaysForMonth(currentMonthAbbrev, async (err, birthdays) => {
        if (err) {
          const rewritten = await safeRewrite('Sorry, I had trouble looking up the birthdays. Please try again.');
          return res.send(rewritten);
        }
        
        if (birthdays.length === 0) {
          const originalText = `I don't have any birthdays saved for ${currentMonthFull} yet. You can add one by sending me a name and date! 🎂`;
          const rewritten = await safeRewrite(originalText);
          return res.send(rewritten);
        }
        
        let response = `Here are the birthdays in ${currentMonthFull}:\n\n`;
        birthdays.forEach(birthday => {
          response += `• ${birthday.name} - ${birthday.month} ${birthday.day}\n`;
        });
        response += '\nI\'ll make sure to remind you about these special days! 🎂';
        
        const rewritten = await safeRewrite(response);
        return res.send(rewritten);
      });
      return;
    }

    const match = message.match(/^(.+?)\s+([A-Za-z]+)\s+(\d+)$/);

    if (match) {
      const name = match[1].trim();
      const month = match[2];
      const day = parseInt(match[3], 10);

      saveBirthday(phone, name, day, month);

      const originalText = `How wonderful! I've saved ${name}'s birthday on ${month} ${day}. I'll remind you when the time comes 🎂`;
      const rewritten = await safeRewrite(originalText);
      return res.send(rewritten);
    }

    const originalText = `Hello there! You can tell me a birthday like this:\nTanni Feb 9 🎂`;
    const rewritten = await safeRewrite(originalText);
    return res.send(rewritten);

  } catch (err) {
    console.error('Error processing webhook:', err);
    res.status(500).send('Sorry, something went wrong. Please try again.');
  }
});
app.get('/send-test', async (req, res) => {
  try {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneNumberId = process.env.PHONE_NUMBER_ID;
    const to = req.query.to; // e.g. 919819961371

    if (!token || !phoneNumberId || !to) {
      return res.status(400).json({
        error: 'Missing WHATSAPP_TOKEN, PHONE_NUMBER_ID, or ?to='
      });
    }

    const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: {
          body: '👋 Hello! This is a test message sent directly from my server.'
        }
      })
    });

    const data = await response.json();
    console.log('SEND TEST RESPONSE:', data);

    res.json(data);
  } catch (err) {
    console.error('SEND TEST ERROR:', err);
    res.status(500).send('Failed to send test message');
  }
});

app.listen(3000, () => console.log('Bot is alive'));
