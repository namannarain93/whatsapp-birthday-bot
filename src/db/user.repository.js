const { pool } = require('./pool');

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

// Onboard a new user (insert into users table with has_seen_welcome = true and default timezone)
async function onboardUser(phone) {
  await pool.query(
    `
    INSERT INTO users (phone, has_seen_welcome, timezone)
    VALUES ($1, true, 'Asia/Kolkata')
    ON CONFLICT (phone) DO NOTHING
    `,
    [phone]
  );
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

module.exports = {
  getAllUsers,
  updateLastInteraction,
  userExists,
  onboardUser,
  hasSeenWelcome,
  markWelcomeSeen,
  isFirstTimeUser,
  getUserName,
  setUserName,
};
