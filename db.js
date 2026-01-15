const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Create tables on startup
(async () => {
  try {
    // Create users table for tracking welcome state, timezone, and last interaction
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        phone TEXT PRIMARY KEY,
        has_seen_welcome BOOLEAN NOT NULL DEFAULT false,
        timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
        last_interaction_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Add timezone column if it doesn't exist (for existing databases)
    await pool.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata';
    `);
    
    // Add last_interaction_at column if it doesn't exist (for existing databases)
    await pool.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS last_interaction_at TIMESTAMP;
    `);
    
    // Add last_weekly_reminder_sent column if it doesn't exist (for existing databases)
    // Use DO block for safer migration (works in all PostgreSQL versions)
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' AND column_name = 'last_weekly_reminder_sent'
        ) THEN
          ALTER TABLE users ADD COLUMN last_weekly_reminder_sent TIMESTAMP;
        END IF;
      END $$;
    `);
    console.log('✅ Weekly reminder column ensured');

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
    
    // Create birthday_reminder_log table for tracking sent reminders
    await pool.query(`
      CREATE TABLE IF NOT EXISTS birthday_reminder_log (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        date DATE NOT NULL,
        type TEXT NOT NULL DEFAULT 'daily_today',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (phone, date, type)
      );
    `);
    
    // Create index on (phone, date, type) for faster lookups
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_birthday_reminder_log_phone_date_type 
      ON birthday_reminder_log (phone, date, type);
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

// Get birthdays for a specific day and month (for reminders)
async function getBirthdaysForDate(phone, day, month) {
  const res = await pool.query(
    `
    SELECT name, day, month
    FROM birthdays
    WHERE phone = $1 AND day = $2 AND LOWER(month) = LOWER($3)
    ORDER BY name
    `,
    [phone, day, month]
  );
  return res.rows;
}

// Get birthday by name (case-insensitive, partial match)
async function getBirthdayByName(phone, name) {
  const res = await pool.query(
    `
    SELECT name, day, month
    FROM birthdays
    WHERE phone = $1 AND LOWER(name) LIKE LOWER('%' || $2 || '%')
    ORDER BY name
    LIMIT 10
    `,
    [phone, name]
  );
  return res.rows;
}

// Get birthdays by date (day and month)
async function getBirthdaysByDate(phone, day, month) {
  const res = await pool.query(
    `
    SELECT name, day, month
    FROM birthdays
    WHERE phone = $1 AND day = $2 AND LOWER(month) = LOWER($3)
    ORDER BY name
    `,
    [phone, day, month]
  );
  return res.rows;
}

// Get upcoming birthdays within a date range (handles year wrap)
async function getUpcomingBirthdays(phone, fromDay, fromMonth, toDay, toMonth) {
  // Map month names to numbers for comparison
  const monthToNum = {
    'Jan': 1, 'Feb': 2, 'Mar': 3, 'Apr': 4, 'May': 5, 'Jun': 6,
    'Jul': 7, 'Aug': 8, 'Sep': 9, 'Oct': 10, 'Nov': 11, 'Dec': 12
  };
  
  const fromMonthNum = monthToNum[fromMonth] || 0;
  const toMonthNum = monthToNum[toMonth] || 0;
  
  // Get all birthdays for this user
  const allBirthdays = await pool.query(
    `
    SELECT name, day, month
    FROM birthdays
    WHERE phone = $1
    ORDER BY month, day
    `,
    [phone]
  );
  
  // Helper function to compare dates (month, day) for sorting
  function dateValue(monthNum, day) {
    return monthNum * 100 + day;
  }
  
  const fromValue = dateValue(fromMonthNum, fromDay);
  const toValue = dateValue(toMonthNum, toDay);
  
  // Filter birthdays within the range (handling year wrap)
  const upcoming = [];
  for (const b of allBirthdays.rows) {
    const bMonthNum = monthToNum[b.month] || 0;
    const bDay = b.day;
    const bValue = dateValue(bMonthNum, bDay);
    
    let inRange = false;
    
    if (fromMonthNum <= toMonthNum) {
      // Normal case: same year (e.g., Feb 1 to Mar 15)
      inRange = bValue >= fromValue && bValue <= toValue;
    } else {
      // Year wrap case: crosses year boundary (e.g., Dec 1 to Jan 15)
      // Birthday is in range if it's >= fromDate OR <= toDate
      inRange = bValue >= fromValue || bValue <= toValue;
    }
    
    if (inRange) {
      upcoming.push(b);
    }
  }
  
  // Sort by nearest date first (considering year wrap)
  upcoming.sort((a, b) => {
    const aValue = dateValue(monthToNum[a.month] || 0, a.day);
    const bValue = dateValue(monthToNum[b.month] || 0, b.day);
    
    // If we're in a year wrap scenario, adjust values for comparison
    if (fromMonthNum > toMonthNum) {
      const aAdjusted = aValue < fromValue ? aValue + 1200 : aValue;
      const bAdjusted = bValue < fromValue ? bValue + 1200 : bValue;
      return aAdjusted - bAdjusted;
    }
    return aValue - bValue;
  });
  
  return upcoming;
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

// Check if reminder was already sent today for a user
async function hasReminderBeenSentToday(phone, date, type = 'daily_today') {
  const res = await pool.query(
    `
    SELECT 1 FROM birthday_reminder_log
    WHERE phone = $1 AND date = $2 AND type = $3
    LIMIT 1
    `,
    [phone, date, type]
  );
  return res.rowCount > 0;
}

// Log that a reminder was sent (idempotent - uses ON CONFLICT)
async function logReminderSent(phone, date, type = 'daily_today') {
  await pool.query(
    `
    INSERT INTO birthday_reminder_log (phone, date, type)
    VALUES ($1, $2, $3)
    ON CONFLICT (phone, date, type) DO NOTHING
    `,
    [phone, date, type]
  );
}

// Get all active users with timezone (users who have at least one birthday saved)
async function getAllActiveUsersWithTimezone() {
  const res = await pool.query(
    `
    SELECT DISTINCT u.phone, u.timezone, u.last_weekly_reminder_sent
    FROM users u
    INNER JOIN birthdays b ON u.phone = b.phone
    WHERE u.timezone IS NOT NULL
    `
  );
  return res.rows;
}

// Get upcoming birthdays for a user within the next N days
async function getUpcomingBirthdaysForUser(phone, days = 7) {
  const moment = require('moment-timezone');
  
  // Get user's timezone
  const userRes = await pool.query(
    `SELECT timezone FROM users WHERE phone = $1`,
    [phone]
  );
  
  if (userRes.rows.length === 0) {
    return [];
  }
  
  const userTimezone = userRes.rows[0].timezone || 'Asia/Kolkata';
  const now = moment().tz(userTimezone);
  
  // Get all birthdays for this user
  const allBirthdays = await getAllBirthdays(phone);
  
  // Calculate date range (today + next N days)
  const upcoming = [];
  const monthToNum = {
    'Jan': 1, 'Feb': 2, 'Mar': 3, 'Apr': 4, 'May': 5, 'Jun': 6,
    'Jul': 7, 'Aug': 8, 'Sep': 9, 'Oct': 10, 'Nov': 11, 'Dec': 12
  };
  
  for (let i = 0; i < days; i++) {
    const checkDate = now.clone().add(i, 'days');
    const checkDay = checkDate.date();
    const checkMonthNum = checkDate.month() + 1; // moment months are 0-indexed
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const checkMonth = monthNames[checkMonthNum - 1];
    
    // Find birthdays matching this day and month
    for (const b of allBirthdays) {
      if (b.day === checkDay && b.month === checkMonth) {
        upcoming.push({
          name: b.name,
          day: b.day,
          month: b.month,
          date: checkDate.clone() // Store the actual date for formatting
        });
      }
    }
  }
  
  // Sort by date
  upcoming.sort((a, b) => a.date.valueOf() - b.date.valueOf());
  
  return upcoming;
}

// Update last weekly reminder sent timestamp for a user
async function updateLastWeeklyReminderSent(phone, timestamp) {
  await pool.query(
    `
    UPDATE users
    SET last_weekly_reminder_sent = $2
    WHERE phone = $1
    `,
    [phone, timestamp]
  );
}

module.exports = {
  saveBirthday,
  birthdayExists,
  birthdayExistsByName,
  getBirthdaysForMonth,
  getAllBirthdays,
  getBirthdaysForDate,
  getBirthdayByName,
  getBirthdaysByDate,
  getUpcomingBirthdays,
  deleteBirthday,
  updateBirthday,
  updateBirthdayName,
  isFirstTimeUser,
  hasSeenWelcome,
  markWelcomeSeen,
  userExists,
  onboardUser,
  getAllUsers,
  updateLastInteraction,
  hasReminderBeenSentToday,
  logReminderSent,
  getAllActiveUsersWithTimezone,
  getUpcomingBirthdaysForUser,
  updateLastWeeklyReminderSent
};