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
  updateBirthdayDetails,
  updateBirthdayName,
  markWelcomeSeen
} = require('../../db.js');
const { normalizeMonthToShort } = require('../utils/month.utils');
const { parseNameAndDate } = require('../parsers/date.parser');
const { extractNamesFromDeleteInput } = require('../parsers/date.parser');
const { safeRewrite, sendWhatsAppMessage } = require('./whatsapp.service');
const { searchNameWithLLM } = require('../../llm.js');
const { computeCurrentAge, isBirthdayToday } = require('../utils/age.utils');

// Save a birthday for a user. extras: { year, relationship } (both optional).
async function saveBirthdayForUser(phone, name, day, month, type = 'birthday', extras = {}) {
  const normalizedMonth = normalizeMonthToShort(month);
  if (!normalizedMonth) {
    return { success: false, error: 'Invalid month' };
  }

  const year = extras.year || null;
  const relationship = extras.relationship || null;

  const exists = await birthdayExists(phone, name.trim(), day, normalizedMonth, type);
  if (exists) {
    const eventName = type === 'anniversary' ? 'anniversary' : 'birthday';
    // The re-save may carry details the original entry lacked (year/relationship)
    // — backfill them instead of discarding.
    let replyText = `I already have ${name}'s ${eventName} saved on ${normalizedMonth} ${day}.`;
    if (year || relationship) {
      await updateBirthdayDetails(
        phone,
        name.trim(),
        day,
        normalizedMonth,
        type,
        { year, relationship }
      );
      replyText += ` I've noted the extra details you shared.`;
    }
    const reply = await safeRewrite(replyText);
    await sendWhatsAppMessage(phone, reply);
    return { success: false, duplicate: true };
  }

  await saveBirthday(phone, name.trim(), day, normalizedMonth, type, year, relationship);
  await markWelcomeSeen(phone);
  const emoji = type === 'anniversary' ? '💍' : '🎂';
  const eventName = type === 'anniversary' ? 'anniversary' : 'birthday';
  const relPart = relationship ? ` (${relationship})` : '';
  const yearPart = year ? `, ${year}` : '';
  const reply = await safeRewrite(`I've saved ${name}${relPart}'s ${eventName} on ${normalizedMonth} ${day}${yearPart}. ${emoji}`);
  await sendWhatsAppMessage(phone, reply);
  return { success: true };
}

// Save birthday from parsed date (flexible parsing)
async function saveBirthdayFromMessage(phone, message) {
  const parsedSave = parseNameAndDate(message);
  if (!parsedSave) {
    return { success: false };
  }

  const { name, day, month, year, relationship } = parsedSave;
  return await saveBirthdayForUser(phone, name, day, month, 'birthday', { year, relationship });
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
async function deleteBirthdayForUser(phone, inputName, type = null) {
  const namesToTry = extractNamesFromDeleteInput(inputName);
  
  if (namesToTry.length === 0) {
    const eventName = type === 'anniversary' ? 'anniversary' : 'birthday';
    const reply = await safeRewrite(`I could not find this ${eventName}. Please try again.`);
    await sendWhatsAppMessage(phone, reply);
    return { success: false };
  }

  const deleted = [];
  const notFound = [];

  for (const name of namesToTry) {
    const wasDeleted = await deleteBirthday(phone, name, type);
    if (wasDeleted) {
      // Verify deletion succeeded
      const stillExists = await birthdayExistsByName(phone, name, type);
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
    let replyText;
    const eventName = type === 'anniversary' ? 'anniversary' : 'birthday';
    
    if (deleted.length === 1) {
      replyText = `I've removed ${deleted[0]}'s ${eventName}.`;
    } else {
      replyText = `I've removed ${deleted.length} ${eventName}${deleted.length > 1 ? 's' : ''}: ${deleted.join(', ')}.`;
    }
    
    const reply = await safeRewrite(replyText);
    await sendWhatsAppMessage(phone, reply);
    return { success: true, deleted };
  } else {
    const eventName = type === 'anniversary' ? 'anniversary' : 'birthday';
    const reply = await safeRewrite(`I could not find this ${eventName}. Please try again.`);
    await sendWhatsAppMessage(phone, reply);
    return { success: false };
  }
}

// Update birthday for a user. If nobody by that name exists yet, fall back to
// saving — never claim an update happened when no row was touched.
async function updateBirthdayForUser(phone, name, day, month, type = 'birthday', extras = {}) {
  const normalizedMonth = normalizeMonthToShort(month);
  if (!normalizedMonth) {
    return { success: false };
  }

  const year = extras.year || null;
  const relationship = extras.relationship || null;

  const updated = await updateBirthday(phone, name, day, normalizedMonth, type, year, relationship);
  if (updated) {
    const eventName = type === 'anniversary' ? 'anniversary' : 'birthday';
    const reply = await safeRewrite(`I've updated ${name}'s ${eventName} to ${normalizedMonth} ${day}.`);
    await sendWhatsAppMessage(phone, reply);
    return { success: true };
  }

  return await saveBirthdayForUser(phone, name, day, normalizedMonth, type, { year, relationship });
}

// Rename person for a user
async function renamePersonForUser(phone, oldName, newName, type = 'birthday') {
  const success = await updateBirthdayName(phone, oldName, newName, type);
  const eventName = type === 'anniversary' ? 'anniversary' : 'birthday';
  
  if (success) {
    const reply = await safeRewrite(`I've renamed ${oldName}'s ${eventName} to ${newName}.`);
    await sendWhatsAppMessage(phone, reply);
    return { success: true };
  } else {
    const reply = await safeRewrite(`I could not find ${oldName}'s ${eventName} to rename.`);
    await sendWhatsAppMessage(phone, reply);
    return { success: false };
  }
}

// List all birthdays for a user
async function listBirthdaysForUser(phone, formatBirthdaysChronologically) {
  const birthdays = await getAllBirthdays(phone);

  if (birthdays.length === 0) {
    const reply = await safeRewrite('I have not saved any birthdays or anniversaries yet.');
    await sendWhatsAppMessage(phone, reply);
    return;
  }

  // Format with bold month names, then pass through LLM rewrite
  // LLM will preserve existing bold formatting and make the message warm
  const formatted = formatBirthdaysChronologically(birthdays);
  const reply = await safeRewrite(formatted);
  await sendWhatsAppMessage(phone, reply);
}

// List birthdays for a specific month
async function listBirthdaysForMonth(phone, month, monthName) {
  const birthdays = await getBirthdaysForMonth(phone, month);

  let reply =
    birthdays.length === 0
      ? `I don't have any birthdays or anniversaries saved for ${monthName}.`
      : `Here are the important dates in ${monthName}:\n\n` +
        birthdays.map(b => {
          const typeLabel = b.type === 'anniversary' ? ' (Anniversary)' : '';
          return `• ${b.name} - ${b.month} ${b.day}${typeLabel}`;
        }).join('\n');

  reply = await safeRewrite(reply);
  await sendWhatsAppMessage(phone, reply);
}

// Search birthday by name
async function searchBirthdayByName(phone, searchName) {
  const results = await getBirthdayByName(phone, searchName);
  
  if (results.length === 0) {
    const reply = await safeRewrite(`I don't have ${searchName}'s birthday or anniversary saved yet.`);
    await sendWhatsAppMessage(phone, reply);
    return;
  }
  
  if (results.length === 1) {
    const b = results[0];
    const eventName = b.type === 'anniversary' ? 'anniversary' : 'birthday';
    const reply = await safeRewrite(`${b.name}'s ${eventName} is on ${b.month} ${b.day}.`);
    await sendWhatsAppMessage(phone, reply);
  } else {
    // Multiple matches
    const list = results.map(b => {
      const typeLabel = b.type === 'anniversary' ? ' (Anniversary)' : '';
      return `${b.name} - ${b.month} ${b.day}${typeLabel}`;
    }).join('\n');
    const reply = await safeRewrite(`I found ${results.length} matches for "${searchName}":\n\n${list}`);
    await sendWhatsAppMessage(phone, reply);
  }
}

// Search birthdays by date
async function searchBirthdaysByDate(phone, day, normalizedMonth) {
  const results = await getBirthdaysByDate(phone, day, normalizedMonth);
  
  if (results.length === 0) {
    const reply = await safeRewrite(`No birthdays or anniversaries on ${normalizedMonth} ${day}.`);
    await sendWhatsAppMessage(phone, reply);
  } else if (results.length === 1) {
    const b = results[0];
    const eventName = b.type === 'anniversary' ? 'anniversary' : 'birthday';
    const reply = await safeRewrite(`${b.name}'s ${eventName} is on ${normalizedMonth} ${day}.`);
    await sendWhatsAppMessage(phone, reply);
  } else {
    const names = results.map(b => {
      const typeLabel = b.type === 'anniversary' ? ' (Anniversary)' : '';
      return `${b.name}${typeLabel}`;
    }).join(', ');
    const reply = await safeRewrite(`Important dates on ${normalizedMonth} ${day}: ${names}`);
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
    const reply = await safeRewrite('No upcoming birthdays or anniversaries in the next 30 days.');
    await sendWhatsAppMessage(phone, reply);
  } else {
    const list = upcoming.map(b => {
      const typeLabel = b.type === 'anniversary' ? ' (Anniversary)' : '';
      return `• ${b.day} ${b.month} – ${b.name}${typeLabel}`;
    }).join('\n');
    const reply = await safeRewrite(`Here are the upcoming important dates:\n\n${list}`);
    await sendWhatsAppMessage(phone, reply);
  }
}

// Search birthdays by name using LLM for accurate matching
async function findBirthdaysByQuery(phone, query) {
  const allBirthdays = await getAllBirthdays(phone);
  if (!query || allBirthdays.length === 0) return [];

  const queryLower = query.trim().toLowerCase();
  const relationshipMatches = allBirthdays.filter(
    b => b.relationship && b.relationship.toLowerCase() === queryLower
  );
  if (relationshipMatches.length > 0) return relationshipMatches;

  const nameList = allBirthdays.map(b => b.name);
  const matchedNames = await searchNameWithLLM(query, nameList);
  if (matchedNames.length === 0) return [];

  const matchedNamesLower = new Set(matchedNames.map(n => n.toLowerCase()));
  return allBirthdays.filter(b => matchedNamesLower.has(b.name.toLowerCase()));
}

function formatAgeReply(matches) {
  if (matches.length === 1) {
    const b = matches[0];
    const age = computeCurrentAge(b.year, b.day, b.month);
    if (age == null) {
      return `I have ${b.name}'s birthday on ${b.month} ${b.day}, but no birth year, so I can't tell their age. Send the year if you'd like me to save it.`;
    }
    if (isBirthdayToday(b.day, b.month)) {
      return `${b.name} turns ${age} today. 🎂`;
    }
    return `${b.name} is ${age}.`;
  }

  const list = matches.map(b => {
    const age = computeCurrentAge(b.year, b.day, b.month);
    const ageText = age == null ? 'no year saved' : `${age}`;
    return `• ${b.name} – ${ageText}`;
  }).join('\n');
  return `I found more than one match:\n\n${list}`;
}

async function fuzzySearchBirthdayByName(phone, query, options = {}) {
  const matches = await findBirthdaysByQuery(phone, query);
  if (matches.length === 0) {
    return { found: false };
  }

  if (options.mode === 'age') {
    const reply = await safeRewrite(formatAgeReply(matches));
    await sendWhatsAppMessage(phone, reply);
    return { found: true, count: matches.length };
  }

  if (matches.length === 1) {
    const b = matches[0];
    const eventName = b.type === 'anniversary' ? 'anniversary' : 'birthday';
    const emoji = b.type === 'anniversary' ? '💍' : '🎂';
    const rel = b.relationship ? ` (${b.relationship})` : '';
    const born = b.year ? `, ${b.year}` : '';
    const reply = await safeRewrite(`${b.name}${rel}'s ${eventName} is on ${b.month} ${b.day}${born}. ${emoji}`);
    await sendWhatsAppMessage(phone, reply);
    return { found: true, count: 1 };
  }

  const list = matches.map(b => {
    const typeLabel = b.type === 'anniversary' ? ' (Anniversary)' : '';
    const rel = b.relationship ? ` (${b.relationship})` : '';
    return `• ${b.name}${rel} – ${b.month} ${b.day}${typeLabel}`;
  }).join('\n');
  const reply = await safeRewrite(`I found these matches:\n\n${list}`);
  await sendWhatsAppMessage(phone, reply);
  return { found: true, count: matches.length };
}

async function updateRelationshipForUser(phone, name, relationship) {
  const matches = await findBirthdaysByQuery(phone, name);
  if (matches.length === 0) {
    const reply = await safeRewrite(`I could not find ${name}'s birthday to add that relationship.`);
    await sendWhatsAppMessage(phone, reply);
    return { success: false };
  }
  if (matches.length > 1) {
    const list = matches.map(b => `• ${b.name} – ${b.month} ${b.day}`).join('\n');
    const reply = await safeRewrite(`I found more than one match for "${name}":\n\n${list}\n\nWhich person did you mean?`);
    await sendWhatsAppMessage(phone, reply);
    return { success: false };
  }

  const b = matches[0];
  await updateBirthdayDetails(phone, b.name, b.day, b.month, b.type, { relationship });
  const reply = await safeRewrite(`I've noted ${b.name} as your ${relationship}.`);
  await sendWhatsAppMessage(phone, reply);
  return { success: true };
}

module.exports = {
  saveBirthdayForUser,
  saveBirthdayFromMessage,
  saveBirthdayFromLegacyPattern,
  deleteBirthdayForUser,
  updateBirthdayForUser,
  renamePersonForUser,
  listBirthdaysForUser,
  listBirthdaysForMonth,
  searchBirthdayByName,
  searchBirthdaysByDate,
  listUpcomingBirthdaysForUser,
  fuzzySearchBirthdayByName,
  updateRelationshipForUser
};

