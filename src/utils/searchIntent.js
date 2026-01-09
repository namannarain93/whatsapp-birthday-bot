// Search intent detection utilities

/**
 * Check if a message contains explicit search-related verbs
 * @param {string} message - User's message
 * @returns {boolean} - True if message contains search intent
 */
function isSearchIntent(message) {
  if (!message || !message.trim()) {
    return false;
  }

  const lower = message.toLowerCase().trim();
  
  // List of search-related verbs/phrases
  const searchVerbs = [
    'search',
    'find',
    'lookup',
    'look up',
    'check',
    'show',
    'whose',
    'who is',
    'when is'
  ];

  // Check if message contains any search verb
  return searchVerbs.some(verb => lower.includes(verb));
}

/**
 * Extract the name/query from a search message
 * Removes search verbs and returns the remaining text
 * @param {string} message - User's search message
 * @returns {string} - Extracted name/query
 */
function extractSearchQuery(message) {
  if (!message || !message.trim()) {
    return '';
  }

  let cleaned = message.trim();
  const lower = cleaned.toLowerCase();

  // Remove search verbs and common patterns
  const patterns = [
    /^(?:search|find|lookup|look up|check|show)\s+/i,
    /\s+(?:search|find|lookup|look up|check|show)\s+/i,
    /^(?:whose|who is|when is)\s+/i,
    /\s+(?:birthday|birthday\?)$/i
  ];

  for (const pattern of patterns) {
    cleaned = cleaned.replace(pattern, ' ').trim();
  }

  return cleaned;
}

module.exports = {
  isSearchIntent,
  extractSearchQuery
};

