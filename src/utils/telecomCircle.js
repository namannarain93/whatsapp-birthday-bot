// Maps phone numbers (WhatsApp wa_id format, e.g. '919876543210') to Indian
// telecom circles using the first 4 digits of the subscriber number.
// Circles are the region a number was *allocated* in — number portability and
// migration make this ~90% accurate, which is fine for dashboard distribution.
const PREFIX_CIRCLES = require('../data/mobile-prefix-circles.json');

// Circle code -> display name + [lng, lat] centroid for map placement.
const CIRCLES = {
  AP: { name: 'Andhra Pradesh & Telangana', coord: [79.5, 16.8] },
  AS: { name: 'Assam', coord: [92.9, 26.2] },
  BR: { name: 'Bihar & Jharkhand', coord: [85.6, 25.1] },
  CG: { name: 'Chhattisgarh', coord: [81.9, 21.3] },
  DL: { name: 'Delhi NCR', coord: [77.1, 28.6] },
  GJ: { name: 'Gujarat', coord: [71.7, 22.7] },
  HP: { name: 'Himachal Pradesh', coord: [77.3, 31.9] },
  HR: { name: 'Haryana', coord: [76.3, 29.2] },
  JK: { name: 'Jammu & Kashmir', coord: [74.9, 33.8] },
  KA: { name: 'Karnataka', coord: [76.2, 14.9] },
  KL: { name: 'Kerala', coord: [76.4, 10.5] },
  MH: { name: 'Maharashtra & Goa', coord: [75.7, 19.2] },
  MP: { name: 'Madhya Pradesh', coord: [78.3, 23.5] },
  NE: { name: 'North East', coord: [93.5, 25.0] },
  OR: { name: 'Odisha', coord: [84.4, 20.5] },
  PB: { name: 'Punjab', coord: [75.5, 31.0] },
  RJ: { name: 'Rajasthan', coord: [74.2, 26.6] },
  TN: { name: 'Tamil Nadu', coord: [78.4, 11.0] },
  UE: { name: 'UP East', coord: [82.5, 26.4] },
  UW: { name: 'UP West & Uttarakhand', coord: [78.6, 29.0] },
  WB: { name: 'West Bengal', coord: [88.0, 24.0] }
};

// Common non-Indian country calling codes (longest-prefix match, 3 -> 1 digits).
const COUNTRY_CODES = {
  '1': 'US/Canada',
  '7': 'Russia/Kazakhstan',
  '20': 'Egypt',
  '27': 'South Africa',
  '31': 'Netherlands',
  '33': 'France',
  '34': 'Spain',
  '39': 'Italy',
  '44': 'UK',
  '49': 'Germany',
  '55': 'Brazil',
  '60': 'Malaysia',
  '61': 'Australia',
  '62': 'Indonesia',
  '63': 'Philippines',
  '64': 'New Zealand',
  '65': 'Singapore',
  '66': 'Thailand',
  '81': 'Japan',
  '82': 'South Korea',
  '84': 'Vietnam',
  '86': 'China',
  '92': 'Pakistan',
  '94': 'Sri Lanka',
  '95': 'Myanmar',
  '212': 'Morocco',
  '234': 'Nigeria',
  '254': 'Kenya',
  '353': 'Ireland',
  '852': 'Hong Kong',
  '880': 'Bangladesh',
  '960': 'Maldives',
  '965': 'Kuwait',
  '966': 'Saudi Arabia',
  '968': 'Oman',
  '971': 'UAE',
  '973': 'Bahrain',
  '974': 'Qatar',
  '975': 'Bhutan',
  '977': 'Nepal'
};

// Resolves a raw phone string into either an Indian telecom circle,
// a foreign country, or an unknown bucket.
// Returns { kind: 'india', code, name, coord } | { kind: 'international', country } | { kind: 'unknown' }
function resolvePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return { kind: 'unknown' };

  let subscriber = null;
  if (digits.length === 12 && digits.startsWith('91')) {
    subscriber = digits.slice(2);
  } else if (digits.length === 10 && /^[6-9]/.test(digits)) {
    // Stored without a country code — assume India (bot's primary market)
    subscriber = digits;
  }

  if (subscriber) {
    const code = PREFIX_CIRCLES[subscriber.slice(0, 4)];
    if (code && CIRCLES[code]) {
      return { kind: 'india', code, ...CIRCLES[code] };
    }
    return { kind: 'india', code: null, name: 'India (unmapped prefix)', coord: null };
  }

  for (let len = 3; len >= 1; len--) {
    const cc = digits.slice(0, len);
    if (COUNTRY_CODES[cc]) {
      return { kind: 'international', country: COUNTRY_CODES[cc] };
    }
  }
  return { kind: 'international', country: 'Other' };
}

module.exports = { resolvePhone, CIRCLES };
