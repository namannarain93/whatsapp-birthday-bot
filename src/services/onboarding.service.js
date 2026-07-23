// Multi-step onboarding service
// Step 1: Ask for their own birthday  →  Step 2: Inner circle  →  Completion

const {
  userExists,
  onboardUser,
  saveBirthday,
  birthdayExists,
  setUserName,
  getOnboardingState,
  setOnboardingStep,
  completeOnboarding
} = require('../../db.js');
const { sendWhatsAppMessage } = require('./whatsapp.service');
const { parseNameAndDate } = require('../parsers/date.parser');
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

const ONBOARDING_STEP_1 =
  "Hi! 👋 Welcome to the WhatsApp Birthday and Anniversary Reminder 🎂💍\n\n" +
  "Let's start with the most important one — yours 😉\n\n" +
  "Add your own birthday first so we never forget to remind you.\n\n" +
  "Type it like this 👇\n" +
  "Name 29 Aug\n\n" +
  "Go on. Lock it in 🎉";

const ONBOARDING_STEP_2 =
  "Perfect 🙌\n\n" +
  "Now add at least two people you absolutely cannot forget:\n\n" +
  "• Husband / Wife 💍\n" +
  "• Brother / Sister 👨‍👩‍👧‍👦\n" +
  "• Kids 👶\n" +
  "• Parents ❤️\n\n" +
  "Just type:\n" +
  "Name 14 Feb\n\n" +
  "Add two now. Future-you will be grateful 😄";

const ONBOARDING_COMPLETE =
  "You're all set 🙌✨\n\n" +
  "From today, you're officially someone who never misses important birthdays or anniversaries.\n\n" +
  "We'll remind you before the big day so you're always prepared 🎂💍\n\n" +
  "Type *help* anytime to see everything the bot can do.\n\n" +
  "We're so glad you've joined us 💛\n" +
  "Now relax — we've got you covered.";

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
async function handleOnboarding(phone) {
  const exists = await userExists(phone);
  if (!exists) {
    await onboardUser(phone);
    await setOnboardingStep(phone, 1);
    await sendWhatsAppMessage(phone, ONBOARDING_STEP_1);
    console.log("MONITOR_EVENT: NEW_REGISTRATION");
    return true;
  }
  return false;
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

// Process the user's response during onboarding, advance to the next step.
// Returns true if handled, false if user is not in onboarding.
async function handleOnboardingResponse(phone, message) {
  const state = await getOnboardingState(phone);
  if (!state || state.onboarding_step === 0) return false;

  const step = state.onboarding_step;

  // Parse and silently save any birthday entries in the message
  await parseAndSaveEntries(phone, message, step === 1);

  // Advance to next step
  switch (step) {
    case 1:
      await setOnboardingStep(phone, 2);
      await sendWhatsAppMessage(phone, ONBOARDING_STEP_2);
      break;
    case 2:
    case 3: // legacy: users mid-flow on removed step 3
      await completeOnboarding(phone);
      await sendWhatsAppMessage(phone, ONBOARDING_COMPLETE);
      break;
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

// Parse birthday entries from the message and save them.
// If saveFirstNameAsUser is true, the first successfully parsed name is also
// stored as the user's own name (for step 1).
async function parseAndSaveEntries(phone, message, saveFirstNameAsUser) {
  const lines = message.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const saved = [];

  for (const line of lines) {
    const result = await parseSingleEntry(phone, line);
    if (result) {
      saved.push(result);
      if (saveFirstNameAsUser) {
        await setUserName(phone, result.name);
        saveFirstNameAsUser = false; // only save the first name
      }
    }
  }

  // If nothing was parsed and it's a single-line message, try the LLM as a fallback
  // (handles natural-language like "my birthday is 22 Feb")
  if (saved.length === 0 && lines.length <= 1) {
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
  const lower = line.toLowerCase();
  const type = (lower.includes('anniversary') || lower.includes('anniv') ||
                lower.includes('wedding') || lower.includes('marriage'))
    ? 'anniversary' : 'birthday';

  const exists = await birthdayExists(phone, name.trim(), day, normalizedMonth, type);
  if (!exists) {
    await saveBirthday(phone, name.trim(), day, normalizedMonth, type);
  }

  return { name: name.trim(), day, month: normalizedMonth, type };
}

// LLM fallback for when the simple parser can't handle the input
async function tryLLMParse(phone, message, saveNameAsUser) {
  try {
    const parsed = await parseIntentWithLLM(message);
    if (parsed.intent === 'save' && parsed.name && parsed.day && parsed.month) {
      const type = parsed.event_type || 'birthday';
      const normalizedMonth = normalizeMonthToShort(parsed.month) || parsed.month;

      const exists = await birthdayExists(phone, parsed.name, parsed.day, normalizedMonth, type);
      if (!exists) {
        await saveBirthday(phone, parsed.name, parsed.day, normalizedMonth, type);
      }

      if (saveNameAsUser) {
        await setUserName(phone, parsed.name);
      }

      return { name: parsed.name, day: parsed.day, month: normalizedMonth, type };
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
