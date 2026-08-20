const test = require('node:test');
const assert = require('node:assert/strict');

function inject(modulePath, exports) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports
  };
}

// Loads the real controller (and its real service dependencies) against
// mocked db.js / whatsapp.service / llm.js modules.
function createHarness(overrides = {}) {
  const sent = [];
  const savedBirthdays = [];
  const intents = [];
  const calls = { completeOnboarding: 0 };

  const explicitDb = {
    onboardUser: async () => false, // user already exists
    getOnboardingState: async () => overrides.onboardingState || ({
      onboarding_step: 2,
      onboarding_last_sent_at: new Date(),
      onboarding_nudge_count: 0,
      onboarding_parse_failures: 0
    }),
    getPendingAction: async () => null,
    birthdayExists: async () => false,
    getAllBirthdays: async () => [],
    saveBirthday: async (phone, name, day, month, type) => {
      savedBirthdays.push({ phone, name, day, month, type });
    },
    updateMessageIntent: async (wamid, intent) => {
      intents.push(intent);
    },
    completeOnboarding: async () => {
      calls.completeOnboarding += 1;
    }
  };
  // Any db function not listed above becomes an async no-op.
  const db = new Proxy(explicitDb, {
    get: (target, prop) => target[prop] || (async () => undefined)
  });

  inject('../db.js', db);
  inject('../src/services/whatsapp.service.js', {
    sendWhatsAppMessage: async (phone, message) => {
      sent.push(message);
    },
    safeRewrite: async message => message
  });
  inject('../llm.js', {
    parseIntentWithLLM: overrides.parseIntentWithLLM || (async () => ({ intent: 'unknown' })),
    generateScopedBirthdayBotReply: overrides.generateScopedBirthdayBotReply || (async () => 'fallback'),
    searchNameWithLLM: async () => null
  });

  // Reload the real modules so they bind to the mocks above.
  for (const mod of [
    '../src/parsers/multiline.parser',
    '../src/services/birthday.service',
    '../src/services/onboarding.service',
    '../src/controllers/message.controller'
  ]) {
    delete require.cache[require.resolve(mod)];
  }
  const { handleIncomingMessage } = require('../src/controllers/message.controller');

  async function webhook(text) {
    const req = {
      body: {
        entry: [{
          changes: [{
            value: {
              metadata: { phone_number_id: 'test-number' },
              messages: [{ from: '911234567890', id: 'wamid.test', text: { body: text } }]
            }
          }]
        }]
      }
    };
    const res = { sendStatus: () => {} };
    await handleIncomingMessage(req, res);
  }

  return { sent, savedBirthdays, intents, calls, webhook };
}

test('a message containing "help" mid-onboarding is parsed, not hijacked', async () => {
  const { sent, savedBirthdays, intents, webhook } = createHarness();

  await webhook('help me save Papa 29 Aug');

  assert.equal(intents.at(-1), 'onboarding_response');
  assert.deepEqual(savedBirthdays[0], {
    phone: '911234567890',
    name: 'Papa',
    day: 29,
    month: 'Aug',
    type: 'birthday'
  });
  assert.match(sent[0], /Papa — 29 Aug/);
  assert.doesNotMatch(sent[0], /4 simple commands/);
});

test('a bare "help" mid-onboarding still shows the help menu', async () => {
  const { sent, savedBirthdays, intents, calls, webhook } = createHarness();

  await webhook('help');

  assert.equal(intents.at(-1), 'help');
  assert.match(sent[0], /4 simple commands/);
  assert.equal(savedBirthdays.length, 0);
  assert.equal(calls.completeOnboarding, 0);
});

test('age in reminders is a general yes — no name, no missing-year, no real date example', async () => {
  let scopedCalls = 0;
  const { sent, intents, webhook } = createHarness({
    onboardingState: {
      onboarding_step: 0,
      onboarding_last_sent_at: null,
      onboarding_nudge_count: 0,
      onboarding_parse_failures: 0
    },
    parseIntentWithLLM: async () => ({ intent: 'help' }),
    generateScopedBirthdayBotReply: async () => {
      scopedCalls += 1;
      return 'Kalyani Kala 27 Aug 1997';
    }
  });

  await webhook('Can you tell me age also when reminding of upcoming birthday');

  assert.equal(sent.length, 1);
  assert.equal(sent[0], 'Yes — if a year is saved, reminders include age.');
  assert.equal(intents.at(-1), 'capability');
  assert.equal(scopedCalls, 0);
  assert.doesNotMatch(sent[0], /Kalyani|1997|I don't have/i);
});

test('how old is X is not treated as an age-in-reminders capability question', async () => {
  const { sent, webhook } = createHarness({
    onboardingState: {
      onboarding_step: 0,
      onboarding_last_sent_at: null,
      onboarding_nudge_count: 0,
      onboarding_parse_failures: 0
    },
    parseIntentWithLLM: async () => ({
      intent: 'search',
      query: 'Kalyani',
      wants_age: true
    }),
    generateScopedBirthdayBotReply: async () => 'fallback'
  });

  await webhook('how old is Kalyani');

  assert.notEqual(sent[0], 'Yes — if a year is saved, reminders include age.');
});

test('"what can you do" still shows the command menu', async () => {
  const { sent, webhook } = createHarness({
    onboardingState: {
      onboarding_step: 0,
      onboarding_last_sent_at: null,
      onboarding_nudge_count: 0,
      onboarding_parse_failures: 0
    },
    parseIntentWithLLM: async () => ({ intent: 'help' })
  });

  await webhook('what can you do');

  assert.match(sent[0], /4 simple commands/);
});
