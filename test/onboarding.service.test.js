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

function createHarness() {
  const users = new Map();
  const birthdays = [];
  const sent = [];

  const db = {
    onboardUser: async phone => {
      if (users.has(phone)) return false;
      users.set(phone, {
        step: 1,
        parseFailures: 0,
        pending: null,
        name: null,
        lastSentAt: new Date()
      });
      return true;
    },
    saveBirthday: async (phone, name, day, month, type, year = null, relationship = null) => {
      birthdays.push({ phone, name, day, month, type, year, relationship });
    },
    birthdayExists: async (phone, name, day, month, type) =>
      birthdays.some(entry =>
        entry.phone === phone &&
        entry.name.toLowerCase() === name.toLowerCase() &&
        entry.day === day &&
        entry.month.toLowerCase() === month.toLowerCase() &&
        entry.type === type
      ),
    updateBirthdayDetails: async (phone, name, day, month, type, details) => {
      const entry = birthdays.find(item =>
        item.phone === phone &&
        item.name.toLowerCase() === name.toLowerCase() &&
        item.day === day &&
        item.month.toLowerCase() === month.toLowerCase() &&
        item.type === type
      );
      if (!entry) return false;
      if (details.year != null) entry.year = details.year;
      if (details.relationship != null) entry.relationship = details.relationship;
      return true;
    },
    setUserName: async (phone, name) => {
      users.get(phone).name = name;
    },
    getOnboardingState: async phone => {
      const user = users.get(phone);
      if (!user) return null;
      return {
        onboarding_step: user.step,
        onboarding_last_sent_at: user.lastSentAt,
        onboarding_nudge_count: 0,
        onboarding_parse_failures: user.parseFailures
      };
    },
    setOnboardingStep: async (phone, step) => {
      const user = users.get(phone);
      user.step = step;
      user.parseFailures = 0;
      user.lastSentAt = new Date();
    },
    recordOnboardingReprompt: async phone => {
      const user = users.get(phone);
      user.parseFailures += 1;
      user.lastSentAt = new Date();
    },
    completeOnboarding: async phone => {
      users.get(phone).step = 0;
    },
    getPendingAction: async phone => users.get(phone).pending,
    setPendingAction: async (phone, action) => {
      users.get(phone).pending = action;
    },
    clearPendingAction: async phone => {
      users.get(phone).pending = null;
    }
  };

  inject('../db.js', db);
  inject('../src/services/whatsapp.service.js', {
    sendWhatsAppMessage: async (phone, message) => {
      sent.push({ phone, message });
    }
  });
  inject('../llm.js', {
    parseIntentWithLLM: async () => ({ intent: 'unknown' })
  });

  const servicePath = require.resolve('../src/services/onboarding.service');
  delete require.cache[servicePath];
  const service = require(servicePath);

  async function receive(phone, message) {
    sent.length = 0;
    const isNew = await service.handleOnboarding(phone, message);
    if (!isNew && await service.isInOnboarding(phone)) {
      await service.handleOnboardingResponse(phone, message);
    }
    return sent.map(item => item.message);
  }

  return { users, birthdays, receive };
}

test('preserves the first entry and resolves a date-only onboarding reply', async () => {
  const { users, birthdays, receive } = createHarness();
  const phone = '911111111111';

  let replies = await receive(phone, '19 October - Ankit Singh');
  assert.match(replies[0], /already saved what you sent/i);
  assert.deepEqual(birthdays[0], {
    phone,
    name: 'Ankit Singh',
    day: 19,
    month: 'Oct',
    type: 'birthday',
    year: null,
    relationship: null
  });

  replies = await receive(phone, '29 september');
  assert.match(replies[0], /still need your name/i);
  assert.equal(users.get(phone).step, 1);
  assert.equal(birthdays.length, 1);

  replies = await receive(phone, 'Naman');
  assert.match(replies[0], /Naman — 29 Sep/);
  assert.equal(users.get(phone).name, 'Naman');
  assert.equal(users.get(phone).step, 2);
});

test('preserves a date-only first message for the name follow-up', async () => {
  const { users, birthdays, receive } = createHarness();
  const phone = '955555555555';

  let replies = await receive(phone, '22 Feb');
  assert.match(replies[0], /still need your name/i);
  assert.equal(users.get(phone).pending.day, 22);
  assert.equal(users.get(phone).pending.month, 'Feb');

  replies = await receive(phone, 'Arjun');
  assert.match(replies[0], /Arjun — 22 Feb/);
  assert.equal(birthdays[0].name, 'Arjun');
  assert.equal(users.get(phone).step, 2);
});

test('completes step two after a single saved entry', async () => {
  const { users, receive } = createHarness();
  const phone = '922222222222';

  await receive(phone, 'hello');
  await receive(phone, 'Priya 12 Mar');

  const replies = await receive(phone, 'Husband 19 October');
  assert.match(replies[0], /You're all set/);
  assert.match(replies[0], /Husband — 19 Oct/);
  assert.equal(users.get(phone).step, 0);
});

test('labels duplicate entries instead of silently skipping them', async () => {
  const { users, birthdays, receive } = createHarness();
  const phone = '966666666666';

  await receive(phone, 'hello');
  await receive(phone, 'Priya 12 Mar');
  birthdays.push({ phone, name: 'Husband', day: 19, month: 'Oct', type: 'birthday' });

  const replies = await receive(phone, 'Husband 19 October');
  assert.match(replies[0], /Husband — 19 Oct — already saved 👍/);
  assert.equal(birthdays.length, 2); // Priya + seeded Husband, no second row
  assert.equal(users.get(phone).step, 0);
});

test('preserves anniversary type while resolving a date-only reply', async () => {
  const { users, birthdays, receive } = createHarness();
  const phone = '944444444444';

  await receive(phone, 'hello');
  await receive(phone, 'Priya 12 Mar');

  let replies = await receive(phone, '29 Sep anniversary');
  assert.match(replies[0], /Whose anniversary is it/i);
  assert.equal(users.get(phone).step, 2);

  replies = await receive(phone, 'Mom & Dad');
  assert.match(replies[0], /Mom & Dad — 29 Sep \(anniversary\)/);
  assert.equal(birthdays.at(-1).type, 'anniversary');
  assert.equal(users.get(phone).step, 0);
});

test('does not save self-reference filler as a name', async () => {
  const { users, birthdays, receive } = createHarness();
  const phone = '933333333333';

  await receive(phone, 'hi');
  const replies = await receive(phone, 'my birthday is 22 Feb');

  assert.equal(birthdays.length, 0);
  assert.equal(users.get(phone).step, 1);
  assert.match(replies[0], /still need your name/i);
});

test('stores recognized relationship and adjacent year separately during onboarding', async () => {
  const { birthdays, receive } = createHarness();
  const phone = '977777777777';

  await receive(phone, 'Krithika wife 27 Dec 1990');

  assert.deepEqual(birthdays[0], {
    phone,
    name: 'Krithika',
    day: 27,
    month: 'Dec',
    type: 'birthday',
    year: 1990,
    relationship: 'wife'
  });
});

test('backfills details when an onboarding save matches an existing event', async () => {
  const { birthdays, receive } = createHarness();
  const phone = '988888888888';
  birthdays.push({
    phone,
    name: 'Shreyas',
    day: 22,
    month: 'Aug',
    type: 'birthday',
    year: null,
    relationship: null
  });

  await receive(phone, 'Shreyas 1995 - August 22');

  assert.equal(birthdays.length, 1);
  assert.equal(birthdays[0].year, 1995);
});
