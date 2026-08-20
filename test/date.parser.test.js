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
    month: 'Oct',
    year: null,
    relationship: null
  });
});

test('extracts a date-only reply without inventing a name', () => {
  assert.equal(parseNameAndDate('29 september'), null);
  assert.deepEqual(extractDayAndMonth('29 september'), {
    day: 29,
    month: 'Sep',
    year: null,
    remainder: ''
  });
});

test('preserves hyphens inside names', () => {
  assert.deepEqual(parseNameAndDate('Anne-Marie 3 Jul'), {
    name: 'Anne-Marie',
    day: 3,
    month: 'Jul',
    year: null,
    relationship: null
  });
});

test('extracts a birth year instead of leaking it into the name', () => {
  assert.deepEqual(parseNameAndDate('Shreyas 1995 - August 22'), {
    name: 'Shreyas',
    day: 22,
    month: 'Aug',
    year: 1995,
    relationship: null
  });
});

test('does not carve the day out of a 4-digit year', () => {
  // Day regex matching "19" must not consume the "19" inside "1989"
  assert.deepEqual(parseNameAndDate('Brindha Sister 1989 - June 19'), {
    name: 'Brindha',
    day: 19,
    month: 'Jun',
    year: 1989,
    relationship: 'Sister'
  });
});

test('splits a slash-separated relationship out of the name', () => {
  assert.deepEqual(parseNameAndDate('Malathi Amma / Mom 1967 - May 27'), {
    name: 'Malathi Amma',
    day: 27,
    month: 'May',
    year: 1967,
    relationship: 'Mom'
  });
  assert.deepEqual(parseNameAndDate('Mohan Appa / Dad - October 7'), {
    name: 'Mohan Appa',
    day: 7,
    month: 'Oct',
    year: null,
    relationship: 'Dad'
  });
});

test('ignores implausible 4-digit numbers as years', () => {
  assert.deepEqual(parseNameAndDate('Flight 8888 crew party 5 Aug'), {
    name: 'Flight 8888 crew party',
    day: 5,
    month: 'Aug',
    year: null,
    relationship: null
  });
});

test('extracts only recognized relationship labels', () => {
  assert.deepEqual(parseNameAndDate('Krithika wife 27 Dec'), {
    name: 'Krithika',
    day: 27,
    month: 'Dec',
    year: null,
    relationship: 'wife'
  });
  assert.deepEqual(parseNameAndDate('my sister Brindha 19 June'), {
    name: 'Brindha',
    day: 19,
    month: 'Jun',
    year: null,
    relationship: 'sister'
  });
});

test('preserves arbitrary slash names and honorifics', () => {
  assert.deepEqual(parseNameAndDate('AC/DC 5 Aug'), {
    name: 'AC/DC',
    day: 5,
    month: 'Aug',
    year: null,
    relationship: null
  });
  assert.deepEqual(parseNameAndDate('Malathi Amma 27 May'), {
    name: 'Malathi Amma',
    day: 27,
    month: 'May',
    year: null,
    relationship: null
  });
});

test('extracts a plausible year only when it is adjacent to the date', () => {
  assert.deepEqual(parseNameAndDate('Studio 2000 team 5 Aug'), {
    name: 'Studio 2000 team',
    day: 5,
    month: 'Aug',
    year: null,
    relationship: null
  });
});

test('removes event and self-reference filler from parsed names', () => {
  assert.equal(cleanEventName('Mom anniversary'), 'Mom');
  assert.equal(cleanEventName('birthday of Rajan on'), 'Rajan');
  assert.equal(cleanEventName('my birthday is'), '');
});
