const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseNameAndDate,
  extractDayAndMonth,
  cleanEventName
} = require('../src/parsers/date.parser');

test('parses a date-first entry without retaining its separator', () => {
  assert.deepEqual(parseNameAndDate('19 October - Ankit Singh'), {
    name: 'Ankit Singh',
    day: 19,
    month: 'Oct'
  });
});

test('extracts a date-only reply without inventing a name', () => {
  assert.equal(parseNameAndDate('29 september'), null);
  assert.deepEqual(extractDayAndMonth('29 september'), {
    day: 29,
    month: 'Sep',
    remainder: ''
  });
});

test('preserves hyphens inside names', () => {
  assert.deepEqual(parseNameAndDate('Anne-Marie 3 Jul'), {
    name: 'Anne-Marie',
    day: 3,
    month: 'Jul'
  });
});

test('removes event and self-reference filler from parsed names', () => {
  assert.equal(cleanEventName('Mom anniversary'), 'Mom');
  assert.equal(cleanEventName('birthday of Rajan on'), 'Rajan');
  assert.equal(cleanEventName('my birthday is'), '');
});
