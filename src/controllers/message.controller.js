// Main message controller - orchestrates all incoming message handling

const { updateLastInteraction } = require('../../db.js');
const { handleOnboarding, sendHelpMessage } = require('../services/onboarding.service');
const { parseIntent } = require('../parsers/intent.parser');
const { processMultilineMessage } = require('../parsers/multiline.parser');
const { markWelcomeSeen } = require('../../db.js');
const { safeRewrite, sendWhatsAppMessage } = require('../services/whatsapp.service');
const {
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
} = require('../services/birthday.service');
const { formatBirthdaysChronologically } = require('../formatters/birthday.formatter');
const {
  extractMonthFromText,
  getCurrentMonthAbbrev,
  getCurrentMonthName,
  normalizeMonthToShort
} = require('../utils/month.utils');
const { parseNameAndDate } = require('../parsers/date.parser');

async function handleIncomingMessage(req, res) {
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

    // Update last interaction timestamp for Meta 24h window compliance
    await updateLastInteraction(phone);

    // 0️⃣ FIRST-TIME USER ONBOARDING (check at the very beginning, before any intent parsing)
    const wasOnboarded = await handleOnboarding(phone);
    if (wasOnboarded) {
      return res.sendStatus(200);
    }

    // Multi-line birthday processing
    const multilineResult = await processMultilineMessage(phone, message);
    if (multilineResult) {
      // Mark user as having seen welcome after successful multi-line save
      await markWelcomeSeen(phone);
      const reply = await safeRewrite(multilineResult);
      await sendWhatsAppMessage(phone, reply);
      return res.sendStatus(200);
    }

    // 0️⃣ Explicit help keyword (always available)
    if (lowerMessage.includes('help')) {
      await sendHelpMessage(phone);
      return res.sendStatus(200);
    }

    // LLM Intent Parsing (before regex fallback)
    const parsed = await parseIntent(message);

    // Handle list intents FIRST (before welcome check) to ensure they never trigger welcome
    if (parsed.intent === 'list_all') {
      await listBirthdaysForUser(phone, formatBirthdaysChronologically);
      return res.sendStatus(200);
    }

    if (parsed.intent === 'list_month') {
      // Priority 1: Check if explicit month is mentioned in message
      let month = extractMonthFromText(message);
      let monthName;
      
      if (month) {
        // Explicit month found in message - use it
        monthName = month.charAt(0).toUpperCase() + month.slice(1);
        console.log(`[LIST_MONTH] Using explicit month from message: ${monthName}`);
      } else if (lowerMessage.includes('this month')) {
        // Priority 2: User said "this month" - use current month
        month = getCurrentMonthAbbrev();
        monthName = getCurrentMonthName();
        console.log(`[LIST_MONTH] Using current month (this month): ${monthName}`);
      } else {
        // Priority 3: Fallback to current month (for backward compatibility)
        month = getCurrentMonthAbbrev();
        monthName = getCurrentMonthName();
        console.log(`[LIST_MONTH] No explicit month found, using current month: ${monthName}`);
      }
      
      await listBirthdaysForMonth(phone, month, monthName);
      return res.sendStatus(200);
    }

    // Check for list intents via regex (also before welcome check)
    if (
      lowerMessage.includes('all birthdays') ||
      lowerMessage.includes('complete list') ||
      lowerMessage.includes('everything saved')
    ) {
      await listBirthdaysForUser(phone, formatBirthdaysChronologically);
      return res.sendStatus(200);
    }

    // Regex fallback: "this month" (only if no explicit month name is present)
    const explicitMonthInMessage = extractMonthFromText(message);
    if (lowerMessage.includes('this month') && !explicitMonthInMessage) {
      const month = getCurrentMonthAbbrev();
      const monthName = getCurrentMonthName();
      console.log(`[REGEX FALLBACK] "this month" detected, using current month: ${monthName}`);
      await listBirthdaysForMonth(phone, month, monthName);
      return res.sendStatus(200);
    }

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

      if (name && day && month) {
        const result = await saveBirthdayForUser(phone, name, day, month);
        if (result.success || result.duplicate) {
          return res.sendStatus(200);
        }
      }
      // If we still don't have a valid triplet, fall through to regex logic
    }

    if (parsed.intent === 'delete') {
      const inputName = parsed.name.trim();
      await deleteBirthdayForUser(phone, inputName);
      return res.sendStatus(200);
    }

    if (parsed.intent === 'update') {
      const name = parsed.name.trim();
      const day = parseInt(parsed.day);
      const month = parsed.month;
      const result = await updateBirthdayForUser(phone, name, day, month);
      if (result.success) {
        return res.sendStatus(200);
      }
      // Invalid month, fall through to regex logic
    }

    // If intent is "unknown", fall through to existing regex logic below

    // 3️⃣ Delete (regex fallback)
    const deleteMatch = lowerMessage.match(/^(?:delete|remove)\s+(.+)$/);
    if (deleteMatch) {
      const inputName = deleteMatch[1].trim();
      await deleteBirthdayForUser(phone, inputName);
      return res.sendStatus(200);
    }

    // 4️⃣ Update (regex fallback)
    const updateMatch = lowerMessage.match(
      /^(?:change|update)\s+(.+?)\s+(?:to|birthday to)\s+([a-z]+)\s+(\d+)$/i
    );
    if (updateMatch) {
      const [, name, month, day] = updateMatch;
      const result = await updateBirthdayForUser(phone, name.trim(), parseInt(day), month);
      if (result.success) {
        return res.sendStatus(200);
      }
    }

    // 5️⃣ Save (with flexible date parsing)
    const saveResult = await saveBirthdayFromMessage(phone, message);
    if (saveResult.success || saveResult.duplicate) {
      return res.sendStatus(200);
    }

    // Legacy save pattern fallback ("Name Month Day")
    const legacySaveResult = await saveBirthdayFromLegacyPattern(phone, message);
    if (legacySaveResult.success || legacySaveResult.duplicate) {
      return res.sendStatus(200);
    }

    // SEARCH FEATURES - Search by name, date, month, and upcoming birthdays
    
    // 1️⃣ Search by name (LLM intent)
    if (parsed.intent === 'search_name' && parsed.name) {
      const searchName = parsed.name.trim();
      await searchBirthdayByName(phone, searchName);
      return res.sendStatus(200);
    }
    
    // 2️⃣ Search by date (LLM intent)
    if (parsed.intent === 'search_date' && parsed.day && parsed.month) {
      const day = parseInt(parsed.day);
      const month = parsed.month;
      const normalizedMonth = normalizeMonthToShort(month);
      
      if (normalizedMonth) {
        await searchBirthdaysByDate(phone, day, normalizedMonth);
        return res.sendStatus(200);
      }
    }
    
    // 3️⃣ Search by month (LLM intent)
    if (parsed.intent === 'search_month') {
      // Priority: Use explicit month from message text, then LLM parsed month, then current month
      let normalizedMonth = extractMonthFromText(message);
      
      if (!normalizedMonth && parsed.month) {
        // Fallback to LLM parsed month if extraction didn't find one
        normalizedMonth = normalizeMonthToShort(parsed.month);
        if (normalizedMonth) {
          console.log(`[SEARCH_MONTH] Using LLM parsed month: "${parsed.month}" → "${normalizedMonth}"`);
        }
      }
      
      if (normalizedMonth) {
        const monthName = normalizedMonth.charAt(0).toUpperCase() + normalizedMonth.slice(1);
        await listBirthdaysForMonth(phone, normalizedMonth, monthName);
        return res.sendStatus(200);
      }
    }
    
    // 4️⃣ Upcoming birthdays (LLM intent)
    if (parsed.intent === 'upcoming') {
      await listUpcomingBirthdaysForUser(phone);
      return res.sendStatus(200);
    }
    
    // REGEX FALLBACKS for search features
    
    // Search by name (regex fallback)
    const searchNameMatch = lowerMessage.match(/(?:when is|show me|birthday of|birthday)\s+([a-z\s]+?)(?:\s+birthday|\?|$)/i);
    if (searchNameMatch) {
      const searchName = searchNameMatch[1].trim();
      if (searchName && searchName.length > 0) {
        await searchBirthdayByName(phone, searchName);
        return res.sendStatus(200);
      }
    }
    
    // Search by date (regex fallback)
    const searchDateMatch = lowerMessage.match(/(?:who has birthday on|birthdays on|who is born on)\s+(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)/i);
    if (searchDateMatch) {
      const day = parseInt(searchDateMatch[1]);
      const month = searchDateMatch[2];
      const normalizedMonth = normalizeMonthToShort(month);
      
      if (normalizedMonth) {
        await searchBirthdaysByDate(phone, day, normalizedMonth);
        return res.sendStatus(200);
      }
    }
    
    // Search by date (numeric format: 14/12, 2/6)
    const numericDateMatch = lowerMessage.match(/(?:birthdays on|who has birthday on)\s+(\d{1,2})[\/-](\d{1,2})/i);
    if (numericDateMatch) {
      const day = parseInt(numericDateMatch[1]);
      const monthNum = parseInt(numericDateMatch[2]);
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                         'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      if (monthNum >= 1 && monthNum <= 12) {
        const normalizedMonth = monthNames[monthNum - 1];
        await searchBirthdaysByDate(phone, day, normalizedMonth);
        return res.sendStatus(200);
      }
    }
    
    // Search by month (regex fallback)
    const searchMonthMatch = lowerMessage.match(/(?:show me|who has birthday in|birthdays in)\s+([a-z]+)/i);
    if (searchMonthMatch) {
      const month = searchMonthMatch[1];
      const normalizedMonth = normalizeMonthToShort(month);
      
      if (normalizedMonth) {
        console.log(`[REGEX FALLBACK] Found month "${month}" → normalized to "${normalizedMonth}"`);
        const monthName = normalizedMonth.charAt(0).toUpperCase() + normalizedMonth.slice(1);
        await listBirthdaysForMonth(phone, normalizedMonth, monthName);
        return res.sendStatus(200);
      }
    }
    
    // Additional regex: "what are the birthdays in March?" pattern
    const whatBirthdaysMatch = lowerMessage.match(/(?:what are|what're|what's)\s+(?:the\s+)?birthdays?\s+in\s+([a-z]+)/i);
    if (whatBirthdaysMatch) {
      const month = whatBirthdaysMatch[1];
      const normalizedMonth = normalizeMonthToShort(month);
      
      if (normalizedMonth) {
        console.log(`[REGEX FALLBACK] Found month in "what are birthdays in" pattern: "${month}" → "${normalizedMonth}"`);
        const monthName = normalizedMonth.charAt(0).toUpperCase() + normalizedMonth.slice(1);
        await listBirthdaysForMonth(phone, normalizedMonth, monthName);
        return res.sendStatus(200);
      }
    }
    
    // Upcoming birthdays (regex fallback)
    if (lowerMessage.includes('upcoming birthdays') || 
        lowerMessage.includes('birthdays coming up') ||
        lowerMessage.includes('birthdays in next 30 days') ||
        lowerMessage.includes('who has birthday soon')) {
      await listUpcomingBirthdaysForUser(phone);
      return res.sendStatus(200);
    }

    // 6️⃣ Fuzzy name search (fallback before help message)
    // If no intent matched, try fuzzy name search
    // Only attempt if message is not empty and doesn't look like a command
    const trimmedMessage = message.trim();
    if (trimmedMessage.length > 0 && trimmedMessage.length <= 50) {
      // Skip if it looks like a date pattern or command
      const looksLikeDate = /\d{1,2}[\/-]\d{1,2}|\d{1,2}(st|nd|rd|th)/i.test(trimmedMessage);
      const looksLikeCommand = /^(save|delete|remove|change|update|list|show|help|complete)/i.test(trimmedMessage);
      
      if (!looksLikeDate && !looksLikeCommand) {
        const fuzzyResult = await fuzzySearchBirthdayByName(phone, trimmedMessage);
        if (fuzzyResult.found) {
          return res.sendStatus(200);
        }
        // If no fuzzy match found, fall through to help message
      }
    }

    // 7️⃣ Final Fallback
    // All existing users (who reach here) get the standard fallback message
    const help = await safeRewrite(
      'You can tell me a birthday like this: Tanni Feb 9 🎂\nNot sure what to do? Just type help.'
    );
    await sendWhatsAppMessage(phone, help);
    return res.sendStatus(200);

  } catch (err) {
    console.error('Webhook error:', err);
    return res.sendStatus(200);
  }
}

module.exports = {
  handleIncomingMessage
};

