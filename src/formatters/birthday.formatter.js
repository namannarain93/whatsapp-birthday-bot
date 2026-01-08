// Birthday formatting and display logic

const {
  normalizeMonthToCanonical,
  getMonthOrderNumber,
  toDisplayMonthName
} = require('../utils/month.utils');

// Format birthdays list in chronological calendar order
function formatBirthdaysChronologically(birthdays) {
  if (!birthdays || birthdays.length === 0) {
    return '';
  }

  // First normalize each birthday's month to canonical form
  const normalized = birthdays.map(b => ({
    name: b.name,
    day: b.day,
    monthCanonical: normalizeMonthToCanonical(b.month)
  }));

  // Sort by month index then by day
  normalized.sort((a, b) => {
    const orderA = getMonthOrderNumber(a.monthCanonical);
    const orderB = getMonthOrderNumber(b.monthCanonical);
    if (orderA !== orderB) return orderA - orderB;
    return a.day - b.day;
  });

  // Group by canonical month
  const grouped = {};
  normalized.forEach(b => {
    const key = b.monthCanonical;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(b);
  });

  // Get months in true calendar order
  const orderedMonths = Object.keys(grouped).sort(
    (a, b) => getMonthOrderNumber(a) - getMonthOrderNumber(b)
  );

  // Build the final string
  let result = '🎂 BIRTHDAYS 🎂\n\n';
  orderedMonths.forEach(monthKey => {
    const label = toDisplayMonthName(monthKey);
    if (!label) return;
    result += `${label}\n`;
    grouped[monthKey].forEach(b => {
      result += `• ${b.day} – ${b.name}\n`;
    });
    result += '\n';
  });

  return result.trim();
}

module.exports = {
  formatBirthdaysChronologically
};

