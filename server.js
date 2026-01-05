require('dotenv').config();
const express = require('express'); 
const { rewriteForElderlyUser } = require('./llm.js');
const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));
const app = express();
const { saveBirthday, getBirthdaysForMonth, getAllBirthdays, birthdayExists, deleteBirthday, updateBirthday } = require('./db.js');

app.use((req, res, next) => {
  console.log('⚡ INCOMING REQUEST:', req.method, req.path);
  next();
});

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
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messageObj = value?.messages?.[0];

    if (!messageObj) return res.sendStatus(200);

    const phone = messageObj.from;
    const message = messageObj.text?.body || '';
    const lowerMessage = message.toLowerCase();

    console.log('📞 FROM:', phone);
    console.log('💬 MESSAGE:', message);

    // 1️⃣ All birthdays
    if (
      lowerMessage.includes('all birthdays') ||
      lowerMessage.includes('complete list') ||
      lowerMessage.includes('everything saved')
    ) {
      const birthdays = await getAllBirthdays(phone);

      let reply =
        birthdays.length === 0
          ? 'I have not saved any birthdays yet.'
          : 'Here is the complete list of birthdays:\n\n' +
            birthdays.map(b => `• ${b.name} - ${b.month} ${b.day}`).join('\n');

      reply = await safeRewrite(reply);
      await sendWhatsAppMessage(phone, reply);
      return res.sendStatus(200);
    }

    // 2️⃣ Birthdays this month
    if (lowerMessage.includes('this month')) {
      const month = getCurrentMonthAbbrev();
      const monthName = getCurrentMonthName();
      const birthdays = await getBirthdaysForMonth(phone, month);

      let reply =
        birthdays.length === 0
          ? `I don't have any birthdays saved for ${monthName}.`
          : `Here are the birthdays in ${monthName}:\n\n` +
            birthdays.map(b => `• ${b.name} - ${b.month} ${b.day}`).join('\n');

      reply = await safeRewrite(reply);
      await sendWhatsAppMessage(phone, reply);
      return res.sendStatus(200);
    }

    // 3️⃣ Delete
    const deleteMatch = lowerMessage.match(/^(?:delete|remove)\s+(.+)$/);
    if (deleteMatch) {
      await deleteBirthday(phone, deleteMatch[1].trim());
      const reply = await safeRewrite(`I've removed ${deleteMatch[1]}'s birthday.`);
      await sendWhatsAppMessage(phone, reply);
      return res.sendStatus(200);
    }

    // 4️⃣ Update
    const updateMatch = lowerMessage.match(
      /^(?:change|update)\s+(.+?)\s+(?:to|birthday to)\s+([a-z]+)\s+(\d+)$/i
    );
    if (updateMatch) {
      const [, name, month, day] = updateMatch;
      await updateBirthday(phone, name.trim(), parseInt(day), month);
      const reply = await safeRewrite(`I've updated ${name}'s birthday to ${month} ${day}.`);
      await sendWhatsAppMessage(phone, reply);
      return res.sendStatus(200);
    }

    // 5️⃣ Save
    const saveMatch = message.match(/^(.+?)\s+([A-Za-z]+)\s+(\d+)$/);
    if (saveMatch) {
      const [, name, month, day] = saveMatch;
      const exists = await birthdayExists(phone, name.trim(), parseInt(day), month);

      if (exists) {
        const reply = await safeRewrite(
          `I already have ${name}'s birthday saved on ${month} ${day}.`
        );
        await sendWhatsAppMessage(phone, reply);
        return res.sendStatus(200);
      }

      await saveBirthday(phone, name.trim(), parseInt(day), month);
      const reply = await safeRewrite(`I've saved ${name}'s birthday on ${month} ${day}. 🎂`);
      await sendWhatsAppMessage(phone, reply);
      return res.sendStatus(200);
    }

    // 6️⃣ Fallback
    const help = await safeRewrite(
      'You can tell me a birthday like this: Tanni Feb 9 🎂'
    );
    await sendWhatsAppMessage(phone, help);
    return res.sendStatus(200);

  } catch (err) {
    console.error('Webhook error:', err);
    return res.sendStatus(200);
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
        type: 'template',
        template: {
        name: 'hello_world',
    language: { code: 'en_US' }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Bot is alive on port', PORT));
