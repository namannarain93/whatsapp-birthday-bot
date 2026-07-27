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
function createHarness() {
  const sent = [];
  const savedBirthdays = [];
  const intents = [];
  const calls = { completeOnboarding: 0 };

  const explicitDb = {
    onboardUser: async () => false, // user already exists
    getOnboardingState: async () => ({
      onboarding_step: 2,
      onboarding_last_sent_at: new Date(),
      onboarding_nudge_count: 0,
      onboarding_parse_failures: 0
    }),
    getPendingAction: async () => null,
    birthdayExists: async () => false,
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
    parseIntentWithLLM: async () => ({ intent: 'unknown' }),
    generateScopedBirthdayBotReply: async () => 'fallback',
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
