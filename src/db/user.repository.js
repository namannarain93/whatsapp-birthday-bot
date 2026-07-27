const { pool } = require('./pool');

const SUNDAY_REMINDER_INACTIVITY_MONTHS = 3;

function isSundayReminderActive(lastInteractionAt) {
  if (!lastInteractionAt) return false;
  const last = new Date(lastInteractionAt);
  if (Number.isNaN(last.getTime())) return false;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - SUNDAY_REMINDER_INACTIVITY_MONTHS);
  return last >= cutoff;
}

function getSundayReminderStatus(lastInteractionAt) {
  return isSundayReminderActive(lastInteractionAt) ? 'active' : 'dormant';
}

// Get all users with their timezones and last interaction timestamps
async function getAllUsers() {
  const res = await pool.query(
    `
    SELECT phone, timezone, last_interaction_at
    FROM users
    WHERE timezone IS NOT NULL
    `
  );
  return res.rows;
}

// Update last interaction timestamp for a user
async function updateLastInteraction(phone) {
  await pool.query(
    `
    UPDATE users
    SET last_interaction_at = CURRENT_TIMESTAMP
    WHERE phone = $1
    `,
    [phone]
  );
}

// Check if user exists in users table
async function userExists(phone) {
  const res = await pool.query(
    `
    SELECT 1 FROM users
    WHERE phone = $1
    LIMIT 1
    `,
    [phone]
  );
  return res.rowCount > 0;
}

// Atomically onboard a new user. Returns true only when this call created the
// row, preventing concurrent first messages from starting onboarding twice.
async function onboardUser(phone) {
  const res = await pool.query(
    `
    INSERT INTO users (
      phone,
      has_seen_welcome,
      timezone,
      last_interaction_at,
      onboarding_step,
      onboarding_last_sent_at
    )
    VALUES ($1, true, 'Asia/Kolkata', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)
    ON CONFLICT (phone) DO NOTHING
    RETURNING phone
    `,
    [phone]
  );
  return res.rowCount > 0;
}

// Check if user has seen the welcome message
async function hasSeenWelcome(phone) {
  const res = await pool.query(
    `
    SELECT has_seen_welcome FROM users
    WHERE phone = $1
    `,
    [phone]
  );
  return res.rows.length > 0 && res.rows[0].has_seen_welcome === true;
}

// Mark user as having seen the welcome message
async function markWelcomeSeen(phone) {
  await pool.query(
    `
    INSERT INTO users (phone, has_seen_welcome)
    VALUES ($1, true)
    ON CONFLICT (phone) 
    DO UPDATE SET has_seen_welcome = true
    `,
    [phone]
  );
}

// Check if this is the first time a phone number is using the bot
// (kept for backward compatibility, but now uses has_seen_welcome)
async function isFirstTimeUser(phone) {
  const seenWelcome = await hasSeenWelcome(phone);
  return !seenWelcome;
}

// Get user's stored name
async function getUserName(phone) {
  const res = await pool.query(
    `SELECT name FROM users WHERE phone = $1`,
    [phone]
  );
  return res.rows.length > 0 ? res.rows[0].name : null;
}

// Set user's name
async function setUserName(phone, name) {
  await pool.query(
    `UPDATE users SET name = $1 WHERE phone = $2`,
    [name, phone]
  );
}

// Get pending action for a user (e.g. awaiting clarification response)
async function getPendingAction(phone) {
  const res = await pool.query(
    `SELECT pending_action FROM users WHERE phone = $1`,
    [phone]
  );
  return res.rows.length > 0 ? res.rows[0].pending_action : null;
}

// Set pending action for a user (store context when bot asks a clarification question)
async function setPendingAction(phone, action) {
  await pool.query(
    `UPDATE users SET pending_action = $1 WHERE phone = $2`,
    [JSON.stringify(action), phone]
  );
}

// Clear pending action for a user (after it's been consumed or expired)
async function clearPendingAction(phone) {
  await pool.query(
    `UPDATE users SET pending_action = NULL WHERE phone = $1`,
    [phone]
  );
}

module.exports = {
  SUNDAY_REMINDER_INACTIVITY_MONTHS,
  isSundayReminderActive,
  getSundayReminderStatus,
  getAllUsers,
  updateLastInteraction,
  userExists,
  onboardUser,
  hasSeenWelcome,
  markWelcomeSeen,
  isFirstTimeUser,
  getUserName,
  setUserName,
  getPendingAction,
  setPendingAction,
  clearPendingAction,
};
