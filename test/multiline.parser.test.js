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

function createHarness(seed = []) {
  const birthdays = seed.map(item => ({ ...item }));

  inject('../db.js', {
    birthdayExists: async (phone, name, day, month, type = 'birthday') =>
      birthdays.some(entry =>
        entry.phone === phone &&
        entry.name.toLowerCase() === name.toLowerCase() &&
        entry.day === day &&
        entry.month.toLowerCase() === month.toLowerCase() &&
        entry.type === type
      ),
    saveBirthday: async (
      phone,
      name,
      day,
      month,
      type = 'birthday',
      year = null,
      relationship = null
    ) => {
      birthdays.push({ phone, name, day, month, type, year, relationship });
    },
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
    }
  });

  const parserPath = require.resolve('../src/parsers/multiline.parser');
  delete require.cache[parserPath];
  const { processMultilineMessage } = require(parserPath);
  return { birthdays, processMultilineMessage };
}

test('multiline saves separate recognized relationships and preserve arbitrary slashes', async () => {
  const { birthdays, processMultilineMessage } = createHarness();

  await processMultilineMessage(
    '911111111111',
    'Krithika wife 1990 27 Dec\nAC/DC 5 Aug'
  );

  assert.deepEqual(birthdays, [
    {
      phone: '911111111111',
      name: 'Krithika',
      day: 27,
      month: 'Dec',
      type: 'birthday',
      year: 1990,
      relationship: 'wife'
    },
    {
      phone: '911111111111',
      name: 'AC/DC',
      day: 5,
      month: 'Aug',
      type: 'birthday',
      year: null,
      relationship: null
    }
  ]);
});

test('multiline duplicate saves backfill newly supplied details', async () => {
  const phone = '922222222222';
  const { birthdays, processMultilineMessage } = createHarness([
    {
      phone,
      name: 'Shreyas',
      day: 22,
      month: 'Aug',
      type: 'birthday',
      year: null,
      relationship: null
    }
  ]);

  const reply = await processMultilineMessage(
    phone,
    'Shreyas 1995 - August 22\nMohan Appa / Dad - October 7'
  );

  assert.equal(birthdays.length, 2);
  assert.equal(birthdays[0].year, 1995);
  assert.deepEqual(birthdays[1], {
    phone,
    name: 'Mohan Appa',
    day: 7,
    month: 'Oct',
    type: 'birthday',
    year: null,
    relationship: 'Dad'
  });
  assert.match(reply, /extra details updated/);
});
