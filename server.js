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
    console.log(req.body);

    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messageObj = value?.messages?.[0];
    
    if (!messageObj) {
      return res.sendStatus(200);
    }
    
    const phone = messageObj.from;              // who sent the message
    const message = messageObj.text?.body || ''; // what they typed
    
    console.log('📞 FROM:', phone);
    console.log('💬 MESSAGE:', message);    

    if (!message) {
      const replyText = await safeRewrite('Hello! I did not understand that message yet.');
      await sendWhatsAppMessage(phone, replyText);
      return res.sendStatus(200);
    }    

    const lowerMessage = message.toLowerCase();
    if (
      lowerMessage.includes('all birthdays') ||
      lowerMessage.includes('complete list') ||
      lowerMessage.includes('all the birthdays') ||
      lowerMessage.includes('everything saved')
    ) {
      getAllBirthdays(phone, async (err, birthdays) => {
        let reply;
    
        if (err) {
          reply = 'Sorry, I had trouble finding the birthdays.';
        } else if (birthdays.length === 0) {
          reply = 'I do not have any birthdays saved yet.';
        } else {
          reply = 'Here is the complete list of birthdays:\n\n';
          birthdays.forEach(b => {
            reply += `• ${b.name} - ${b.month} ${b.day}\n`;
          });
        }
    
        reply = await safeRewrite(reply);
        await sendWhatsAppMessage(phone, reply);
        return res.sendStatus(200);
      });
    
      return;
    }    
    if (lowerMessage.includes('this month') || lowerMessage.includes('birthdays this month')) {
      const currentMonthAbbrev = getCurrentMonthAbbrev();
      const currentMonthFull = getCurrentMonthName();
      
      getBirthdaysForMonth(phone, currentMonthAbbrev, async (err, birthdays) => {
        if (err) {
          const rewritten = await safeRewrite('Sorry, I had trouble looking up the birthdays. Please try again.');
          await sendWhatsAppMessage(phone, rewritten);
          return res.sendStatus(200);          
        }
        
        if (birthdays.length === 0) {
          const originalText = `I don't have any birthdays saved for ${currentMonthFull} yet. You can add one by sending me a name and date! 🎂`;
          const rewritten = await safeRewrite(originalText);
          await sendWhatsAppMessage(phone, rewritten);
          return res.sendStatus(200);
        }
        
        let response = `Here are the birthdays in ${currentMonthFull}:\n\n`;
        birthdays.forEach(birthday => {
          response += `• ${birthday.name} - ${birthday.month} ${birthday.day}\n`;
        });
        response += '\nI\'ll make sure to remind you about these special days! 🎂';
        
        const rewritten = await safeRewrite(response);
        await sendWhatsAppMessage(phone, rewritten);
        return res.sendStatus(200);

      });
      return;
    }

    // Delete intent: "delete tanni", "remove varun"
    const deleteMatch = lowerMessage.match(/^(?:delete|remove)\s+(.+)$/);
    if (deleteMatch) {
      const name = deleteMatch[1].trim();
      deleteBirthday(phone, name, async (err, deleted) => {
        if (err) {
          const replyText = await safeRewrite('Sorry, I had trouble removing that birthday.');
          await sendWhatsAppMessage(phone, replyText);
          return res.sendStatus(200);
        }
        if (deleted) {
          const originalText = `I've removed ${name}'s birthday.`;
          const rewritten = await safeRewrite(originalText);
          await sendWhatsAppMessage(phone, rewritten);
        } else {
          const originalText = `I couldn't find ${name}'s birthday to remove.`;
          const rewritten = await safeRewrite(originalText);
          await sendWhatsAppMessage(phone, rewritten);
        }
        return res.sendStatus(200);
      });
      return;
    }

    // Update intent: "change tanni to feb 10", "update varun birthday to nov 20"
    const updateMatch = lowerMessage.match(/^(?:change|update)\s+(.+?)\s+(?:to|birthday to)\s+([a-z]+)\s+(\d+)$/i);
    if (updateMatch) {
      const name = updateMatch[1].trim();
      const month = updateMatch[2];
      const day = parseInt(updateMatch[3], 10);
      
      updateBirthday(phone, name, day, month, async (err, updated) => {
        if (err) {
          const replyText = await safeRewrite('Sorry, I had trouble updating that birthday.');
          await sendWhatsAppMessage(phone, replyText);
          return res.sendStatus(200);
        }
        if (updated) {
          const originalText = `I've updated ${name}'s birthday to ${month} ${day}.`;
          const rewritten = await safeRewrite(originalText);
          await sendWhatsAppMessage(phone, rewritten);
        } else {
          const originalText = `I couldn't find ${name}'s birthday to update.`;
          const rewritten = await safeRewrite(originalText);
          await sendWhatsAppMessage(phone, rewritten);
        }
        return res.sendStatus(200);
      });
      return;
    }

    // Save intent: "Tanni Feb 9"
    const match = message.match(/^(.+?)\s+([A-Za-z]+)\s+(\d+)$/);

    if (match) {
      const name = match[1].trim();
      const month = match[2];
      const day = parseInt(match[3], 10);

      birthdayExists(phone, name, day, month, async (err, exists) => {
        if (err) {
          const replyText = await safeRewrite('Sorry, I had trouble checking that birthday.');
          await sendWhatsAppMessage(phone, replyText);
          return res.sendStatus(200);
        }
        
        if (exists) {
          const originalText = `I already have ${name}'s birthday saved on ${month} ${day} 😊`;
          const rewritten = await safeRewrite(originalText);
          await sendWhatsAppMessage(phone, rewritten);
          return res.sendStatus(200);
        }

        saveBirthday(phone, name, day, month);

        const originalText = `How wonderful! I've saved ${name}'s birthday on ${month} ${day}. I'll remind you when the time comes 🎂`;
        const rewritten = await safeRewrite(originalText);
        await sendWhatsAppMessage(phone, rewritten);
        return res.sendStatus(200);
      });
      return;
    }

    const originalText = `Hello there! You can tell me a birthday like this:\nTanni Feb 9 🎂`;
    const rewritten = await safeRewrite(originalText);
    await sendWhatsAppMessage(phone, rewritten);
    return res.sendStatus(200);

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
