// Birthday business logic service - orchestrates all birthday operations

const {
  saveBirthday,
  birthdayExists,
  birthdayExistsByName,
  getBirthdaysForMonth,
  getAllBirthdays,
  getBirthdayByName,
  getBirthdaysByDate,
  getUpcomingBirthdays,
  deleteBirthday,
  updateBirthday,
  markWelcomeSeen
} = require('../../db.js');
const { normalizeMonthToShort } = require('../utils/month.utils');
const { parseNameAndDate } = require('../parsers/date.parser');
const { extractNamesFromDeleteInput } = require('../parsers/date.parser');
const { safeRewrite, sendWhatsAppMessage } = require('./whatsapp.service');
const { findFuzzyMatches } = require('../utils/fuzzyMatch');

// Save a birthday for a user
async function saveBirthdayForUser(phone, name, day, month) {
  const normalizedMonth = normalizeMonthToShort(month);
  if (!normalizedMonth) {
    return { success: false, error: 'Invalid month' };
  }

  const exists = await birthdayExists(phone, name.trim(), day, normalizedMonth);
  if (exists) {
    const reply = await safeRewrite(
      `I already have ${name}'s birthday saved on ${normalizedMonth} ${day}.`
    );
    await sendWhatsAppMessage(phone, reply);
    return { success: false, duplicate: true };
  }

  await saveBirthday(phone, name.trim(), day, normalizedMonth);
  await markWelcomeSeen(phone);
  const reply = await safeRewrite(`I've saved ${name}'s birthday on ${normalizedMonth} ${day}. 🎂`);
  await sendWhatsAppMessage(phone, reply);
  return { success: true };
}

// Save birthday from parsed date (flexible parsing)
async function saveBirthdayFromMessage(phone, message) {
  const parsedSave = parseNameAndDate(message);
  if (!parsedSave) {
    return { success: false };
  }

  const { name, day, month } = parsedSave;
  return await saveBirthdayForUser(phone, name, day, month);
}

// Save birthday from legacy regex pattern
async function saveBirthdayFromLegacyPattern(phone, message) {
  const saveMatch = message.match(/^(.+?)\s+([A-Za-z]+)\s+(\d+)$/);
  if (!saveMatch) {
    return { success: false };
  }

  const [, name, month, day] = saveMatch;
  const d = parseInt(day, 10);
  return await saveBirthdayForUser(phone, name, d, month);
}

// Delete birthday for a user
async function deleteBirthdayForUser(phone, inputName) {
  const namesToTry = extractNamesFromDeleteInput(inputName);
  
  if (namesToTry.length === 0) {
    const reply = await safeRewrite('I could not find this birthday. Please try again.');
    await sendWhatsAppMessage(phone, reply);
    return { success: false };
  }

  const deleted = [];
  const notFound = [];

  for (const name of namesToTry) {
    const wasDeleted = await deleteBirthday(phone, name);
    if (wasDeleted) {
      // Verify deletion succeeded
      const stillExists = await birthdayExistsByName(phone, name);
      if (!stillExists) {
        deleted.push(name);
      } else {
        notFound.push(name);
      }
    } else {
      notFound.push(name);
    }
  }

  if (deleted.length > 0) {
    const replyText = deleted.length === 1
      ? `I've removed ${deleted[0]}'s birthday.`
      : `I've removed ${deleted.length} birthday${deleted.length > 1 ? 's' : ''}: ${deleted.join(', ')}.`;
    const reply = await safeRewrite(replyText);
    await sendWhatsAppMessage(phone, reply);
    return { success: true, deleted };
  } else {
    const reply = await safeRewrite('I could not find this birthday. Please try again.');
    await sendWhatsAppMessage(phone, reply);
    return { success: false };
  }
}

// Update birthday for a user
async function updateBirthdayForUser(phone, name, day, month) {
  const normalizedMonth = normalizeMonthToShort(month);
  if (!normalizedMonth) {
    return { success: false };
  }

  await updateBirthday(phone, name, day, normalizedMonth);
  const reply = await safeRewrite(`I've updated ${name}'s birthday to ${normalizedMonth} ${day}.`);
  await sendWhatsAppMessage(phone, reply);
  return { success: true };
}

// List all birthdays for a user
async function listBirthdaysForUser(phone, formatBirthdaysChronologically) {
  const birthdays = await getAllBirthdays(phone);

  if (birthdays.length === 0) {
    const reply = await safeRewrite('I have not saved any birthdays yet.');
    await sendWhatsAppMessage(phone, reply);
    return;
  }

  // Skip LLM rewrite for formatted lists - they're already properly formatted
  const formatted = formatBirthdaysChronologically(birthdays);
  await sendWhatsAppMessage(phone, formatted);
}

// List birthdays for a specific month
async function listBirthdaysForMonth(phone, month, monthName) {
  const birthdays = await getBirthdaysForMonth(phone, month);

  let reply =
    birthdays.length === 0
      ? `I don't have any birthdays saved for ${monthName}.`
      : `Here are the birthdays in ${monthName}:\n\n` +
        birthdays.map(b => `• ${b.name} - ${b.month} ${b.day}`).join('\n');

  reply = await safeRewrite(reply);
  await sendWhatsAppMessage(phone, reply);
}

// Search birthday by name
async function searchBirthdayByName(phone, searchName) {
  const results = await getBirthdayByName(phone, searchName);
  
  if (results.length === 0) {
    const reply = await safeRewrite(`I don't have ${searchName}'s birthday saved yet.`);
    await sendWhatsAppMessage(phone, reply);
    return;
  }
  
  if (results.length === 1) {
    const b = results[0];
    const reply = await safeRewrite(`${b.name}'s birthday is on ${b.month} ${b.day}.`);
    await sendWhatsAppMessage(phone, reply);
  } else {
    // Multiple matches
    const list = results.map(b => `${b.name} - ${b.month} ${b.day}`).join('\n');
    const reply = await safeRewrite(`I found ${results.length} birthdays matching "${searchName}":\n\n${list}`);
    await sendWhatsAppMessage(phone, reply);
  }
}

// Search birthdays by date
async function searchBirthdaysByDate(phone, day, normalizedMonth) {
  const results = await getBirthdaysByDate(phone, day, normalizedMonth);
  
  if (results.length === 0) {
    const reply = await safeRewrite(`No birthdays on ${normalizedMonth} ${day}.`);
    await sendWhatsAppMessage(phone, reply);
  } else if (results.length === 1) {
    const reply = await safeRewrite(`${results[0].name}'s birthday is on ${normalizedMonth} ${day}.`);
    await sendWhatsAppMessage(phone, reply);
  } else {
    const names = results.map(b => b.name).join(', ');
    const reply = await safeRewrite(`Birthdays on ${normalizedMonth} ${day}: ${names}`);
    await sendWhatsAppMessage(phone, reply);
  }
}

// List upcoming birthdays
async function listUpcomingBirthdaysForUser(phone) {
  const now = new Date();
  const today = now.getDate();
  const currentMonthNum = now.getMonth() + 1;
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const currentMonth = monthNames[currentMonthNum - 1];
  
  // Calculate 30 days from now
  const futureDate = new Date(now);
  futureDate.setDate(futureDate.getDate() + 30);
  const futureDay = futureDate.getDate();
  const futureMonthNum = futureDate.getMonth() + 1;
  const futureMonth = monthNames[futureMonthNum - 1];
  
  const upcoming = await getUpcomingBirthdays(phone, today, currentMonth, futureDay, futureMonth);
  
  if (upcoming.length === 0) {
    const reply = await safeRewrite('No upcoming birthdays in the next 30 days.');
    await sendWhatsAppMessage(phone, reply);
  } else {
    const list = upcoming.map(b => `• ${b.day} ${b.month} – ${b.name}`).join('\n');
    const reply = await safeRewrite(`Here are the upcoming birthdays:\n\n${list}`);
    await sendWhatsAppMessage(phone, reply);
  }
}

// Fuzzy search birthdays by name
async function fuzzySearchBirthdayByName(phone, query) {
  // Get all birthdays for this user
  const allBirthdays = await getAllBirthdays(phone);
  
  if (allBirthdays.length === 0) {
    return { found: false };
  }

  // Find fuzzy matches
  const matches = findFuzzyMatches(query, allBirthdays, 0.6);

  if (matches.length === 0) {
    return { found: false };
  }

  if (matches.length === 1) {
    // Single match - return formatted response
    const b = matches[0];
    const reply = await safeRewrite(`${b.name}'s birthday is on ${b.month} ${b.day}. 🎂`);
    await sendWhatsAppMessage(phone, reply);
    return { found: true, count: 1 };
  } else {
    // Multiple matches - return list
    const list = matches.map(b => `• ${b.name} – ${b.month} ${b.day}`).join('\n');
    const reply = await safeRewrite(`I found these matches:\n\n${list}`);
    await sendWhatsAppMessage(phone, reply);
    return { found: true, count: matches.length };
  }
}

module.exports = {
  saveBirthdayForUser,
  saveBirthdayFromMessage,
  saveBirthdayFromLegacyPattern,
  deleteBirthdayForUser,
  updateBirthdayForUser,
  listBirthdaysForUser,
  listBirthdaysForMonth,
  searchBirthdayByName,
  searchBirthdaysByDate,
  listUpcomingBirthdaysForUser,
  fuzzySearchBirthdayByName
};

