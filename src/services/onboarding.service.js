// Multi-step onboarding service
// Step 1: Ask for their own birthday  →  Step 2: Inner circle  →  Completion
//
// Core rule: never confirm or advance a step based on receiving a message —
// only based on what was actually parsed and persisted.

const {
  onboardUser,
  saveBirthday,
  birthdayExists,
  setUserName,
  getOnboardingState,
  setOnboardingStep,
  recordOnboardingReprompt,
  completeOnboarding,
  getPendingAction,
  setPendingAction,
  clearPendingAction
} = require('../../db.js');
const { sendWhatsAppMessage } = require('./whatsapp.service');
const {
  parseNameAndDate,
  extractDayAndMonth,
  cleanEventName
} = require('../parsers/date.parser');
const { normalizeMonthToShort } = require('../utils/month.utils');
const { parseIntentWithLLM } = require('../../llm.js');

// ── Help message (sent only when a user types "help") ──

const HELP_MESSAGE =
  "🎉 Never forget a birthday or anniversary again.\n\n" +
  "There are only 4 simple commands:\n\n" +
  "1. Save a birthday or anniversary\n" +
  "→ Papa 29 Aug\n" +
  "→ Mom 9 Feb anniversary\n\n" +
  "2. Delete an entry\n" +
  "→ delete mom\n\n" +
  "3. See your complete list\n" +
  "→ complete list\n\n" +
  "4. Need help?\n" +
  "→ help\n\n" +
  "Questions or feedback? Just message us at +91 87690 10233.\n\n" +
  "That's it. 😊";

// ── Onboarding messages ──

const ONBOARDING_INTRO =
  "Hi! 👋 Welcome to the WhatsApp Birthday and Anniversary Reminder 🎂💍";

const ONBOARDING_ASK_OWN_BIRTHDAY =
  "Let's start with the most important one — yours 😉\n\n" +
  "Add your own birthday first so we never forget to remind you.\n\n" +
  "Type it like this 👇\n" +
  "Name 29 Aug\n\n" +
  "Go on. Lock it in 🎉";

const ONBOARDING_STEP_1 = ONBOARDING_INTRO + "\n\n" + ONBOARDING_ASK_OWN_BIRTHDAY;

const ONBOARDING_STEP_2_BODY =
  "Now add at least two people you absolutely cannot forget:\n\n" +
  "• Husband / Wife 💍\n" +
  "• Brother / Sister 👨‍👩‍👧‍👦\n" +
  "• Kids 👶\n" +
  "• Parents ❤️\n\n" +
  "Just type:\n" +
  "Name 14 Feb\n\n" +
  "Add two now. Future-you will be grateful 😄";

const ONBOARDING_COMPLETE_BODY =
  "From today, you're officially someone who never misses important birthdays or anniversaries.\n\n" +
  "We'll remind you before the big day so you're always prepared 🎂💍\n\n" +
  "Type *help* anytime to see everything the bot can do.\n\n" +
  "We're so glad you've joined us 💛\n" +
  "Now relax — we've got you covered.";

// Honest fallbacks when we give up on a step after repeated parse failures —
// these must not claim anything was saved.
const STEP_1_GIVE_UP =
  "No worries — you can add your own birthday anytime by typing *Name 29 Aug* 😊";

const STEP_2_GIVE_UP =
  "That's okay — you can add birthdays and anniversaries anytime. Just type:\n" +
  "*Name 14 Feb*\n\n" +
  "Type *help* to see everything the bot can do. We're glad you're here 💛";

const NUDGE_MESSAGES = {
  1: "Go ahead — just type your name and birthday like this: *Name 29 Aug* 😊",
  2: "Don't stop now! Add at least two people close to you. Just type:\n*Name 14 Feb* 💪"
};

// ── Stale onboarding threshold (minutes) ──
const STALE_ONBOARDING_MINUTES = 30;

// ───────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────

// Called for every incoming message – returns true only for brand-new users
async function handleOnboarding(phone, message) {
  const wasCreated = await onboardUser(phone);
  if (!wasCreated) return false;

  // The very first message often already contains an entry (e.g.
  // "19 October - Ankit Singh"). Save it instead of silently dropping it.
  // We can't know whose it is, so it is NOT stored as the user's own name.
  let saved = [];
  try {
    saved = await parseAndSaveEntries(phone, message || '', false);
  } catch (err) {
    console.error('[ONBOARDING] Failed to parse first message:', err.message);
  }

  const firstDate = saved.length === 0 ? extractDayAndMonth(message || '') : null;
  let welcome;

  if (saved.length > 0) {
    welcome = ONBOARDING_INTRO + "\n\n" +
      "I've already saved what you sent 🎉\n" + formatEntryLines(saved) + "\n\n" +
      ONBOARDING_ASK_OWN_BIRTHDAY;
  } else if (firstDate) {
    await setPendingAction(phone, {
      intent: 'save',
      event_type: detectEventType(message),
      name: null,
      day: firstDate.day,
      month: firstDate.month,
      missing_field: 'name',
      source: 'onboarding',
      created_at: new Date().toISOString()
    });
    welcome = ONBOARDING_INTRO + "\n\n" +
      `Got the date — ${firstDate.day} ${firstDate.month} 🎂 But I still need your name to save it.\n\n` +
      "Just reply with your name 😊";
  } else {
    welcome = ONBOARDING_STEP_1;
  }

  await sendWhatsAppMessage(phone, welcome);
  console.log("MONITOR_EVENT: NEW_REGISTRATION");
  return true;
}

// Returns true if the user is in an active onboarding step (1-2).
// Automatically abandons stale onboarding (>30 min old).
async function isInOnboarding(phone) {
  const state = await getOnboardingState(phone);
  if (!state || state.onboarding_step === 0) return false;

  // Abandon if stale
  if (state.onboarding_last_sent_at) {
    const minutesSince = (Date.now() - new Date(state.onboarding_last_sent_at).getTime()) / (1000 * 60);
    if (minutesSince > STALE_ONBOARDING_MINUTES) {
      await completeOnboarding(phone);
      return false;
    }
  }
  return true;
}

// Process the user's response during onboarding.
// Advances to the next step only when an entry was actually saved; otherwise
// re-prompts once (remembering a partial date if there was one) and, on a
// second consecutive failure, moves on with an honest message.
// Returns true if handled, false if user is not in onboarding.
async function handleOnboardingResponse(phone, message) {
  const state = await getOnboardingState(phone);
  if (!state || state.onboarding_step === 0) return false;

  const step = state.onboarding_step;
  const isOwnBirthdayStep = step === 1;

  // If our previous re-prompt asked for a missing name and this reply carries
  // no date of its own, treat the reply as that name and finish the save.
  const pending = await getPendingAction(phone);
  const awaitingName =
    pending && pending.source === 'onboarding' && pending.missing_field === 'name';

  let saved = [];

  if (awaitingName && !extractDayAndMonth(message)) {
    const name = extractNameReply(message);
    if (name) {
      const entry = await saveEntryIfNew(
        phone, name, pending.day, pending.month, pending.event_type || 'birthday'
      );
      if (isOwnBirthdayStep) {
        await setUserName(phone, name);
      }
      saved.push(entry);
    }
  }

  if (saved.length === 0) {
    saved = await parseAndSaveEntries(phone, message, isOwnBirthdayStep);
  }

  if (saved.length > 0) {
    await clearPendingAction(phone);
    await advanceStep(phone, step, saved);
    return true;
  }

  // Nothing was saved — never confirm or advance blindly.
  if (state.onboarding_parse_failures >= 1) {
    // Second consecutive miss: don't hold the user hostage, move on honestly.
    await clearPendingAction(phone);
    if (isOwnBirthdayStep) {
      await setOnboardingStep(phone, 2);
      await sendWhatsAppMessage(phone, STEP_1_GIVE_UP + "\n\n" + ONBOARDING_STEP_2_BODY);
    } else {
      await completeOnboarding(phone);
      await sendWhatsAppMessage(phone, STEP_2_GIVE_UP);
    }
    return true;
  }

  // First miss: re-prompt within the same step, tailored to what we understood.
  await recordOnboardingReprompt(phone);

  const dateOnly = extractDayAndMonth(message);
  if (dateOnly) {
    // A date arrived without a name (e.g. "29 september") — remember it so
    // the user only has to reply with the name.
    const eventType = detectEventType(message);
    await setPendingAction(phone, {
      intent: 'save',
      event_type: eventType,
      name: null,
      day: dateOnly.day,
      month: dateOnly.month,
      missing_field: 'name',
      source: 'onboarding',
      created_at: new Date().toISOString()
    });
    const reprompt = isOwnBirthdayStep
      ? `Got the date — ${dateOnly.day} ${dateOnly.month} 🎂 But I still need your name to save it.\n\nJust reply with your name 😊`
      : `Got the date — ${dateOnly.day} ${dateOnly.month} 🎉 Whose ${eventType} is it?\n\nJust reply with their name 😊`;
    await sendWhatsAppMessage(phone, reprompt);
  } else {
    const example = isOwnBirthdayStep ? "Name 29 Aug" : "Name 14 Feb";
    const what = isOwnBirthdayStep ? "your name and birthday" : "the name and date";
    await sendWhatsAppMessage(
      phone,
      `Hmm, I couldn't quite catch that 😅\n\nType ${what} together, like this 👇\n${example}`
    );
  }

  return true;
}

// Send help message (for existing users who type "help")
async function sendHelpMessage(phone) {
  await sendWhatsAppMessage(phone, HELP_MESSAGE);
}

// ───────────────────────────────────────────────
// Internal helpers
// ───────────────────────────────────────────────

// Advance to the next step, echoing exactly what was saved so the user can
// catch parsing mistakes.
async function advanceStep(phone, step, saved) {
  const savedLines = formatEntryLines(saved);

  switch (step) {
    case 1:
      await setOnboardingStep(phone, 2);
      await sendWhatsAppMessage(
        phone,
        `Perfect 🙌 Saved:\n${savedLines}\n\n` + ONBOARDING_STEP_2_BODY
      );
      break;
    case 2:
    case 3: // legacy: users mid-flow on removed step 3
      await completeOnboarding(phone);
      await sendWhatsAppMessage(
        phone,
        `You're all set 🙌✨ Saved:\n${savedLines}\n\n` + ONBOARDING_COMPLETE_BODY
      );
      break;
  }
}

function formatEntry(entry) {
  const suffix = entry.type === 'anniversary' ? ' (anniversary)' : '';
  const duplicateNote = entry.isNew === false ? ' — already saved 👍' : '';
  return `${entry.name} — ${entry.day} ${entry.month}${suffix}${duplicateNote}`;
}

function formatEntryLines(entries) {
  return entries.map(e => `• ${formatEntry(e)}`).join('\n');
}

function detectEventType(message) {
  return /\b(anniversary|anniv|wedding|marriage)\b/i.test(message)
    ? 'anniversary'
    : 'birthday';
}

// Interpret a reply to "what's the name?" as a bare name.
// Returns the cleaned name, or null if the reply doesn't look like one.
function extractNameReply(message) {
  const name = (message || '')
    .trim()
    .replace(/^(my name is|i am|i'm|it's|its|this is|name is)\s+/i, '')
    .replace(/[\s.!,]+$/g, '')
    .trim();
  if (!name || name.length > 60 || /\d/.test(name)) return null;
  return name;
}

// Save an entry unless an identical one already exists.
// isNew tells the caller whether a row was actually inserted, so duplicates
// can be labeled in the confirmation instead of silently skipped.
async function saveEntryIfNew(phone, name, day, month, type) {
  const exists = await birthdayExists(phone, name, day, month, type);
  if (!exists) {
    await saveBirthday(phone, name, day, month, type);
  }
  return { name, day, month, type, isNew: !exists };
}

// Parse birthday entries from the message and save them.
// If saveFirstNameAsUser is true, the first successfully parsed name is also
// stored as the user's own name (for step 1).
async function parseAndSaveEntries(phone, message, saveFirstNameAsUser) {
  const lines = message.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const saved = [];

  for (const line of lines) {
    const result = await parseSingleEntry(phone, line);
    if (result) {
      const alreadyIncluded = saved.some(entry =>
        entry.name.toLowerCase() === result.name.toLowerCase() &&
        entry.day === result.day &&
        entry.month.toLowerCase() === result.month.toLowerCase() &&
        entry.type === result.type
      );
      if (!alreadyIncluded) {
        saved.push(result);
      }
      if (saveFirstNameAsUser) {
        await setUserName(phone, result.name);
        saveFirstNameAsUser = false; // only save the first name
      }
    }
  }

  // If nothing was parsed, try the LLM as a fallback
  // (handles natural-language like "my birthday is 22 Feb")
  if (saved.length === 0) {
    const llmResult = await tryLLMParse(phone, message, saveFirstNameAsUser);
    if (llmResult) {
      saved.push(llmResult);
    }
  }

  return saved;
}

// Parse a single "Name DD Mon" line using the fast regex-based date parser.
// Returns { name, day, month, type } on success, null on failure.
async function parseSingleEntry(phone, line) {
  const parsed = parseNameAndDate(line);
  if (!parsed) return null;

  const { name, day, month } = parsed;
  const normalizedMonth = normalizeMonthToShort(month);
  if (!normalizedMonth) return null;

  // Detect event type from keywords in the line
  const type = detectEventType(line);

  // The event-type keyword is not part of the name ("Mom 9 Feb anniversary"
  // should be saved as "Mom", not "Mom anniversary")
  const cleanName = cleanEventName(name);
  if (!cleanName) return null;

  return saveEntryIfNew(phone, cleanName, day, normalizedMonth, type);
}

// LLM fallback for when the simple parser can't handle the input
async function tryLLMParse(phone, message, saveNameAsUser) {
  try {
    const parsed = await parseIntentWithLLM(message);
    if (parsed.intent === 'save' && parsed.name && parsed.day && parsed.month) {
      const type = parsed.event_type || 'birthday';
      const normalizedMonth = normalizeMonthToShort(parsed.month) || parsed.month;
      const cleanName = cleanEventName(parsed.name);
      if (!cleanName) return null;

      const entry = await saveEntryIfNew(phone, cleanName, parsed.day, normalizedMonth, type);

      if (saveNameAsUser) {
        await setUserName(phone, cleanName);
      }

      return entry;
    }
  } catch (err) {
    console.error('[ONBOARDING] LLM fallback parse failed:', err.message);
  }
  return null;
}

// ───────────────────────────────────────────────

module.exports = {
  handleOnboarding,
  isInOnboarding,
  handleOnboardingResponse,
  sendHelpMessage,
  NUDGE_MESSAGES
};
