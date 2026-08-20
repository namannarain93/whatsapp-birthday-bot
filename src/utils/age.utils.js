// Age / anniversary-count phrasing for reminders and confirmations.

const { normalizeMonthToShort, normalizeMonthToCanonical, getMonthOrderNumber } = require('./month.utils');

function nowInKolkata() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  }).formatToParts(new Date());
  const value = type => parseInt(parts.find(part => part.type === type).value, 10);
  return { year: value('year'), month: value('month'), day: value('day') };
}

// Age today in Asia/Kolkata, using the saved day/month/year.
// Returns null when the year is missing or the result is implausible.
function computeCurrentAge(year, day, month, today = nowInKolkata()) {
  if (!year || !day || !month) return null;
  const monthNum = getMonthOrderNumber(normalizeMonthToCanonical(normalizeMonthToShort(month) || month));
  if (!monthNum || monthNum > 12) return null;

  let age = today.year - year;
  const birthdayReached = today.month > monthNum || (today.month === monthNum && today.day >= day);
  if (!birthdayReached) age -= 1;
  if (age < 0 || age > 120) return null;
  return age;
}

function isBirthdayToday(day, month, today = nowInKolkata()) {
  const monthNum = getMonthOrderNumber(normalizeMonthToCanonical(normalizeMonthToShort(month) || month));
  return monthNum === today.month && day === today.day;
}

// Returns a suffix like " (turns 31)" for birthdays or " (25 years)" for
// anniversaries, based on the stored birth/wedding year and the calendar year
// the event falls in. Returns '' when no year is saved or the number is
// implausible (bad data should never produce "turns 250").
function formatAgeSuffix(type, year, eventYear) {
  if (!year || !eventYear) return '';
  const n = eventYear - year;
  if (n < 1 || n > 120) return '';
  return type === 'anniversary' ? ` (${n} years)` : ` (turns ${n})`;
}

module.exports = { formatAgeSuffix, computeCurrentAge, isBirthdayToday, nowInKolkata };
