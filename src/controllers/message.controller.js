// Main message controller - orchestrates all incoming message handling

const { updateLastInteraction } = require('../../db.js');
const { handleOnboarding, sendHelpMessage, WELCOME_MESSAGE } = require('../services/onboarding.service');
const { parseIntentWithLLM } = require('../../llm.js');
const { processMultilineMessage } = require('../parsers/multiline.parser');
const { markWelcomeSeen } = require('../../db.js');
const { safeRewrite, sendWhatsAppMessage } = require('../services/whatsapp.service');
const {
  saveBirthdayForUser,
  deleteBirthdayForUser,
  updateBirthdayForUser,
  listBirthdaysForUser,
  listBirthdaysForMonth,
  fuzzySearchBirthdayByName
} = require('../services/birthday.service');
const { formatBirthdaysChronologically } = require('../formatters/birthday.formatter');
const {
  extractMonthFromText,
  getCurrentMonthAbbrev,
  getCurrentMonthName,
  normalizeMonthToShort
} = require('../utils/month.utils');
const { logEvent } = require('../utils/betterstack');

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

    // Extract userId and text for Better Stack logging
    const userId = phone || 'unknown';
    const text = message || '';

    // Log user message to Better Stack
    await logEvent({
      event: 'user_message_received',
      userId,
      ts: new Date().toISOString(),
      props: { text }
    });

    console.log('📞 FROM:', phone);
    console.log('💬 MESSAGE:', message);

    // Update last interaction timestamp for Meta 24h window compliance
    await updateLastInteraction(phone);

    // 0️⃣ FIRST-TIME USER ONBOARDING (check at the very beginning, before any intent parsing)
    const wasOnboarded = await handleOnboarding(phone);
    if (wasOnboarded) {
      return res.sendStatus(200);
    }

    // Multi-line birthday processing (before LLM parsing)
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

    // 🔥 LLM INTENT PARSING (at the very top, after onboarding and help)
    const parsed = await parseIntentWithLLM(message);

    // Handle clarification requests
    if (parsed.needs_clarification && parsed.clarification_question) {
      const reply = await safeRewrite(parsed.clarification_question);
      await sendWhatsAppMessage(phone, reply);
      return res.sendStatus(200);
    }

    // Switch-based intent handling
    switch (parsed.intent) {
      case 'save':
        // Validate required fields
        if (!parsed.name || !parsed.day || !parsed.month) {
          const clarification = await safeRewrite("Whose birthday and which date should I save?");
          await sendWhatsAppMessage(phone, clarification);
          return res.sendStatus(200);
        }
        
        // Use LLM-extracted values
        const saveResult = await saveBirthdayForUser(phone, parsed.name, parsed.day, parsed.month);
        if (saveResult.success || saveResult.duplicate) {
          await markWelcomeSeen(phone);
          return res.sendStatus(200);
        }
        // If save failed, fall through to unknown
        break;

      case 'update':
        // Validate required fields
        if (!parsed.name || !parsed.day || !parsed.month) {
          const clarification = await safeRewrite("Whose birthday should I update and what's the new date?");
          await sendWhatsAppMessage(phone, clarification);
          return res.sendStatus(200);
        }
        
        const updateResult = await updateBirthdayForUser(phone, parsed.name, parsed.day, parsed.month);
        if (updateResult.success) {
          return res.sendStatus(200);
        }
        // If update failed, fall through to unknown
        break;

      case 'delete':
        // Validate required fields
        if (!parsed.name) {
          const clarification = await safeRewrite("Whose birthday should I delete?");
          await sendWhatsAppMessage(phone, clarification);
          return res.sendStatus(200);
        }
        
        await deleteBirthdayForUser(phone, parsed.name);
        return res.sendStatus(200);

      case 'list_all':
        await listBirthdaysForUser(phone, formatBirthdaysChronologically);
        return res.sendStatus(200);

      case 'list_month':
        // Determine month: use parsed.month if available, otherwise extract from message, otherwise current month
        let month = null;
        let monthName = null;
        
        if (parsed.month) {
          month = normalizeMonthToShort(parsed.month);
          if (month) {
            monthName = month.charAt(0).toUpperCase() + month.slice(1);
          }
        }
        
        if (!month) {
          // Try extracting from message text
          const extractedMonth = extractMonthFromText(message);
          if (extractedMonth) {
            month = normalizeMonthToShort(extractedMonth);
            if (month) {
              monthName = month.charAt(0).toUpperCase() + month.slice(1);
            }
          }
        }
        
        if (!month) {
          // Fallback to current month
          month = getCurrentMonthAbbrev();
          monthName = getCurrentMonthName();
        }
        
        await listBirthdaysForMonth(phone, month, monthName);
        return res.sendStatus(200);

      case 'search':
        // Validate query
        if (!parsed.query || parsed.query.trim().length === 0) {
          const clarification = await safeRewrite("What should I search for?");
          await sendWhatsAppMessage(phone, clarification);
          return res.sendStatus(200);
        }
        
        const searchQuery = parsed.query.trim();
        // Skip if query looks like a date pattern
        const looksLikeDate = /\d{1,2}[\/-]\d{1,2}|\d{1,2}(st|nd|rd|th)/i.test(searchQuery);
        if (looksLikeDate) {
          // Fall through to unknown
          break;
        }
        
        const fuzzyResult = await fuzzySearchBirthdayByName(phone, searchQuery);
        if (fuzzyResult.found) {
          return res.sendStatus(200);
        }
        // If no match found, fall through to unknown
        break;

      case 'help':
        await sendHelpMessage(phone);
        return res.sendStatus(200);

      case 'unknown':
      default:
        // Guardrail: Always reply with birthday-only message for unknown intents
        const fallback = await safeRewrite("I can only help with saving and managing birthdays 😊");
        await sendWhatsAppMessage(phone, fallback);
        return res.sendStatus(200);
    }

    // If we reach here, something went wrong - send fallback
    const fallback = await safeRewrite("I can only help with saving and managing birthdays 😊");
    await sendWhatsAppMessage(phone, fallback);
    return res.sendStatus(200);

  } catch (err) {
    console.error('Webhook error:', err);
    return res.sendStatus(200);
  }
}

module.exports = {
  handleIncomingMessage
};
