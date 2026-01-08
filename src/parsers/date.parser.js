// Date parsing utilities for flexible birthday input formats

const { normalizeMonthToShort } = require('../utils/month.utils');

// Parse flexible "name + date" messages into { name, day, month }
function parseNameAndDate(message) {
  if (!message || !message.trim()) return null;

  const original = message;
  const lower = message.toLowerCase();

  let day = null;
  let monthShort = null;
  let working = original;

  // 1) Look for numeric date formats like "14/12" or "14-12"
  const numericMatch = lower.match(/\b(\d{1,2})[\/-](\d{1,2})\b/);
  if (numericMatch) {
    const d = parseInt(numericMatch[1], 10);
    const m = parseInt(numericMatch[2], 10);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      day = d;
      monthShort = normalizeMonthToShort(m.toString());
      if (!monthShort) return null;
      const re = new RegExp(numericMatch[0], 'i');
      working = working.replace(re, ' ');
    }
  }

  // 2) Look for month words like "Dec", "December" if month not yet found
  if (!monthShort) {
    const monthWordRegex =
      /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
    const monthWordMatch = lower.match(monthWordRegex);
    if (monthWordMatch) {
      monthShort = normalizeMonthToShort(monthWordMatch[1]);
      if (!monthShort) return null;
      const re = new RegExp(monthWordMatch[0], 'i');
      working = working.replace(re, ' ');
    }
  }

  // 3) Look for a standalone day like "14", "14th", "1st" if day not yet found
  if (day == null) {
    const dayRegex = /\b(\d{1,2})(st|nd|rd|th)?\b/;
    const dayMatch = lower.match(dayRegex);
    if (dayMatch) {
      const d = parseInt(dayMatch[1], 10);
      if (d >= 1 && d <= 31) {
        day = d;
        const re = new RegExp(dayMatch[0], 'i');
        working = working.replace(re, ' ');
      }
    }
  }

  if (day == null || !monthShort) {
    return null;
  }

  // Whatever remains (minus commas and extra spaces) is treated as the name
  const name = working.replace(/[,]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) return null;

  return { name, day, month: monthShort };
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
  extractNamesFromDeleteInput
};

