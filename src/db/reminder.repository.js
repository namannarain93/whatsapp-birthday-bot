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

// Users eligible for Sunday weekly reminders: has events, timezone, and interacted within 3 months
async function getAllActiveUsersWithTimezone() {
  const res = await pool.query(
    `
    SELECT DISTINCT u.phone, u.timezone, u.last_weekly_reminder_sent, u.last_interaction_at
    FROM users u
    INNER JOIN birthdays b ON u.phone = b.phone
    WHERE u.timezone IS NOT NULL
      AND u.last_interaction_at IS NOT NULL
      AND u.last_interaction_at >= NOW() - INTERVAL '3 months'
    `
  );
  return res.rows;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Match stored events against a contiguous day range [startDay, endDay] (inclusive),
// using the user's timezone. startDay/endDay should be start-of-day moments.
async function getBirthdaysInDateRange(phone, startDay, endDay) {
  const { getAllBirthdays } = require('./birthday.repository');
  const allBirthdays = await getAllBirthdays(phone);
  const upcoming = [];

  const cursor = startDay.clone().startOf('day');
  const last = endDay.clone().startOf('day');

  while (cursor.isSameOrBefore(last, 'day')) {
    const checkDay = cursor.date();
    const checkMonth = MONTH_NAMES[cursor.month()];

    for (const b of allBirthdays) {
      if (b.day === checkDay && b.month === checkMonth) {
        upcoming.push({
          name: b.name,
          day: b.day,
          month: b.month,
          type: b.type,
          date: cursor.clone()
        });
      }
    }
    cursor.add(1, 'day');
  }

  upcoming.sort((a, b) => a.date.valueOf() - b.date.valueOf());
  return upcoming;
}

// Get upcoming birthdays for a user within the next N days (today inclusive)
async function getUpcomingBirthdaysForUser(phone, days = 7) {
  const moment = require('moment-timezone');

  const userRes = await pool.query(
    `SELECT timezone FROM users WHERE phone = $1`,
    [phone]
  );

  if (userRes.rows.length === 0) {
    return [];
  }

  const userTimezone = userRes.rows[0].timezone || 'Asia/Kolkata';
  const now = moment().tz(userTimezone);
  const startDay = now.clone().startOf('day');
  const endDay = startDay.clone().add(days - 1, 'days');

  return getBirthdaysInDateRange(phone, startDay, endDay);
}

// Events in the next calendar week (Monday–Sunday) in the user's timezone.
// "Next week" is always the week after the current ISO week.
async function getBirthdaysForNextWeek(phone) {
  const moment = require('moment-timezone');

  const userRes = await pool.query(
    `SELECT timezone FROM users WHERE phone = $1`,
    [phone]
  );

  if (userRes.rows.length === 0) {
    return [];
  }

  const userTimezone = userRes.rows[0].timezone || 'Asia/Kolkata';
  const now = moment().tz(userTimezone);
  const nextMonday = now.clone().startOf('isoWeek').add(1, 'week');
  const nextSunday = nextMonday.clone().add(6, 'days');

  return getBirthdaysInDateRange(phone, nextMonday, nextSunday);
}

// Count total saved events (birthdays + anniversaries) for a user
async function getTotalEventCount(phone) {
  const res = await pool.query(
    `SELECT COUNT(*) FROM birthdays WHERE phone = $1`,
    [phone]
  );
  return parseInt(res.rows[0].count) || 0;
}

// Get the next N upcoming events for a user, starting after `startAfterDays` days from now.
// Scans up to one year ahead and stops once N events are found.
async function getNextNUpcomingBirthdays(phone, n = 5, startAfterDays = 7) {
  const moment = require('moment-timezone');
  const { getAllBirthdays } = require('./birthday.repository');

  const userRes = await pool.query(
    `SELECT timezone FROM users WHERE phone = $1`,
    [phone]
  );
  if (userRes.rows.length === 0) return [];

  const userTimezone = userRes.rows[0].timezone || 'Asia/Kolkata';
  const now = moment().tz(userTimezone);
  const allBirthdays = await getAllBirthdays(phone);
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const found = [];
  for (let i = startAfterDays + 1; i <= 365 && found.length < n; i++) {
    const checkDate = now.clone().add(i, 'days');
    const checkDay = checkDate.date();
    const checkMonth = monthNames[checkDate.month()];

    for (const b of allBirthdays) {
      if (b.day === checkDay && b.month === checkMonth) {
        found.push({
          name: b.name,
          day: b.day,
          month: b.month,
          type: b.type,
          date: checkDate.clone()
        });
      }
    }
  }

  return found;
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
  getBirthdaysForNextWeek,
  getTotalEventCount,
  getNextNUpcomingBirthdays,
  updateLastDailyUpcomingReminderSent,
};
