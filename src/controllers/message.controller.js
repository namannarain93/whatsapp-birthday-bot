// Main message controller - orchestrates all incoming message handling

const { updateLastInteraction, updateMessageStatus, saveReceivedMessage, getUserName, setUserName, updateMessageIntent, getPendingAction, setPendingAction, clearPendingAction, getRecentConversation } = require('../../db.js');
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
  fuzzySearchBirthdayByName,
  updateRelationshipForUser
} = require('../services/birthday.service');
const { formatBirthdaysChronologically } = require('../formatters/birthday.formatter');
const {
  extractMonthFromText,
  getCurrentMonthAbbrev,
  getCurrentMonthName,
  normalizeMonthToShort,
  getDaysInMonth
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

// Replies that mean "drop it" — never treat these as a name.
const CANCEL_REPLY_REGEX = /^(no|nope|nah|na|cancel|stop|skip|leave it|forget it|never ?mind|don'?t|nothing)[\s!.]*$/i;
const AGE_QUESTION_REGEX = /\b(how old|what(?:'s| is) (?:her|his|their) age|age of|what age)\b/i;
const PRONOUN_QUERY_REGEX = /^(she|he|they|her|him|them)$/i;
// Dump the command menu only when the user actually asked for it. A capability
// question ("can you include age in reminders?") is not help.
const HELP_MENU_REQUEST_REGEX =
  /^(help|commands?|menu|what can you do|how (?:do i use this|does (?:this|it) work)|show (?:me )?(?:the )?(?:commands?|help|menu))[\s!.?]*$/i;

function isHelpMenuRequest(message) {
  return HELP_MENU_REQUEST_REGEX.test(String(message || '').trim());
}

function extractAgeQueryFromMessage(message) {
  const match = String(message || '').match(
    /\b(?:how old is|age of|what(?:'s| is) (?:the )?age of)\s+(?:my\s+)?(.+?)\s*\??$/i
  );
  if (!match) return null;
  const query = match[1].trim().replace(/[.!?]+$/g, '');
  if (!query || PRONOUN_QUERY_REGEX.test(query)) return null;
  return query;
}

// "how old is she?" → the person the bot just saved or looked up.
function extractLastPersonFromHistory(history) {
  if (!Array.isArray(history)) return null;
  const patterns = [
    /(?:saved|updated)\s+(.+?)(?:'s)\s+(?:birthday|anniversary)/i,
    /(.+?)(?:'s)\s+(?:birthday|anniversary)\s+is on/i,
    /I don't have\s+(.+?)(?:'s)\s+(?:birthday|anniversary)/i
  ];
  for (let i = history.length - 1; i >= 0; i--) {
    const body = String(history[i].message_body || '');
    for (const re of patterns) {
      const match = body.match(re);
      if (!match || !match[1]) continue;
      const name = match[1].replace(/\s*\([^)]*\)\s*/g, ' ').trim();
      if (name && name.length < 80 && !PRONOUN_QUERY_REGEX.test(name)) return name;
    }
  }
  return null;
}

/**
 * Clean a clarification reply that should contain just a person's name.
 * Strips filler ("it's Ravi's bday" → "it's Ravi's") and returns null when
 * nothing name-like remains, so the caller can fall through to full parsing.
 */
function extractNameFromReply(reply) {
  const cleaned = stripFillerWords(reply.replace(/[.!?]+$/g, ''));
  return cleaned || null;
}

/**
 * Resume a pending action using the user's follow-up message.
 * Returns true if the action was handled, false to fall through to normal processing.
 */
async function resumePendingAction(phone, message, pending) {
  const { intent, event_type, missing_field } = pending;
  const trimmedMessage = message.trim();

  try {
    // The user is backing out ("cancel", "no", "leave it") — acknowledge and
    // stop instead of saving the word as a name.
    if (CANCEL_REPLY_REGEX.test(trimmedMessage)) {
      const reply = await safeRewrite('Okay, no problem. 👍');
      await sendWhatsAppMessage(phone, reply);
      return true;
    }

    // The reply is a complete "Name + date" entry (user restated everything,
    // or moved on to a new request) — let normal parsing handle it in full.
    if (
      (missing_field === 'name' || intent === 'delete') &&
      parseNameAndDate(trimmedMessage)
    ) {
      return false;
    }

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
          const name = extractNameFromReply(trimmedMessage);
          if (!name) return false;
          const result = await saveBirthdayForUser(phone, name, pending.day, pending.month, event_type, {
            year: pending.year || null,
            relationship: pending.relationship || null
          });
          if (result.success || result.duplicate) {
            await markWelcomeSeen(phone);
          }
          return true;
        }
        if (missing_field === 'date') {
          // The user's reply should contain a date; parse it
          const parsed = await parseIntentWithLLM(trimmedMessage);
          if (parsed.day && parsed.month) {
            const result = await saveBirthdayForUser(phone, pending.name, parsed.day, parsed.month, event_type, {
              year: parsed.year || pending.year || null,
              relationship: parsed.relationship || pending.relationship || null
            });
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
          const name = extractNameFromReply(trimmedMessage);
          if (!name) return false;
          const result = await updateBirthdayForUser(phone, name, pending.day, pending.month, event_type, {
            year: pending.year || null,
            relationship: pending.relationship || null
          });
          return result.success;
        }
        if (missing_field === 'date') {
          const parsed = await parseIntentWithLLM(trimmedMessage);
          if (parsed.day && parsed.month) {
            const result = await updateBirthdayForUser(phone, pending.name, parsed.day, parsed.month, event_type, {
              year: parsed.year || pending.year || null,
              relationship: parsed.relationship || pending.relationship || null
            });
            return result.success;
          }
          return false;
        }
        return false;
      }

      case 'delete': {
        const name = extractNameFromReply(trimmedMessage);
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

    // Only an explicit menu request ("help", "what can you do") is the help
    // command. Capability questions ("can you include age in reminders?")
    // and "help me save Papa 29 Aug" must flow through normal parsing.
    const isHelpCommand = isHelpMenuRequest(message);

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
    // Pass the recent conversation so corrections and follow-ups
    // ("Shivani I mean", "change it to Mar 5") are understood in context.
    const history = (await getRecentConversation(phone, 6, wamid)) || [];
    const parsed = await parseIntentWithLLM(message, { history });
    const actions = Array.isArray(parsed.actions) && parsed.actions.length > 0
      ? parsed.actions
      : [parsed];

    // Log the parsed intent(s) for metrics
    await updateMessageIntent(wamid, actions.map(a => a.intent || 'unknown').join('+'));

    // Execute each action in order. Stop at the first clarification question so
    // the user's next reply is interpreted against a single pending action.
    let anyHandled = false;
    for (const action of actions) {
      const outcome = await handleParsedAction(phone, message, action, actions.length === 1, history);
      if (outcome === 'clarify') {
        anyHandled = true;
        break;
      }
      if (outcome === 'handled') {
        anyHandled = true;
      }
    }

    if (!anyHandled) {
      // ChatGPT-style fallback: keep the conversational voice. Do not run the
      // elderly rewrite on top — that flattens it into a canned redirect.
      const scoped = await generateScopedBirthdayBotReply(message, { history });
      await sendWhatsAppMessage(phone, scoped);
    }
    return res.sendStatus(200);

  } catch (err) {
    console.error('Webhook error:', err);
    return res.sendStatus(200);
  }
}

/**
 * Backstop validation: reject impossible dates (Feb 30, day 32, unknown month)
 * with a clarifying question instead of silently saving garbage.
 * Returns the clarification text, or null when the date is valid.
 */
function getInvalidDateClarification(parsed) {
  const eventName = parsed.event_type === 'anniversary' ? 'anniversary' : 'birthday';
  const maxDay = getDaysInMonth(parsed.month);
  if (!maxDay) {
    return `I couldn't read that date. When is ${parsed.name}'s ${eventName}? (e.g. "5 Aug")`;
  }
  if (parsed.day < 1 || parsed.day > maxDay) {
    return `That date doesn't look right — ${parsed.month} has only ${maxDay} days. When is ${parsed.name}'s ${eventName}?`;
  }
  return null;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "12/4" is either 12 Apr or 4 Dec. Never guess — that would save a wrong date.
function getAmbiguousNumericDateClarification(message, parsed) {
  if (parsed.intent !== 'save' && parsed.intent !== 'update') return null;
  if (!parsed.day || !parsed.month) return null;
  const match = String(message || '').match(/\b(\d{1,2})[/\-.](\d{1,2})\b/);
  if (!match) return null;
  const first = parseInt(match[1], 10);
  const second = parseInt(match[2], 10);
  if (first < 1 || second < 1 || first > 12 || second > 12 || first === second) {
    return null;
  }
  const person = parsed.name ? `${parsed.name}'s ` : '';
  const eventName = parsed.event_type === 'anniversary' ? 'anniversary' : 'birthday';
  return `I don't want to save the wrong date. Is ${person}${eventName} ${first} ${SHORT_MONTHS[second - 1]} or ${second} ${SHORT_MONTHS[first - 1]}?`;
}

/**
 * Execute a single parsed action.
 * Returns 'handled' when a reply was sent, 'clarify' when a clarification
 * question was asked (pending action stored), or 'fallthrough' when nothing
 * could be done (caller decides whether to send the scoped fallback reply).
 */
async function handleParsedAction(phone, message, parsed, isOnlyAction, history = []) {
    if (AGE_QUESTION_REGEX.test(message)) {
      parsed.intent = 'search';
      parsed.wants_age = true;
      parsed.needs_clarification = false;
      parsed.clarification_question = null;
      if (!parsed.query || PRONOUN_QUERY_REGEX.test(String(parsed.query).trim())) {
        parsed.query = extractAgeQueryFromMessage(message)
          || parsed.name
          || extractLastPersonFromHistory(history)
          || null;
      }
    }

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
    // Only safe when this is the message's single action — with multiple actions
    // the raw text spans several requests and would recover the wrong name.
    if (
      isOnlyAction &&
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
          if (!parsed.year) parsed.year = recovered.year || null;
          if (!parsed.relationship) parsed.relationship = recovered.relationship || null;
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
        year: parsed.year || null,
        relationship: parsed.relationship || null,
        query: parsed.query || null,
        missing_field: !parsed.name && !parsed.query ? 'name_or_query' :
                       !parsed.name ? 'name' :
                       !parsed.query && parsed.intent === 'search' ? 'query' :
                       (!parsed.day || !parsed.month) ? 'date' : 'unknown',
        created_at: new Date().toISOString()
      });
      const reply = await safeRewrite(parsed.clarification_question);
      await sendWhatsAppMessage(phone, reply);
      return 'clarify';
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
            year: parsed.year || null,
            relationship: parsed.relationship || null,
            missing_field: missingField,
            created_at: new Date().toISOString()
          });
          const clarification = await safeRewrite(clarificationMsg);
          await sendWhatsAppMessage(phone, clarification);
          return 'clarify';
        }

        const ambiguousDate = getAmbiguousNumericDateClarification(message, parsed);
        if (ambiguousDate) {
          await setPendingAction(phone, {
            intent: 'save',
            event_type: parsed.event_type || 'birthday',
            name: parsed.name,
            day: null,
            month: null,
            year: parsed.year || null,
            relationship: parsed.relationship || null,
            missing_field: 'date',
            created_at: new Date().toISOString()
          });
          const clarification = await safeRewrite(ambiguousDate);
          await sendWhatsAppMessage(phone, clarification);
          return 'clarify';
        }

        // Backstop: never save an impossible date — ask for the right one
        const saveDateProblem = getInvalidDateClarification(parsed);
        if (saveDateProblem) {
          await setPendingAction(phone, {
            intent: 'save',
            event_type: parsed.event_type || 'birthday',
            name: parsed.name,
            day: null,
            month: null,
            year: parsed.year || null,
            relationship: parsed.relationship || null,
            missing_field: 'date',
            created_at: new Date().toISOString()
          });
          const clarification = await safeRewrite(saveDateProblem);
          await sendWhatsAppMessage(phone, clarification);
          return 'clarify';
        }

        // Use LLM-extracted values
        const saveResult = await saveBirthdayForUser(phone, parsed.name, parsed.day, parsed.month, parsed.event_type, {
          year: parsed.year || null,
          relationship: parsed.relationship || null
        });
        if (saveResult.success || saveResult.duplicate) {
          await markWelcomeSeen(phone);
          return 'handled';
        }
        // If save failed, fall through to unknown
        break;

      case 'update':
        if (parsed.name && parsed.relationship && !parsed.day && !parsed.month) {
          await updateRelationshipForUser(phone, parsed.name, parsed.relationship);
          return 'handled';
        }

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
            year: parsed.year || null,
            relationship: parsed.relationship || null,
            missing_field: updateMissingField,
            created_at: new Date().toISOString()
          });
          const clarification = await safeRewrite(updateClarificationMsg);
          await sendWhatsAppMessage(phone, clarification);
          return 'clarify';
        }

        const ambiguousUpdateDate = getAmbiguousNumericDateClarification(message, parsed);
        if (ambiguousUpdateDate) {
          await setPendingAction(phone, {
            intent: 'update',
            event_type: parsed.event_type || 'birthday',
            name: parsed.name,
            day: null,
            month: null,
            year: parsed.year || null,
            relationship: parsed.relationship || null,
            missing_field: 'date',
            created_at: new Date().toISOString()
          });
          const clarification = await safeRewrite(ambiguousUpdateDate);
          await sendWhatsAppMessage(phone, clarification);
          return 'clarify';
        }

        // Backstop: never update to an impossible date — ask for the right one
        const updateDateProblem = getInvalidDateClarification(parsed);
        if (updateDateProblem) {
          await setPendingAction(phone, {
            intent: 'update',
            event_type: parsed.event_type || 'birthday',
            name: parsed.name,
            day: null,
            month: null,
            year: parsed.year || null,
            relationship: parsed.relationship || null,
            missing_field: 'date',
            created_at: new Date().toISOString()
          });
          const clarification = await safeRewrite(updateDateProblem);
          await sendWhatsAppMessage(phone, clarification);
          return 'clarify';
        }

        const updateResult = await updateBirthdayForUser(phone, parsed.name, parsed.day, parsed.month, parsed.event_type, {
          year: parsed.year || null,
          relationship: parsed.relationship || null
        });
        if (updateResult.success) {
          return 'handled';
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
          return 'clarify';
        }

        // renamePersonForUser always replies (success or "could not find"),
        // so the user has been answered either way.
        await renamePersonForUser(phone, parsed.name, parsed.new_name, parsed.event_type);
        return 'handled';

      case 'delete':
        // Validate required fields
        if (!parsed.name) {
          const eventName = parsed.event_type === 'anniversary' ? 'anniversary' : 'birthday';
          const clarification = await safeRewrite(`Whose ${eventName} should I delete?`);
          await sendWhatsAppMessage(phone, clarification);
          return 'clarify';
        }
        
        await deleteBirthdayForUser(phone, parsed.name, parsed.event_type);
        return 'handled';

      case 'list_all':
        await listBirthdaysForUser(phone, formatBirthdaysChronologically);
        return 'handled';

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
        return 'handled';

      case 'search':
        if (!parsed.query || parsed.query.trim().length === 0) {
          parsed.query = extractLastPersonFromHistory(history);
        }
        // Age/"who?" follow-ups with no name: let the conversational bot use
        // the transcript instead of a canned "What should I search for?"
        if (!parsed.query || parsed.query.trim().length === 0) {
          if (parsed.wants_age) {
            return 'fallthrough';
          }
          await setPendingAction(phone, {
            intent: 'search',
            event_type: parsed.event_type || 'birthday',
            missing_field: 'query',
            created_at: new Date().toISOString()
          });
          const clarification = await safeRewrite("What should I search for?");
          await sendWhatsAppMessage(phone, clarification);
          return 'clarify';
        }
        
        const searchQuery = parsed.query.trim();
        // Skip if query looks like a date pattern
        const looksLikeDate = /\d{1,2}[\/-]\d{1,2}|\d{1,2}(st|nd|rd|th)/i.test(searchQuery);
        if (looksLikeDate) {
          // Fall through to unknown
          break;
        }
        
        const fuzzyResult = await fuzzySearchBirthdayByName(
          phone,
          searchQuery,
          parsed.wants_age ? { mode: 'age' } : {}
        );
        if (fuzzyResult.found) {
          return 'handled';
        }

        // Nothing saved under that name. If the query looks like a plain
        // person's name, offer to save it (the user often meant "add papa")
        // instead of sending a generic fallback.
        if (/^[a-z][a-z .'&-]{0,40}$/i.test(searchQuery)) {
          const searchEventName = parsed.event_type === 'anniversary' ? 'anniversary' : 'birthday';
          await setPendingAction(phone, {
            intent: 'save',
            event_type: parsed.event_type || 'birthday',
            name: searchQuery,
            day: null,
            month: null,
            missing_field: 'date',
            created_at: new Date().toISOString()
          });
          const offer = await safeRewrite(
            `I don't have ${searchQuery}'s ${searchEventName} saved yet. If you'd like me to save it, just send the date (e.g. "${searchQuery} 5 Aug").`
          );
          await sendWhatsAppMessage(phone, offer);
          return 'clarify';
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
        return 'handled';

      case 'help':
        // The parser often tags "can you…?" capability questions as help.
        // Only the command menu belongs here; everything else is conversation.
        if (!isHelpMenuRequest(message)) {
          return 'fallthrough';
        }
        await sendHelpMessage(phone);
        return 'handled';

      case 'unknown':
      default:
        // Caller sends the scoped fallback reply when nothing was handled
        return 'fallthrough';
    }

    // A save/update/search action failed — let the caller decide on a fallback
    return 'fallthrough';
}

module.exports = {
  handleIncomingMessage
};
