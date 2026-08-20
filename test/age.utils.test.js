const test = require('node:test');
const assert = require('node:assert/strict');

const { formatAgeSuffix } = require('../src/utils/age.utils');

test('formats birthday and anniversary years for the event year', () => {
  assert.equal(formatAgeSuffix('birthday', 1995, 2026), ' (turns 31)');
  assert.equal(formatAgeSuffix('anniversary', 2001, 2026), ' (25 years)');
});

test('omits missing and implausible ages', () => {
  assert.equal(formatAgeSuffix('birthday', null, 2026), '');
  assert.equal(formatAgeSuffix('birthday', 2026, 2026), '');
  assert.equal(formatAgeSuffix('birthday', 1800, 2026), '');
});

test('computes current age using whether the birthday has already happened', () => {
  const { computeCurrentAge } = require('../src/utils/age.utils');
  assert.equal(computeCurrentAge(1997, 27, 'Aug', { year: 2026, month: 8, day: 21 }), 28);
  assert.equal(computeCurrentAge(1997, 27, 'Aug', { year: 2026, month: 8, day: 27 }), 29);
  assert.equal(computeCurrentAge(1997, 27, 'Aug', { year: 2026, month: 8, day: 28 }), 29);
  assert.equal(computeCurrentAge(null, 27, 'Aug', { year: 2026, month: 8, day: 21 }), null);
});
