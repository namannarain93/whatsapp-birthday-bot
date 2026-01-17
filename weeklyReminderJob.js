require('dotenv').config();
const { Pool } = require('pg');
const moment = require('moment-timezone');
const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

// Connect to Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Import DB helpers
const {
  getAllActiveUsersWithTimezone,
  getUpcomingBirthdaysForUser,
  updateLastWeeklyReminderSent
} = require('./db.js');

// Send WhatsApp template message
async function sendTemplateMessage(to, templateName, parametersArray) {
  const url = `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: 'en_US' },
          components: [
            {
              type: 'body',
              parameters: parametersArray.map(text => ({
                type: 'text',
                text: text
              }))
            }
          ]
        }
      })
    });

    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message || 'WhatsApp API error');
    }
    return data;
  } catch (err) {
    throw err;
  }
}

// Format birthday list for template
function formatBirthdayList(birthdays) {
  if (birthdays.length === 0) {
    return 'None this week';
  }

  const monthAbbrevs = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayAbbrevs = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return birthdays.map(b => {
    const date = b.date; // moment object
    const dayName = dayAbbrevs[date.day()];
    const day = b.day;
    return `${b.name} – ${dayName} ${day}`;
  }).join(', ');
}

// Check if reminder was already sent this Sunday for a user
async function hasWeeklyReminderBeenSentThisWeek(phone, currentSunday) {
  const res = await pool.query(
    `
    SELECT last_weekly_reminder_sent
    FROM users
    WHERE phone = $1
    `,
    [phone]
  );

  if (res.rows.length === 0 || !res.rows[0].last_weekly_reminder_sent) {
    return false;
  }

  const lastSent = moment(res.rows[0].last_weekly_reminder_sent);
  // Check if last sent was on the same Sunday (same date)
  // Compare by year, month, and day
  return lastSent.isSame(currentSunday, 'day');
}

// Main weekly reminder function
async function runWeeklyUpcomingBirthdaysJob() {
  try {
    console.log('[WEEKLY_REMINDER] Starting weekly upcoming birthdays check...');
    
    // Get all active users (users who have at least one birthday saved)
    const users = await getAllActiveUsersWithTimezone();
    console.log(`[WEEKLY_REMINDER] Found ${users.length} active user(s) to check`);

    let remindedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;

    for (const user of users) {
      try {
        const { phone, timezone } = user;
        const userTimezone = timezone || 'Asia/Kolkata'; // Default timezone
        
        // Get current time in user's timezone
        const now = moment().tz(userTimezone);
        const currentDay = now.day(); // 0 = Sunday, 1 = Monday, etc.
        const currentHour = now.hour();
        const currentMinute = now.minute();
        
        // Only send reminders on Sunday at 9:00 AM (±2 min window)
        if (currentDay !== 0) {
          // Not Sunday
          continue;
        }
        
        // Check if it's 9:00 AM (±2 min window: 8:58 to 9:02)
        // Allow 8:58, 8:59, 9:00, 9:01, 9:02
        const isInWindow = 
          (currentHour === 8 && currentMinute >= 58) ||
          (currentHour === 9 && currentMinute <= 2);
        
        if (!isInWindow) {
          continue;
        }
        
        // Get the current Sunday date (start of day)
        const currentSunday = now.clone().startOf('day');
        
        // Check if reminder was already sent this Sunday (idempotent check)
        const alreadySent = await hasWeeklyReminderBeenSentThisWeek(phone, currentSunday);
        if (alreadySent) {
          console.log(`[WEEKLY_REMINDER] ⏭️  Skipping ${phone} - reminder already sent this Sunday`);
          skippedCount++;
          continue;
        }
        
        // Get upcoming birthdays for next 7 days
        const upcomingBirthdays = await getUpcomingBirthdaysForUser(phone, 7);
        
        // Format birthday list
        const formattedList = formatBirthdayList(upcomingBirthdays);
        
        // Send template message
        await sendTemplateMessage(phone, 'birthday_upcoming_week', [formattedList]);
        
        // Update last weekly reminder sent timestamp
        await updateLastWeeklyReminderSent(phone, currentSunday.toISOString());
        
        console.log(`[WEEKLY_REMINDER] ✅ Sent weekly reminder to ${phone} with ${upcomingBirthdays.length} upcoming birthday(s)`);
        remindedCount++;
        
      } catch (err) {
        // Log error but continue with other users
        console.error(`[WEEKLY_REMINDER] ❌ Error processing user ${user.phone}:`, err.message);
        errorCount++;
      }
    }
    
    console.log(`[WEEKLY_REMINDER] Completed: ${remindedCount} user(s) reminded, ${skippedCount} skipped (already sent), ${errorCount} error(s)`);
    
  } catch (err) {
    console.error('[WEEKLY_REMINDER] Fatal error:', err);
    // Don't exit process - let scheduler continue
    throw err;
  }
}

// Scheduler function - runs reminder check every 30 minutes
function startWeeklyReminderScheduler() {
  console.log('[WEEKLY_REMINDER] Starting scheduler - will check every 30 minutes');
  console.log('⏰ Weekly upcoming birthdays reminder job running (30 min interval)');
  
  // Run immediately on startup
  runWeeklyUpcomingBirthdaysJob().catch(err => {
    console.error('[WEEKLY_REMINDER] Initial run failed:', err);
  });
  
  // Then run every 30 minutes (1800000 ms)
  const intervalMs = 30 * 60 * 1000; // 30 minutes
  setInterval(() => {
    runWeeklyUpcomingBirthdaysJob().catch(err => {
      console.error('[WEEKLY_REMINDER] Scheduled run failed:', err);
    });
  }, intervalMs);
  
  console.log('[WEEKLY_REMINDER] Scheduler started successfully');
}

// Run if called directly (for manual testing)
if (require.main === module) {
  runWeeklyUpcomingBirthdaysJob()
    .then(() => {
      console.log('[WEEKLY_REMINDER] Script completed successfully');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[WEEKLY_REMINDER] Script failed:', err);
      process.exit(1);
    });
}

module.exports = { runWeeklyUpcomingBirthdaysJob, startWeeklyReminderScheduler };
