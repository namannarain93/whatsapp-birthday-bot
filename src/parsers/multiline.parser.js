// Multi-line birthday processing logic

const { parseNameAndDate } = require('./date.parser');
const { normalizeMonthToShort } = require('../utils/month.utils');
const { birthdayExists, saveBirthday } = require('../../db.js');

// Process a single line for saving
async function processSaveLine(phone, line) {
  const trimmed = line.trim();
  if (!trimmed) return { success: false, reason: 'empty' };

  // Try flexible date parsing first
  const parsedSave = parseNameAndDate(trimmed);
  if (parsedSave) {
    const { name, day, month } = parsedSave;
    // Normalize month to canonical short form (Jan, Feb, etc.) at write time
    const normalizedMonth = normalizeMonthToShort(month);
    if (!normalizedMonth) {
      return { success: false, reason: 'parse_failed', line: trimmed };
    }
    const exists = await birthdayExists(phone, name.trim(), day, normalizedMonth);
    if (exists) {
      return { success: false, reason: 'duplicate', name, day, month: normalizedMonth };
    }
    await saveBirthday(phone, name.trim(), day, normalizedMonth);
    return { success: true, name, day, month: normalizedMonth };
  }

  // Try legacy regex pattern ("Name Month Day")
  const saveMatch = trimmed.match(/^(.+?)\s+([A-Za-z]+)\s+(\d+)$/);
  if (saveMatch) {
    const [, name, month, day] = saveMatch;
    const d = parseInt(day, 10);
    // Normalize month to canonical short form (Jan, Feb, etc.) at write time
    const normalizedMonth = normalizeMonthToShort(month);
    if (!normalizedMonth) {
      return { success: false, reason: 'parse_failed', line: trimmed };
    }
    const exists = await birthdayExists(phone, name.trim(), d, normalizedMonth);
    if (exists) {
      return { success: false, reason: 'duplicate', name, day: d, month: normalizedMonth };
    }
    await saveBirthday(phone, name.trim(), d, normalizedMonth);
    return { success: true, name, day: d, month: normalizedMonth };
  }

  return { success: false, reason: 'parse_failed', line: trimmed };
}

// Words that signal the line is an instruction ("Edit:", "Remove Kamal 5 Aug",
// "actually it's the 6th"), not a plain "Name + date" entry. Such messages must
// go to the LLM, which understands commands and conversation context — blindly
// saving these lines produces garbage entries like "Remove Kamal – Aug 5".
const COMMAND_WORD_REGEX = /(^|[^a-z])(edit|edits|remove|delete|update|rename|change|correct|fix|wrong|mean|meant|instead|actually|not|no|list|search|find|help)([^a-z]|$)/i;

// Process multi-line message and return results
async function processMultilineMessage(phone, message) {
  const lines = message
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  if (lines.length <= 1) {
    return null; // Not a multi-line message
  }

  // Defer to the LLM when any line looks like a command/correction rather
  // than a plain "Name + date" entry.
  if (lines.some(line => COMMAND_WORD_REGEX.test(line))) {
    return null;
  }

  // Defer to the LLM when nothing parses as "Name + date" — the message is
  // probably conversational text that happens to contain line breaks.
  const anyLineParseable = lines.some(line =>
    parseNameAndDate(line) || /^(.+?)\s+([A-Za-z]+)\s+(\d+)$/.test(line)
  );
  if (!anyLineParseable) {
    return null;
  }

  const saved = [];
  const skipped = [];

  for (const line of lines) {
    const result = await processSaveLine(phone, line);
    if (result.success) {
      saved.push(result);
    } else if (result.reason === 'duplicate') {
      skipped.push({ line: result.name, reason: 'duplicate', day: result.day, month: result.month });
    } else {
      skipped.push({ line: result.line || line, reason: 'parse_failed' });
    }
  }

  // Build summary message
  let summary = '';
  if (saved.length > 0) {
    summary += "I've saved:\n";
    saved.forEach(s => {
      summary += `• ${s.name} – ${s.month} ${s.day}\n`;
    });
    if (saved.length === lines.length) {
      summary += '🎂';
    }
  }

  if (skipped.length > 0) {
    if (summary) summary += '\n';
    summary += "I couldn't understand:\n";
    skipped.forEach(s => {
      if (s.reason === 'duplicate') {
        summary += `• ${s.line} – already saved on ${s.month} ${s.day}\n`;
      } else {
        summary += `• ${s.line}\n`;
      }
    });
  }

  return summary ? summary.trim() : null;
}

module.exports = {
  processMultilineMessage
};

