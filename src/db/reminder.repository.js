const { pool } = require('./pool');

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
  const { getAllBirthdays } = require('./birthday.repository');
  
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

// Update last daily upcoming reminder sent timestamp for a user
async function updateLastDailyUpcomingReminderSent(phone, timestamp) {
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
  hasReminderBeenSentToday,
  logReminderSent,
  getAllActiveUsersWithTimezone,
  getUpcomingBirthdaysForUser,
  updateLastDailyUpcomingReminderSent,
};
