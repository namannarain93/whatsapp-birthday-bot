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
