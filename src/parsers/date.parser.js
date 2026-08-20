// Date parsing utilities for flexible birthday input formats

const { normalizeMonthToShort } = require('../utils/month.utils');

const NAME_FILLER_WORDS = new Set([
  'birthday', 'birthdays', 'bday', 'bdays', 'anniversary', 'anniversaries',
  'anniv', 'wedding', 'marriage', 'of', 'on', 'is', 'for', 'save', 'add',
  'remind', 'set', 'my', 'me', 'i', 'mine', 'myself', 'name', 'am', 'this',
  "it's", 'its', 'help', 'please'
]);

// Intentionally conservative: these are relationship labels, not honorifics
// such as Amma/Appa/Didi/Bhai, which are commonly part of a person's name.
const RELATIONSHIP_LABELS = new Set([
  'mother', 'mom', 'mum', 'father', 'dad',
  'wife', 'husband', 'partner',
  'sister', 'brother', 'daughter', 'son',
  'aunt', 'aunty', 'uncle',
  'grandmother', 'grandma', 'grandfather', 'grandpa',
  'cousin',
  'friend', 'family friend', 'best friend',
  'colleague', 'coworker', 'neighbour', 'neighbor'
]);

function relationshipLabelsLongestFirst() {
  return [...RELATIONSHIP_LABELS].sort((a, b) => b.length - a.length);
}

function normalizeRelationship(value) {
  if (!value || typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return RELATIONSHIP_LABELS.has(normalized.toLowerCase()) ? normalized : null;
}

// Split only explicit, recognized relationship forms. Arbitrary slashes are
// preserved (e.g. "AC/DC"), and a relationship word on its own remains a name
// ("Mom 14 Dec"). Supported forms include "Name / Mom", "Name wife", and
// "my sister Name".
function splitRelationshipFromName(value) {
  const original = (value || '').replace(/\s+/g, ' ').trim();
  if (!original) return { name: '', relationship: null };

  const slashParts = original.split('/');
  if (slashParts.length === 2) {
    const left = slashParts[0].trim();
    const relationship = normalizeRelationship(slashParts[1]);
    if (left && relationship) return { name: left, relationship };
  }

  for (const label of relationshipLabelsLongestFirst()) {
    const prefix = original.match(new RegExp(`^my\\s+(${label})\\s+(.+)$`, 'i'));
    if (prefix) {
      const relationship = normalizeRelationship(prefix[1]);
      const name = prefix[2].trim();
      if (relationship && name) return { name, relationship };
    }
  }

  for (const label of relationshipLabelsLongestFirst()) {
    const trailing = original.match(new RegExp(`^(.+?)\\s+(${label})$`, 'i'));
    if (trailing) {
      const name = trailing[1].trim();
      const relationship = normalizeRelationship(trailing[2]);
      if (name && relationship) return { name, relationship };
    }
  }

  return { name: original, relationship: null };
}

function intervalDistance(aStart, aLength, bStart, bLength) {
  const aEnd = aStart + aLength;
  const bEnd = bStart + bLength;
  if (aEnd < bStart) return bStart - aEnd;
  if (bEnd < aStart) return aStart - bEnd;
  return 0;
}

// A 4-digit number is considered a year only when it is close to the date
// token in the full message ("5 Aug 1990", "1995 - August 22"). This avoids
// stripping arbitrary numbers embedded in names such as "Studio 2000".
function findLikelyEventYear(message) {
  const currentYear = new Date().getFullYear();
  const yearMatches = [...message.matchAll(/\b(19\d{2}|20\d{2})\b/g)];
  const monthMatch = message.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i
  );
  const numericDateMatch = message.match(/\b\d{1,2}[\/-]\d{1,2}\b/);
  const dateMatch = monthMatch || numericDateMatch;
  if (!dateMatch) return null;

  for (const match of yearMatches) {
    const year = parseInt(match[1], 10);
    if (year < 1900 || year > currentYear) continue;
    const distance = intervalDistance(
      match.index,
      match[0].length,
      dateMatch.index,
      dateMatch[0].length
    );
    // Allows a day plus light punctuation between month and year.
    if (distance <= 6) return { year, index: match.index, length: match[0].length };
  }
  return null;
}

// Remove instruction/event words left behind after date extraction while
// preserving the original casing and meaningful name tokens.
function cleanEventName(name) {
  if (!name) return '';
  return name
    .split(/\s+/)
    .filter(token => token && !NAME_FILLER_WORDS.has(token.toLowerCase()))
    .join(' ')
    .trim();
}

// Find a day + month anywhere in the message.
// Returns { day, month, year, remainder } where month is the short form ("Sep"),
// year is a 4-digit birth/wedding year when present (else null), and remainder
// is whatever text is left after removing the date tokens (may be empty, e.g.
// for a date-only message like "29 september"). Returns null when no complete
// date is present.
function extractDayAndMonth(message) {
  if (!message || !message.trim()) return null;

  let working = message;
  let day = null;
  let monthShort = null;
  let year = null;

  // Remove a matched token by position. Using the match index (instead of
  // String.replace, which hits the FIRST occurrence) prevents e.g. the day
  // "19" being carved out of the year "1989" in "Brindha 1989 - June 19".
  const spliceOut = (str, index, length) =>
    `${str.slice(0, index)} ${str.slice(index + length)}`;

  // Identify the year against the original message before token positions move.
  const likelyYear = findLikelyEventYear(message);

  // 1) Look for numeric date formats like "14/12" or "14-12"
  const numericMatch = working.toLowerCase().match(/\b(\d{1,2})[\/-](\d{1,2})\b/);
  if (numericMatch) {
    const d = parseInt(numericMatch[1], 10);
    const m = parseInt(numericMatch[2], 10);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      day = d;
      monthShort = normalizeMonthToShort(m.toString());
      if (!monthShort) return null;
      working = spliceOut(working, numericMatch.index, numericMatch[0].length);
    }
  }

  // 2) Pull out a 4-digit birth/wedding year ("Shreyas 1995 - August 22")
  // BEFORE day matching, so it never leaks into the name or the day.
  if (likelyYear) {
    const yearMatch = working.match(new RegExp(`\\b${likelyYear.year}\\b`));
    if (yearMatch) {
      year = likelyYear.year;
      working = spliceOut(working, yearMatch.index, yearMatch[0].length);
    }
  }

  // 3) Look for month words like "Dec", "December" if month not yet found
  if (!monthShort) {
    const monthWordRegex =
      /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
    const monthWordMatch = working.toLowerCase().match(monthWordRegex);
    if (monthWordMatch) {
      monthShort = normalizeMonthToShort(monthWordMatch[1]);
      if (!monthShort) return null;
      working = spliceOut(working, monthWordMatch.index, monthWordMatch[0].length);
    }
  }

  // 4) Look for a standalone day like "14", "14th", "1st" if day not yet found
  if (day == null) {
    const dayMatch = working.toLowerCase().match(/\b(\d{1,2})(st|nd|rd|th)?\b/);
    if (dayMatch) {
      const d = parseInt(dayMatch[1], 10);
      if (d >= 1 && d <= 31) {
        day = d;
        working = spliceOut(working, dayMatch.index, dayMatch[0].length);
      }
    }
  }

  if (day == null || !monthShort) {
    return null;
  }

  // Clean up the remainder: commas become spaces, and separator punctuation
  // left dangling at the edges (e.g. the dash in "19 October - Ankit Singh")
  // is stripped without touching hyphens inside names like "Anne-Marie".
  const remainder = working
    .replace(/[,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s,:–—-]+|[\s,:–—-]+$/g, '');

  return { day, month: monthShort, year, remainder };
}

// Parse flexible "name + date" messages into { name, day, month, year, relationship }.
// Relationships are split only through the conservative recognized-label rules
// above; arbitrary slashes and honorifics remain part of the name.
function parseNameAndDate(message) {
  const extracted = extractDayAndMonth(message);
  if (!extracted) return null;

  const { day, month, year, remainder } = extracted;
  if (!remainder) return null;

  const { name, relationship } = splitRelationshipFromName(remainder);
  if (!name) return null;

  return { name, day, month, year, relationship };
}

// Extract clean name(s) from delete input, stripping dates and formatting
// Handles cases like:
// - "21 – Abcd Bcda, Jun 2, Kpcd, Jan 3" → ["Abcd Bcda", "Kpcd"]
// - "Abcd Bcda" → ["Abcd Bcda"]
// - "delete Abcd Bcda, Kpcd" → ["Abcd Bcda", "Kpcd"]
function extractNamesFromDeleteInput(input) {
  if (!input || !input.trim()) return [];

  let cleaned = input.trim();

  // Remove date patterns like "21 –", "21-", "Jun 2", "June 2", "21/04", etc.
  cleaned = cleaned.replace(/\d{1,2}\s*[–-]\s*/g, ''); // "21 –" or "21-"
  cleaned = cleaned.replace(/\b\d{1,2}\s*[\/-]\s*\d{1,2}\b/g, ''); // "21/04" or "21-04"
  
  // Remove month-day patterns like "Jun 2", "June 2", "2 Jun"
  const monthPattern = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b/gi;
  cleaned = cleaned.replace(monthPattern, '');
  cleaned = cleaned.replace(/\b\d{1,2}\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi, '');

  // Split by comma and clean each part
  const parts = cleaned.split(',').map(p => p.trim()).filter(p => p.length > 0);
  
  // Further clean each part: remove any remaining date-like patterns
  return parts.map(part => {
    // Remove any remaining numbers that look like dates
    part = part.replace(/\b\d{1,2}\b/g, '').trim();
    // Remove extra spaces and clean up
    part = part.replace(/\s+/g, ' ').trim();
    return part;
  }).filter(p => p.length > 0);
}

module.exports = {
  parseNameAndDate,
  extractDayAndMonth,
  cleanEventName,
  extractNamesFromDeleteInput,
  normalizeRelationship,
  splitRelationshipFromName,
  findLikelyEventYear
};

