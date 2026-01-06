require('dotenv').config();
const express = require('express'); 
const { rewriteForElderlyUser, parseIntentWithLLM } = require('./llm.js');
const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));
const app = express();
const {
  saveBirthday,
  birthdayExists,
  getBirthdaysForMonth,
  getAllBirthdays,
  deleteBirthday,
  updateBirthday,
  updateBirthdayName,
  isFirstTimeUser
} = require('./db.js');

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

// Deterministic month order map using full month names (lowercase)
const MONTH_ORDER = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12
};

// Map various month spellings (short/full, any case) to canonical lowercase full name
const MONTH_CANONICAL = {
  jan: 'january',
  january: 'january',
  feb: 'february',
  february: 'february',
  mar: 'march',
  march: 'march',
  apr: 'april',
  april: 'april',
  may: 'may',
  jun: 'june',
  june: 'june',
  jul: 'july',
  july: 'july',
  aug: 'august',
  august: 'august',
  sep: 'september',
  sept: 'september',
  september: 'september',
  oct: 'october',
  october: 'october',
  nov: 'november',
  november: 'november',
  dec: 'december',
  december: 'december'
};

function normalizeMonthToCanonical(monthStr) {
  const key = (monthStr || '').toString().trim().toLowerCase();
  return MONTH_CANONICAL[key] || key;
}

function getMonthOrderNumber(canonicalMonth) {
  return MONTH_ORDER[canonicalMonth] || 99;
}

function toDisplayMonthName(canonicalMonth) {
  if (!canonicalMonth) return '';
  return canonicalMonth.charAt(0).toUpperCase() + canonicalMonth.slice(1);
}

// Map canonical month (lowercase full) to short display form, e.g. "january" -> "Jan"
const CANONICAL_TO_SHORT = {
  january: 'Jan',
  february: 'Feb',
  march: 'Mar',
  april: 'Apr',
  may: 'May',
  june: 'Jun',
  july: 'Jul',
  august: 'Aug',
  september: 'Sep',
  october: 'Oct',
  november: 'Nov',
  december: 'Dec'
};

// Normalize any month token (word or number) to a short month like "Jan"
function normalizeMonthToShort(token) {
  if (token == null) return null;
  const raw = token.toString().trim().toLowerCase();
  if (!raw) return null;

  // Numeric month, e.g. "1", "01", "12"
  if (/^\d{1,2}$/.test(raw)) {
    const num = parseInt(raw, 10);
    const canonical = Object.keys(MONTH_ORDER).find(
      key => MONTH_ORDER[key] === num
    );
    return canonical ? CANONICAL_TO_SHORT[canonical] : null;
  }

  // Word month (short or full)
  const canonical = MONTH_CANONICAL[raw];
  if (!canonical) return null;
  return CANONICAL_TO_SHORT[canonical] || null;
}

// Parse flexible "name + date" messages into { name, day, month }
function parseNameAndDate(message) {
  if (!message || !message.trim()) return null;

  const original = message;
  const lower = message.toLowerCase();

  let day = null;
  let monthShort = null;
  let working = original;

  // 1) Look for numeric date formats like "14/12" or "14-12"
  const numericMatch = lower.match(/\b(\d{1,2})[\/-](\d{1,2})\b/);
  if (numericMatch) {
    const d = parseInt(numericMatch[1], 10);
    const m = parseInt(numericMatch[2], 10);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      day = d;
      monthShort = normalizeMonthToShort(m.toString());
      if (!monthShort) return null;
      const re = new RegExp(numericMatch[0], 'i');
      working = working.replace(re, ' ');
    }
  }

  // 2) Look for month words like "Dec", "December" if month not yet found
  if (!monthShort) {
    const monthWordRegex =
      /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
    const monthWordMatch = lower.match(monthWordRegex);
    if (monthWordMatch) {
      monthShort = normalizeMonthToShort(monthWordMatch[1]);
      if (!monthShort) return null;
      const re = new RegExp(monthWordMatch[0], 'i');
      working = working.replace(re, ' ');
    }
  }

  // 3) Look for a standalone day like "14", "14th", "1st" if day not yet found
  if (day == null) {
    const dayRegex = /\b(\d{1,2})(st|nd|rd|th)?\b/;
    const dayMatch = lower.match(dayRegex);
    if (dayMatch) {
      const d = parseInt(dayMatch[1], 10);
      if (d >= 1 && d <= 31) {
        day = d;
        const re = new RegExp(dayMatch[0], 'i');
        working = working.replace(re, ' ');
      }
    }
  }

  if (day == null || !monthShort) {
    return null;
  }

  // Whatever remains (minus commas and extra spaces) is treated as the name
  const name = working.replace(/[,]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) return null;

  return { name, day, month: monthShort };
}

// Format birthdays list in chronological calendar order
function formatBirthdaysChronologically(birthdays) {
  if (!birthdays || birthdays.length === 0) {
    return '';
  }

  // First normalize each birthday's month to canonical form
  const normalized = birthdays.map(b => ({
    name: b.name,
    day: b.day,
    monthCanonical: normalizeMonthToCanonical(b.month)
  }));

  // Sort by month index then by day
  normalized.sort((a, b) => {
    const orderA = getMonthOrderNumber(a.monthCanonical);
    const orderB = getMonthOrderNumber(b.monthCanonical);
    if (orderA !== orderB) return orderA - orderB;
    return a.day - b.day;
  });

  // Group by canonical month
  const grouped = {};
  normalized.forEach(b => {
    const key = b.monthCanonical;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(b);
  });

  // Get months in true calendar order
  const orderedMonths = Object.keys(grouped).sort(
    (a, b) => getMonthOrderNumber(a) - getMonthOrderNumber(b)
  );

  // Build the final string
  let result = '🎂 BIRTHDAYS 🎂\n\n';
  orderedMonths.forEach(monthKey => {
    const label = toDisplayMonthName(monthKey);
    if (!label) return;
    result += `${label}\n`;
    grouped[monthKey].forEach(b => {
      result += `• ${b.day} – ${b.name}\n`;
    });
    result += '\n';
  });

  return result.trim();
}

const WELCOME_MESSAGE =
  "Hi! 👋 Welcome to the Birthday Bot 🎂\n" +
  "This is the easiest way to save birthdays so you never forget 😊\n\n" +
  "To save a birthday, just type:\n" +
  "Name, Date\n\n" +
  "Example:\n" +
  "Papa, 29 Aug\n" +
  "Tanni, 9 Feb\n\n" +
  "To see all birthdays, type:\n" +
  "Complete list\n\n" +
  "That’s it 👍\n" +
  "Just send messages like normal WhatsApp. No buttons, no forms.";

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

    // Helper function to process a single line for saving
    async function processSaveLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return { success: false, reason: 'empty' };

      // Try flexible date parsing first
      const parsedSave = parseNameAndDate(trimmed);
      if (parsedSave) {
        const { name, day, month } = parsedSave;
        const exists = await birthdayExists(phone, name.trim(), day, month);
        if (exists) {
          return { success: false, reason: 'duplicate', name, day, month };
        }
        await saveBirthday(phone, name.trim(), day, month);
        return { success: true, name, day, month };
      }

      // Try legacy regex pattern ("Name Month Day")
      const saveMatch = trimmed.match(/^(.+?)\s+([A-Za-z]+)\s+(\d+)$/);
      if (saveMatch) {
        const [, name, month, day] = saveMatch;
        const d = parseInt(day, 10);
        const exists = await birthdayExists(phone, name.trim(), d, month);
        if (exists) {
          return { success: false, reason: 'duplicate', name, day: d, month };
        }
        await saveBirthday(phone, name.trim(), d, month);
        return { success: true, name, day: d, month };
      }

      return { success: false, reason: 'parse_failed', line: trimmed };
    }

    // Multi-line birthday processing
    const lines = message
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);

    if (lines.length > 1) {
      const saved = [];
      const skipped = [];

      for (const line of lines) {
        const result = await processSaveLine(line);
        if (result.success) {
          saved.push(result);
        } else if (result.reason === 'duplicate') {
          skipped.push({ line: result.name, reason: 'duplicate', day: result.day, month: result.month });
        } else {
          skipped.push({ line: result.line || line, reason: 'parse_failed' });
        }
      }

      // Build summary message
      let summary = '';
      if (saved.length > 0) {
        summary += "I've saved:\n";
        saved.forEach(s => {
          summary += `• ${s.name} – ${s.month} ${s.day}\n`;
        });
        if (saved.length === lines.length) {
          summary += '🎂';
        }
      }

      if (skipped.length > 0) {
        if (summary) summary += '\n';
        summary += "I couldn't understand:\n";
        skipped.forEach(s => {
          if (s.reason === 'duplicate') {
            summary += `• ${s.line} – already saved on ${s.month} ${s.day}\n`;
          } else {
            summary += `• ${s.line}\n`;
          }
        });
      }

      if (summary) {
        const reply = await safeRewrite(summary.trim());
        await sendWhatsAppMessage(phone, reply);
      }
      return res.sendStatus(200);
    }

    // 0️⃣ Explicit help keyword (always available)
    if (lowerMessage.includes('help')) {
      const reply = await safeRewrite(WELCOME_MESSAGE);
      await sendWhatsAppMessage(phone, reply);
      return res.sendStatus(200);
    }

    // 0️⃣ First-time user welcome flow
    const firstTime = await isFirstTimeUser(phone);
    if (firstTime) {
      const reply = await safeRewrite(WELCOME_MESSAGE);
      await sendWhatsAppMessage(phone, reply);
      return res.sendStatus(200);
    }

    // LLM Intent Parsing (before regex fallback)
    const parsed = await parseIntentWithLLM(message);

    // Handle LLM-parsed intents
    if (parsed.intent === 'save') {
      // Prefer deterministic parser; fall back to LLM fields if needed
      const parsedDate = parseNameAndDate(message);
      let name;
      let day;
      let month;

      if (parsedDate) {
        name = parsedDate.name.trim();
        day = parsedDate.day;
        month = parsedDate.month;
      } else {
        name = (parsed.name || '').trim();
        day = parseInt(parsed.day, 10);
        month = parsed.month;
      }

      if (!name || !day || !month) {
        // If we still don't have a valid triplet, fall through to regex logic
      } else {
        const exists = await birthdayExists(phone, name, day, month);
        if (exists) {
          const reply = await safeRewrite(
            `I already have ${name}'s birthday saved on ${month} ${day}.`
          );
          await sendWhatsAppMessage(phone, reply);
          return res.sendStatus(200);
        }

        await saveBirthday(phone, name, day, month);
        const reply = await safeRewrite(`I've saved ${name}'s birthday on ${month} ${day}. 🎂`);
        await sendWhatsAppMessage(phone, reply);
        return res.sendStatus(200);
      }
    }

    if (parsed.intent === 'delete') {
      const name = parsed.name.trim();
      await deleteBirthday(phone, name);
      const reply = await safeRewrite(`I've removed ${name}'s birthday.`);
      await sendWhatsAppMessage(phone, reply);
      return res.sendStatus(200);
    }

    if (parsed.intent === 'update') {
      const name = parsed.name.trim();
      const day = parseInt(parsed.day);
      const month = parsed.month;
      await updateBirthday(phone, name, day, month);
      const reply = await safeRewrite(`I've updated ${name}'s birthday to ${month} ${day}.`);
      await sendWhatsAppMessage(phone, reply);
      return res.sendStatus(200);
    }

    if (parsed.intent === 'list_all') {
      const birthdays = await getAllBirthdays(phone);

      if (birthdays.length === 0) {
        const reply = await safeRewrite('I have not saved any birthdays yet.');
        await sendWhatsAppMessage(phone, reply);
        return res.sendStatus(200);
      }

      const formatted = formatBirthdaysChronologically(birthdays);
      const reply = await safeRewrite(formatted);
      await sendWhatsAppMessage(phone, reply);
      return res.sendStatus(200);
    }

    if (parsed.intent === 'list_month') {
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

    // If intent is "unknown", fall through to existing regex logic below

    // 1️⃣ All birthdays (regex fallback)
    if (
      lowerMessage.includes('all birthdays') ||
      lowerMessage.includes('complete list') ||
      lowerMessage.includes('everything saved')
    ) {
      const birthdays = await getAllBirthdays(phone);

      if (birthdays.length === 0) {
        const reply = await safeRewrite('I have not saved any birthdays yet.');
        await sendWhatsAppMessage(phone, reply);
        return res.sendStatus(200);
      }

      const formatted = formatBirthdaysChronologically(birthdays);
      const reply = await safeRewrite(formatted);
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

    // 5️⃣ Save (with flexible date parsing)
    const parsedSave = parseNameAndDate(message);
    if (parsedSave) {
      const { name, day, month } = parsedSave;
      const exists = await birthdayExists(phone, name.trim(), day, month);

      if (exists) {
        const reply = await safeRewrite(
          `I already have ${name}'s birthday saved on ${month} ${day}.`
        );
        await sendWhatsAppMessage(phone, reply);
        return res.sendStatus(200);
      }

      await saveBirthday(phone, name.trim(), day, month);
      const reply = await safeRewrite(`I've saved ${name}'s birthday on ${month} ${day}. 🎂`);
      await sendWhatsAppMessage(phone, reply);
      return res.sendStatus(200);
    }

    // Legacy save pattern fallback ("Name Month Day")
    const saveMatch = message.match(/^(.+?)\s+([A-Za-z]+)\s+(\d+)$/);
    if (saveMatch) {
      const [, name, month, day] = saveMatch;
      const d = parseInt(day, 10);
      const exists = await birthdayExists(phone, name.trim(), d, month);

      if (exists) {
        const reply = await safeRewrite(
          `I already have ${name}'s birthday saved on ${month} ${d}.`
        );
        await sendWhatsAppMessage(phone, reply);
        return res.sendStatus(200);
      }

      await saveBirthday(phone, name.trim(), d, month);
      const reply = await safeRewrite(`I've saved ${name}'s birthday on ${month} ${d}. 🎂`);
      await sendWhatsAppMessage(phone, reply);
      return res.sendStatus(200);
    }

    // 6️⃣ Fallback
    const help = await safeRewrite(
      'You can tell me a birthday like this: Tanni Feb 9 🎂\nIn case you are stuck, just type: help'
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
