// Main message controller - orchestrates all incoming message handling

const { updateLastInteraction, updateMessageStatus, saveReceivedMessage, getUserName, setUserName, updateMessageIntent, getPendingAction, setPendingAction, clearPendingAction } = require('../../db.js');
const { handleOnboarding, isInOnboarding, handleOnboardingResponse, sendHelpMessage } = require('../services/onboarding.service');
const { parseIntentWithLLM, generateScopedBirthdayBotReply } = require('../../llm.js');
const { processMultilineMessage } = require('../parsers/multiline.parser');
const { parseNameAndDate } = require('../parsers/date.parser');
const { markWelcomeSeen } = require('../../db.js');
const { safeRewrite, sendWhatsAppMessage } = require('../services/whatsapp.service');
const {
  saveBirthdayForUser,
  deleteBirthdayForUser,
  updateBirthdayForUser,
  renamePersonForUser,
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

// Filler words that should never be treated as (part of) a person's name when
// recovering a name from raw text. If nothing else remains, we have no real name.
const NAME_FILLER_WORDS = new Set([
  'birthday', 'birthdays', 'bday', 'bdays', 'anniversary', 'anniv', 'anniversaries',
  'of', 'on', 'is', 'for', 'the', 'a', 'an', 'save', 'add', 'remind', 'set',
  'my', 'me', 'i', 'mine', 'myself'
]);

function stripFillerWords(name) {
  if (!name) return '';
  return name
    .split(/\s+/)
    .filter(token => token && !NAME_FILLER_WORDS.has(token.toLowerCase()))
    .join(' ')
    .trim();
}

/**
 * Resume a pending action using the user's follow-up message.
 * Returns true if the action was handled, false to fall through to normal processing.
 */
async function resumePendingAction(phone, message, pending) {
  const { intent, event_type, missing_field } = pending;
  const trimmedMessage = message.trim();

  try {
    switch (intent) {
      case 'search': {
        // The user's reply is the search query (e.g. "naman")
        const query = trimmedMessage;
        if (!query) return false;
        
        const fuzzyResult = await fuzzySearchBirthdayByName(phone, query);
        if (fuzzyResult.found) {
          return true;
        }
        // No match found — let user know
        const eventName = event_type === 'anniversary' ? 'anniversary' : 'birthday';
        const reply = await safeRewrite(`I couldn't find a ${eventName} saved under "${query}". Try a different name or type *complete list* to see all entries.`);
        await sendWhatsAppMessage(phone, reply);
        return true;
      }

      case 'save': {
        if (missing_field === 'name') {
          // The user's reply is the name; we already have the date
          const name = trimmedMessage;
          if (!name) return false;
          const result = await saveBirthdayForUser(phone, name, pending.day, pending.month, event_type);
          if (result.success || result.duplicate) {
            await markWelcomeSeen(phone);
          }
          return true;
        }
        if (missing_field === 'date') {
          // The user's reply should contain a date; parse it
          const parsed = await parseIntentWithLLM(trimmedMessage);
          if (parsed.day && parsed.month) {
            const result = await saveBirthdayForUser(phone, pending.name, parsed.day, parsed.month, event_type);
            if (result.success || result.duplicate) {
              await markWelcomeSeen(phone);
            }
            return true;
          }
          // Could also be a full "Name Date" message; try parsing the whole thing
          return false; // fall through to normal processing
        }
        if (missing_field === 'name_and_date' || missing_field === 'name_or_query') {
          // User's reply might be a full "Name Date" string; fall through to normal processing
          return false;
        }
        return false;
      }

      case 'update': {
        if (missing_field === 'name') {
          const name = trimmedMessage;
          if (!name) return false;
          const result = await updateBirthdayForUser(phone, name, pending.day, pending.month, event_type);
          return result.success;
        }
        if (missing_field === 'date') {
          const parsed = await parseIntentWithLLM(trimmedMessage);
          if (parsed.day && parsed.month) {
            const result = await updateBirthdayForUser(phone, pending.name, parsed.day, parsed.month, event_type);
            return result.success;
          }
          return false;
        }
        return false;
      }

      case 'delete': {
        const name = trimmedMessage;
        if (!name) return false;
        await deleteBirthdayForUser(phone, name, event_type);
        return true;
      }

      case 'rename': {
        if (missing_field === 'new_name' && pending.name) {
          const newName = trimmedMessage;
          if (!newName) return false;
          await renamePersonForUser(phone, pending.name, newName, event_type);
          return true;
        }
        return false;
      }

      default:
        return false;
    }
  } catch (err) {
    console.error('[PENDING ACTION] Error resuming:', err.message);
    return false;
  }
}

const FORWARD_PHONE_NUMBER_ID = process.env.FORWARD_PHONE_NUMBER_ID || '1001734719698872';
const FORWARD_BACKEND_URL = process.env.FORWARD_BACKEND_URL || 'https://san-install-answers-philip.trycloudflare.com/whatsapp/webhook';

async function forwardToBackend(req, res) {
  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(FORWARD_BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    console.log(`[FORWARD] Forwarded to ${FORWARD_BACKEND_URL} — status ${response.status}`);
  } catch (err) {
    console.error(`[FORWARD] Failed to forward to ${FORWARD_BACKEND_URL}:`, err.message);
  }
  return res.sendStatus(200);
}

async function handleIncomingMessage(req, res) {
  try {
    console.log('Received webhook:', JSON.stringify(req.body));
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // 🔀 Forward to different backend if message is for a different WhatsApp number
    const incomingPhoneNumberId = value?.metadata?.phone_number_id;
    if (FORWARD_PHONE_NUMBER_ID && incomingPhoneNumberId === FORWARD_PHONE_NUMBER_ID) {
      console.log(`[FORWARD] Incoming message for phone_number_id ${incomingPhoneNumberId} — forwarding to ${FORWARD_BACKEND_URL}`);
      return forwardToBackend(req, res);
    }

    // 📩 Handle Status Updates (delivered, read, failed)
    const statusObj = value?.statuses?.[0];
    if (statusObj) {
      const id = statusObj.id;
      const status = statusObj.status;
      const timestamp = new Date(parseInt(statusObj.timestamp) * 1000).toISOString();
      console.log(`Message ${id} was ${status} at ${timestamp}`);

      // Update DB for admin metrics
      await updateMessageStatus(id, status, status === 'failed' && statusObj.errors ? statusObj.errors[0].code : null);

      // ❌ Log detailed errors if the message failed
      if (status === 'failed' && statusObj.errors) {
        statusObj.errors.forEach(err => {
          console.error(`❌ Message ${id} failed: [Code ${err.code}] ${err.title}`);
        });
      }

      return res.sendStatus(200);
    }

    const messageObj = value?.messages?.[0];
    if (!messageObj) return res.sendStatus(200);

    const phone = messageObj.from;
    const message = messageObj.text?.body || '';
    const wamid = messageObj.id;

    // Log incoming message to DB for admin metrics
    await saveReceivedMessage(wamid, phone, message);

    const lowerMessage = message.toLowerCase();
    // Only a bare "help" (with optional punctuation) is the help command;
    // messages that merely contain the word ("help me save Papa 29 Aug")
    // must flow through normal parsing.
    const isHelpCommand = /^help[\s!.?]*$/.test(lowerMessage.trim());

    console.log('📞 FROM:', phone);
    console.log('💬 MESSAGE:', message);

    // Update last interaction timestamp for Meta 24h window compliance
    await updateLastInteraction(phone);

    // 0️⃣ FIRST-TIME USER ONBOARDING (check at the very beginning, before any intent parsing)
    const wasOnboarded = await handleOnboarding(phone, message);
    if (wasOnboarded) {
      await updateMessageIntent(wamid, 'onboarding_new');
      return res.sendStatus(200);
    }

    // 🔄 MID-ONBOARDING RESPONSE (process their reply and advance to next step)
    // Skip if user typed "help" — help should always work even during onboarding
    if (!isHelpCommand) {
      const inOnboarding = await isInOnboarding(phone);
      if (inOnboarding) {
        const handled = await handleOnboardingResponse(phone, message);
        if (handled) {
          await updateMessageIntent(wamid, 'onboarding_response');
          return res.sendStatus(200);
        }
      }
    }

    // 🔄 PENDING ACTION RESUMPTION
    // If the bot previously asked a clarification question, the user's response
    // should be interpreted in that context rather than parsed from scratch.
    const pendingAction = await getPendingAction(phone);
    if (pendingAction && !isHelpCommand) {
      // Clear the pending action immediately so it doesn't loop
      await clearPendingAction(phone);

      // Check staleness (ignore if older than 10 minutes)
      const ageMs = Date.now() - new Date(pendingAction.created_at).getTime();
      if (ageMs < 10 * 60 * 1000) {
        const handled = await resumePendingAction(phone, message, pendingAction);
        if (handled) {
          await updateMessageIntent(wamid, `pending_${pendingAction.intent}`);
          return res.sendStatus(200);
        }
      }
      // If stale or not handled, fall through to normal processing
    }

    // Multi-line birthday processing (before LLM parsing)
    const multilineResult = await processMultilineMessage(phone, message);
    if (multilineResult) {
      // Mark user as having seen welcome after successful multi-line save
      await markWelcomeSeen(phone);
      const reply = await safeRewrite(multilineResult);
      await sendWhatsAppMessage(phone, reply);
      await updateMessageIntent(wamid, 'multiline_save');
      return res.sendStatus(200);
    }

    // 0️⃣ Explicit help keyword (always available)
    if (isHelpCommand) {
      await sendHelpMessage(phone);
      await updateMessageIntent(wamid, 'help');
      return res.sendStatus(200);
    }

    // 🔥 LLM INTENT PARSING (at the very top, after onboarding and help)
    const parsed = await parseIntentWithLLM(message);

    // Log the parsed intent for metrics
    await updateMessageIntent(wamid, parsed.intent || 'unknown');

    // Catch self-referential names the LLM might not flag (e.g. "my birthday", "remind me")
    const selfReferentialNames = ['my', 'me', 'i', 'mine', 'myself', 'user', 'self'];
    const isSelfReferentialName = (
      parsed.name &&
      selfReferentialNames.includes(parsed.name.toLowerCase().trim())
    );
    const isSelfReferentialQuery = (
      parsed.intent === 'search' &&
      parsed.query &&
      selfReferentialNames.includes(parsed.query.toLowerCase().trim())
    );
    // Only treat a name-less dated message as "my birthday" when the original
    // message actually refers to the user (my/me/mine/myself/I). Otherwise a
    // message like "meghan may 29" (where the LLM failed to extract the name)
    // would be silently saved under the stored user name.
    const messageIsSelfReferential = /\b(my|me|mine|myself|i)\b/i.test(message);
    const isSelfReferential = isSelfReferentialName || isSelfReferentialQuery || (
      messageIsSelfReferential &&
      parsed.needs_clarification &&
      parsed.clarification_question &&
      parsed.day && parsed.month
    );

    if (isSelfReferential) {
      // Try to use stored name before asking
      const storedName = await getUserName(phone);
      if (storedName) {
        if (isSelfReferentialQuery) {
          parsed.query = storedName;
        } else {
          parsed.name = storedName;
        }
        parsed.needs_clarification = false;
        parsed.clarification_question = null;
      } else {
        const eventName = parsed.event_type === 'anniversary' ? 'anniversary' : 'birthday';
        if (parsed.intent === 'search' || isSelfReferentialQuery) {
          parsed.query = null;
          parsed.needs_clarification = true;
          parsed.clarification_question = `What name is your ${eventName} saved under?`;
        } else {
          parsed.name = null;
          parsed.needs_clarification = true;
          parsed.clarification_question = `What name should I save your ${eventName} under?`;
        }
      }
    }

    // Deterministic name recovery: the LLM sometimes fails to extract a clear
    // third-party name from "<name> <month> <day>" messages (e.g. "meghna may 29"
    // → name:null). When the message isn't about the user, recover name + date
    // from the raw text instead of pestering the user for a name we already have.
    if (
      (parsed.intent === 'save' || parsed.intent === 'update') &&
      !parsed.name &&
      !messageIsSelfReferential
    ) {
      const recovered = parseNameAndDate(message);
      if (recovered) {
        const cleanedName = stripFillerWords(recovered.name);
        if (cleanedName) {
          parsed.name = cleanedName;
          if (!parsed.day) parsed.day = recovered.day;
          if (!parsed.month) parsed.month = recovered.month;
          parsed.needs_clarification = false;
          parsed.clarification_question = null;
        }
      }
    }

    // Handle clarification requests — store pending action so the user's reply
    // is interpreted in context rather than parsed from scratch
    if (parsed.needs_clarification && parsed.clarification_question) {
      await setPendingAction(phone, {
        intent: parsed.intent,
        event_type: parsed.event_type || 'birthday',
        name: parsed.name || null,
        day: parsed.day || null,
        month: parsed.month || null,
        query: parsed.query || null,
        missing_field: !parsed.name && !parsed.query ? 'name_or_query' :
                       !parsed.name ? 'name' :
                       !parsed.query && parsed.intent === 'search' ? 'query' :
                       (!parsed.day || !parsed.month) ? 'date' : 'unknown',
        created_at: new Date().toISOString()
      });
      const reply = await safeRewrite(parsed.clarification_question);
      await sendWhatsAppMessage(phone, reply);
      return res.sendStatus(200);
    }

    // Switch-based intent handling
    switch (parsed.intent) {
      case 'save':
        // Validate required fields
        if (!parsed.name || !parsed.day || !parsed.month) {
          const eventName = parsed.event_type === 'anniversary' ? 'anniversary' : 'birthday';
          let clarificationMsg;
          let missingField;
          if (parsed.name && (!parsed.day || !parsed.month)) {
            clarificationMsg = `When is ${parsed.name}'s ${eventName}?`;
            missingField = 'date';
          } else if (!parsed.name && parsed.day && parsed.month) {
            clarificationMsg = `Whose ${eventName} is on ${parsed.month} ${parsed.day}?`;
            missingField = 'name';
          } else {
            clarificationMsg = `Whose ${eventName} and which date should I save?`;
            missingField = 'name_and_date';
          }
          await setPendingAction(phone, {
            intent: 'save',
            event_type: parsed.event_type || 'birthday',
            name: parsed.name || null,
            day: parsed.day || null,
            month: parsed.month || null,
            missing_field: missingField,
            created_at: new Date().toISOString()
          });
          const clarification = await safeRewrite(clarificationMsg);
          await sendWhatsAppMessage(phone, clarification);
          return res.sendStatus(200);
        }
        
        // Use LLM-extracted values
        const saveResult = await saveBirthdayForUser(phone, parsed.name, parsed.day, parsed.month, parsed.event_type);
        if (saveResult.success || saveResult.duplicate) {
          await markWelcomeSeen(phone);
          return res.sendStatus(200);
        }
        // If save failed, fall through to unknown
        break;

      case 'update':
        // Validate required fields
        if (!parsed.name || !parsed.day || !parsed.month) {
          const eventName = parsed.event_type === 'anniversary' ? 'anniversary' : 'birthday';
          let updateClarificationMsg;
          let updateMissingField;
          if (parsed.name && (!parsed.day || !parsed.month)) {
            updateClarificationMsg = `What's the new date for ${parsed.name}'s ${eventName}?`;
            updateMissingField = 'date';
          } else if (!parsed.name && parsed.day && parsed.month) {
            updateClarificationMsg = `Whose ${eventName} should I update to ${parsed.month} ${parsed.day}?`;
            updateMissingField = 'name';
          } else {
            updateClarificationMsg = `Whose ${eventName} should I update and what's the new date?`;
            updateMissingField = 'name_and_date';
          }
          await setPendingAction(phone, {
            intent: 'update',
            event_type: parsed.event_type || 'birthday',
            name: parsed.name || null,
            day: parsed.day || null,
            month: parsed.month || null,
            missing_field: updateMissingField,
            created_at: new Date().toISOString()
          });
          const clarification = await safeRewrite(updateClarificationMsg);
          await sendWhatsAppMessage(phone, clarification);
          return res.sendStatus(200);
        }
        
        const updateResult = await updateBirthdayForUser(phone, parsed.name, parsed.day, parsed.month, parsed.event_type);
        if (updateResult.success) {
          return res.sendStatus(200);
        }
        // If update failed, fall through to unknown
        break;

      case 'rename':
        // Validate required fields
        if (!parsed.name || !parsed.new_name) {
          const eventName = parsed.event_type === 'anniversary' ? 'anniversary' : 'birthday';
          await setPendingAction(phone, {
            intent: 'rename',
            event_type: parsed.event_type || 'birthday',
            name: parsed.name || null,
            new_name: parsed.new_name || null,
            missing_field: !parsed.name ? 'name' : 'new_name',
            created_at: new Date().toISOString()
          });
          const clarification = await safeRewrite(`Whose ${eventName} should I rename and what is the new name?`);
          await sendWhatsAppMessage(phone, clarification);
          return res.sendStatus(200);
        }

        const renameResult = await renamePersonForUser(phone, parsed.name, parsed.new_name, parsed.event_type);
        if (renameResult.success) {
          return res.sendStatus(200);
        }
        break;

      case 'delete':
        // Validate required fields
        if (!parsed.name) {
          const eventName = parsed.event_type === 'anniversary' ? 'anniversary' : 'birthday';
          const clarification = await safeRewrite(`Whose ${eventName} should I delete?`);
          await sendWhatsAppMessage(phone, clarification);
          return res.sendStatus(200);
        }
        
        await deleteBirthdayForUser(phone, parsed.name, parsed.event_type);
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
          await setPendingAction(phone, {
            intent: 'search',
            event_type: parsed.event_type || 'birthday',
            missing_field: 'query',
            created_at: new Date().toISOString()
          });
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

      case 'set_name':
        if (parsed.name) {
          await setUserName(phone, parsed.name);
          const nameConfirmation = await safeRewrite(`Got it! I'll remember your name as ${parsed.name}. 😊`);
          await sendWhatsAppMessage(phone, nameConfirmation);
        } else {
          const askName = await safeRewrite("I didn't catch your name. Could you tell me again?");
          await sendWhatsAppMessage(phone, askName);
        }
        return res.sendStatus(200);

      case 'help':
        await sendHelpMessage(phone);
        return res.sendStatus(200);

      case 'unknown':
      default:
        // Guardrail: unknown/out-of-scope -> acknowledge + redirect back to birthdays/anniversaries
        const scoped = await generateScopedBirthdayBotReply(message);
        const fallback = await safeRewrite(scoped);
        await sendWhatsAppMessage(phone, fallback);
        return res.sendStatus(200);
    }

    // If we reach here, something went wrong - send fallback
    const scoped = await generateScopedBirthdayBotReply(message);
    const fallback = await safeRewrite(scoped);
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
