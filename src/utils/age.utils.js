// Age / anniversary-count phrasing for reminders and confirmations.

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

module.exports = { formatAgeSuffix };
