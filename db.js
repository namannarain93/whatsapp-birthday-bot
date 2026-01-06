const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Create tables on startup
(async () => {
  try {
    // Create users table for tracking welcome state
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        phone TEXT PRIMARY KEY,
        has_seen_welcome BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create birthdays table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS birthdays (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        name TEXT NOT NULL,
        day INTEGER NOT NULL,
        month TEXT NOT NULL,
        UNIQUE (phone, name, day, month)
      );
    `);    
    console.log('Database tables ready (Postgres)');
  } catch (err) {
    console.error('Error creating tables:', err);
  }
})();

// Save birthday
async function saveBirthday(phone, name, day, month) {
  await pool.query(
    `INSERT INTO birthdays (phone, name, day, month)
     VALUES ($1, $2, $3, $4)`,
    [phone, name, day, month]
  );
}

// Check duplicate
async function birthdayExists(phone, name, day, month) {
  const res = await pool.query(
    `
    SELECT 1 FROM birthdays
    WHERE phone = $1
      AND LOWER(name) = LOWER($2)
      AND day = $3
      AND LOWER(month) = LOWER($4)
    `,
    [phone, name, day, month]
  );
  return res.rowCount > 0;
}

// Get birthdays for a month (per user)
async function getBirthdaysForMonth(phone, month) {
  const res = await pool.query(
    `
    SELECT name, day, month
    FROM birthdays
    WHERE phone = $1
      AND (LOWER(month) = LOWER($2) OR LOWER(month) LIKE LOWER($3))
    ORDER BY day
    `,
    [phone, month, `${month}%`]
  );
  return res.rows;
}

// Get all birthdays (per user)
async function getAllBirthdays(phone) {
  const res = await pool.query(
    `
    SELECT name, day, month
    FROM birthdays
    WHERE phone = $1
    ORDER BY month, day
    `,
    [phone]
  );
  return res.rows;
}

// Delete birthday
// Supports both exact match and fuzzy/partial match for corrupted names
async function deleteBirthday(phone, name) {
  // First try exact match (case-insensitive)
  const exactRes = await pool.query(
    `
    DELETE FROM birthdays
    WHERE phone = $1 AND LOWER(name) = LOWER($2)
    `,
    [phone, name]
  );
  
  if (exactRes.rowCount > 0) {
    console.log(`[DELETE] Exact match deleted ${exactRes.rowCount} row(s) for phone=${phone}, name="${name}"`);
    return true;
  }
  
  // If exact match failed, try fuzzy/partial match
  const fuzzyRes = await pool.query(
    `
    DELETE FROM birthdays
    WHERE phone = $1 AND LOWER(name) LIKE LOWER('%' || $2 || '%')
    `,
    [phone, name]
  );
  
  if (fuzzyRes.rowCount > 0) {
    console.log(`[DELETE] Fuzzy match deleted ${fuzzyRes.rowCount} row(s) for phone=${phone}, name="${name}"`);
    return true;
  }
  
  console.log(`[DELETE] No match found for phone=${phone}, name="${name}"`);
  return false;
}

// Verify birthday exists (for post-delete verification)
async function birthdayExistsByName(phone, name) {
  const res = await pool.query(
    `
    SELECT 1 FROM birthdays
    WHERE phone = $1 AND LOWER(name) = LOWER($2)
    LIMIT 1
    `,
    [phone, name]
  );
  return res.rowCount > 0;
}

// Update birthday
async function updateBirthday(phone, name, day, month) {
  await pool.query(
    `
    UPDATE birthdays
    SET day = $3, month = $4
    WHERE phone = $1 AND LOWER(name) = LOWER($2)
    `,
    [phone, name, day, month]
  );
}

// Update birthday name (rename)
async function updateBirthdayName(phone, oldName, newName) {
  const res = await pool.query(
    `
    UPDATE birthdays
    SET name = $3
    WHERE phone = $1 AND LOWER(name) = LOWER($2)
    `,
    [phone, oldName, newName]
  );
  return res.rowCount > 0;
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

// Onboard a new user (insert into users table with has_seen_welcome = true)
async function onboardUser(phone) {
  await pool.query(
    `
    INSERT INTO users (phone, has_seen_welcome)
    VALUES ($1, true)
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

module.exports = {
  saveBirthday,
  birthdayExists,
  birthdayExistsByName,
  getBirthdaysForMonth,
  getAllBirthdays,
  deleteBirthday,
  updateBirthday,
  updateBirthdayName,
  isFirstTimeUser,
  hasSeenWelcome,
  markWelcomeSeen,
  userExists,
  onboardUser
};