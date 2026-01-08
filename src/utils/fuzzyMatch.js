// Fuzzy name matching utilities

/**
 * Calculate Levenshtein distance between two strings
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} - Edit distance
 */
function levenshteinDistance(str1, str2) {
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();
  
  const matrix = [];
  const len1 = s1.length;
  const len2 = s2.length;

  // Initialize matrix
  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }

  // Fill matrix
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,      // deletion
          matrix[i][j - 1] + 1,      // insertion
          matrix[i - 1][j - 1] + 1   // substitution
        );
      }
    }
  }

  return matrix[len1][len2];
}

/**
 * Calculate similarity score between two strings (0-1, where 1 is identical)
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} - Similarity score
 */
function similarity(str1, str2) {
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 1;
  
  const distance = levenshteinDistance(str1, str2);
  return 1 - (distance / maxLen);
}

/**
 * Check if query matches name using multiple strategies
 * @param {string} query - User's search query
 * @param {string} name - Stored birthday name
 * @returns {object|null} - Match info with score, or null if no match
 */
function fuzzyMatch(query, name) {
  if (!query || !name) return null;

  const queryLower = query.toLowerCase().trim();
  const nameLower = name.toLowerCase().trim();

  // Exact match (case-insensitive)
  if (queryLower === nameLower) {
    return { name, score: 1.0, type: 'exact' };
  }

  // Starts with match (high priority)
  if (nameLower.startsWith(queryLower) && queryLower.length >= 2) {
    return { name, score: 0.9, type: 'startsWith' };
  }

  // Substring match (medium priority)
  if (nameLower.includes(queryLower) && queryLower.length >= 2) {
    return { name, score: 0.7, type: 'substring' };
  }

  // Levenshtein distance match (for typos and missing letters)
  const sim = similarity(queryLower, nameLower);
  if (sim >= 0.6) {
    return { name, score: sim, type: 'fuzzy' };
  }

  // Check if query matches any word in the name (for multi-word names)
  const nameWords = nameLower.split(/\s+/);
  for (const word of nameWords) {
    if (word.startsWith(queryLower) && queryLower.length >= 2) {
      return { name, score: 0.8, type: 'wordStartsWith' };
    }
    if (word.includes(queryLower) && queryLower.length >= 2) {
      return { name, score: 0.65, type: 'wordSubstring' };
    }
    const wordSim = similarity(queryLower, word);
    if (wordSim >= 0.6) {
      return { name, score: wordSim * 0.9, type: 'wordFuzzy' };
    }
  }

  return null;
}

/**
 * Find fuzzy matches from a list of birthdays
 * @param {string} query - User's search query
 * @param {Array} birthdays - Array of {name, day, month} objects
 * @param {number} minScore - Minimum similarity score (default: 0.6)
 * @returns {Array} - Sorted array of matches (best first)
 */
function findFuzzyMatches(query, birthdays, minScore = 0.6) {
  if (!query || !birthdays || birthdays.length === 0) {
    return [];
  }

  const matches = [];

  for (const birthday of birthdays) {
    const match = fuzzyMatch(query, birthday.name);
    if (match && match.score >= minScore) {
      matches.push({
        ...birthday,
        matchScore: match.score,
        matchType: match.type
      });
    }
  }

  // Sort by score (highest first), then by name
  matches.sort((a, b) => {
    if (b.matchScore !== a.matchScore) {
      return b.matchScore - a.matchScore;
    }
    return a.name.localeCompare(b.name);
  });

  return matches;
}

module.exports = {
  levenshteinDistance,
  similarity,
  fuzzyMatch,
  findFuzzyMatches
};

