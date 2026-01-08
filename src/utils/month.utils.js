// Month normalization and ordering utilities

// Deterministic month order map using full month names (lowercase)
const MONTH_ORDER = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12
};

// Map various month spellings (short/full, any case) to canonical lowercase full name
const MONTH_CANONICAL = {
  jan: 'january',
  january: 'january',
  feb: 'february',
  february: 'february',
  mar: 'march',
  march: 'march',
  apr: 'april',
  april: 'april',
  may: 'may',
  jun: 'june',
  june: 'june',
  jul: 'july',
  july: 'july',
  aug: 'august',
  august: 'august',
  sep: 'september',
  sept: 'september',
  september: 'september',
  oct: 'october',
  october: 'october',
  nov: 'november',
  november: 'november',
  dec: 'december',
  december: 'december'
};

// Map canonical month (lowercase full) to short display form, e.g. "january" -> "Jan"
const CANONICAL_TO_SHORT = {
  january: 'Jan',
  february: 'Feb',
  march: 'Mar',
  april: 'Apr',
  may: 'May',
  june: 'Jun',
  july: 'Jul',
  august: 'Aug',
  september: 'Sep',
  october: 'Oct',
  november: 'Nov',
  december: 'Dec'
};

function normalizeMonthToCanonical(monthStr) {
  const key = (monthStr || '').toString().trim().toLowerCase();
  return MONTH_CANONICAL[key] || key;
}

function getMonthOrderNumber(canonicalMonth) {
  return MONTH_ORDER[canonicalMonth] || 99;
}

function toDisplayMonthName(canonicalMonth) {
  if (!canonicalMonth) return '';
  return canonicalMonth.charAt(0).toUpperCase() + canonicalMonth.slice(1);
}

// Normalize any month token (word or number) to a short month like "Jan"
function normalizeMonthToShort(token) {
  if (token == null) return null;
  const raw = token.toString().trim().toLowerCase();
  if (!raw) return null;

  // Numeric month, e.g. "1", "01", "12"
  if (/^\d{1,2}$/.test(raw)) {
    const num = parseInt(raw, 10);
    const canonical = Object.keys(MONTH_ORDER).find(
      key => MONTH_ORDER[key] === num
    );
    return canonical ? CANONICAL_TO_SHORT[canonical] : null;
  }

  // Word month (short or full)
  const canonical = MONTH_CANONICAL[raw];
  if (!canonical) return null;
  return CANONICAL_TO_SHORT[canonical] || null;
}

function getCurrentMonthName() {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                  'July', 'August', 'September', 'October', 'November', 'December'];
  const now = new Date();
  return months[now.getMonth()];
}

function getCurrentMonthAbbrev() {
  const abbrevs = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const now = new Date();
  return abbrevs[now.getMonth()];
}

// Extract month from text message (returns canonical short form or null)
// Handles: "march", "March", "Mar", "3", etc.
function extractMonthFromText(message) {
  if (!message || !message.trim()) return null;
  
  const lower = message.toLowerCase();
  
  // Look for month words (short or full)
  const monthWordRegex =
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
  const monthWordMatch = lower.match(monthWordRegex);
  if (monthWordMatch) {
    const normalized = normalizeMonthToShort(monthWordMatch[1]);
    if (normalized) {
      console.log(`[MONTH EXTRACTION] Found month "${monthWordMatch[1]}" → normalized to "${normalized}"`);
      return normalized;
    }
  }
  
  // Look for numeric month (1-12)
  const numericMatch = lower.match(/\b(\d{1,2})\b/);
  if (numericMatch) {
    const num = parseInt(numericMatch[1], 10);
    if (num >= 1 && num <= 12) {
      const normalized = normalizeMonthToShort(num.toString());
      if (normalized) {
        console.log(`[MONTH EXTRACTION] Found numeric month "${num}" → normalized to "${normalized}"`);
        return normalized;
      }
    }
  }
  
  console.log(`[MONTH EXTRACTION] No month found in message: "${message}"`);
  return null;
}

module.exports = {
  MONTH_ORDER,
  MONTH_CANONICAL,
  CANONICAL_TO_SHORT,
  normalizeMonthToCanonical,
  getMonthOrderNumber,
  toDisplayMonthName,
  normalizeMonthToShort,
  getCurrentMonthName,
  getCurrentMonthAbbrev,
  extractMonthFromText
};

