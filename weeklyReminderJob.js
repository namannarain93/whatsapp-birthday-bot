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

// Centralized WhatsApp template configuration
const TEMPLATE_CONFIG = {
  name: 'weekly_birthday_reminders',
  language: { code: 'en' }
};

// Send WhatsApp template message
// Uses centralized TEMPLATE_CONFIG to prevent template name/language mismatches
async function sendTemplateMessage(to, parametersArray) {
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
          name: TEMPLATE_CONFIG.name,
          language: TEMPLATE_CONFIG.language,
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
      // Enhanced error logging for debugging template issues
      console.error(`[WEEKLY_REMINDER] ❌ WhatsApp API error for ${to}:`, {
        error: data.error.message || 'Unknown error',
        errorCode: data.error.code,
        templateName: TEMPLATE_CONFIG.name,
        languageCode: TEMPLATE_CONFIG.language.code,
        recipientPhone: to
      });
      throw new Error(data.error.message || 'WhatsApp API error');
    }
    return data;
  } catch (err) {
    // Enhanced error logging for network/other errors
    console.error(`[WEEKLY_REMINDER] ❌ Send error for ${to}:`, {
      error: err.message,
      templateName: TEMPLATE_CONFIG.name,
      languageCode: TEMPLATE_CONFIG.language.code,
      recipientPhone: to
    });
    throw err;
  }
}

// Format birthday list for template
function formatBirthdayList(birthdays) {
  if (birthdays.length === 0) {
    return 'No birthdays in the next 7 days.';
  }

  return birthdays.map(b => {
    // Format as "Name – 23 Jan"
    const day = b.day;
    const month = b.month; // Already in short form (Jan, Feb, etc.)
    return `${b.name} – ${day} ${month}`;
  }).join(', ');
}

// Check if reminder was already sent today for a user
async function hasWeeklyReminderBeenSentToday(phone, today) {
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
  // Check if last sent was today (same date)
  // Compare by year, month, and day
  return lastSent.isSame(today, 'day');
}

// Main weekly reminder function
async function runWeeklyUpcomingBirthdaysJob() {
  const executionTimestamp = moment().toISOString();
  
  try {
    console.log(`[WEEKLY_REMINDER] Starting weekly upcoming birthdays check at ${executionTimestamp}...`);
    
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
        
        // Check if today is Sunday (0 = Sunday in moment)
        if (now.day() !== 0) {
          // It's not Sunday, skip this user
          continue;
        }
        
        // Get today's date (start of day)
        const today = now.clone().startOf('day');
        
        // Compute today at 9:00 AM in user's timezone
        const todayAt9AM = today.clone().hour(9).minute(0).second(0).millisecond(0);
        
        // Check if current time is after today's 9:00 AM
        if (now.isBefore(todayAt9AM)) {
          // It's before 9:00 AM, skip this user
          continue;
        }
        
        // Check if reminder was already sent today (idempotent check)
        const alreadySent = await hasWeeklyReminderBeenSentToday(phone, today);
        if (alreadySent) {
          console.log(`[WEEKLY_REMINDER] ⏭️  Skipping ${phone} - reminder already sent today`);
          skippedCount++;
          continue;
        }
        
        // Get upcoming birthdays for next 7 days
        const upcomingBirthdays = await getUpcomingBirthdaysForUser(phone, 7);
        
        // Format birthday list
        let formattedList = formatBirthdayList(upcomingBirthdays);
        
        // Guardrail: ensure parameter is never null or empty
        if (!formattedList || formattedList.trim().length === 0) {
          formattedList = 'No birthdays in the next 7 days.';
        }
        
        // Log execution details
        console.log(`[WEEKLY_REMINDER] 📊 Execution timestamp: ${executionTimestamp}`);
        console.log(`[WEEKLY_REMINDER] 📊 Upcoming birthdays count: ${upcomingBirthdays.length}`);
        console.log(`[WEEKLY_REMINDER] 📊 Final body parameter: "${formattedList}"`);
        
        // Send template message (always send, even if no birthdays)
        await sendTemplateMessage(phone, [formattedList]);
        
        // Update last weekly reminder sent timestamp
        await updateLastWeeklyReminderSent(phone, today.toISOString());
        
        console.log(`[WEEKLY_REMINDER] ✅ Sent weekly reminder to ${phone} with ${upcomingBirthdays.length} upcoming birthday(s)`);
        remindedCount++;
        
      } catch (err) {
        // Log error but continue with other users
        console.error(`[WEEKLY_REMINDER] ❌ Error processing user ${user.phone}:`, err.message);
        errorCount++;
      }
    }
    
    console.log(`[WEEKLY_REMINDER] Completed: ${remindedCount} user(s) reminded, ${skippedCount} skipped (already sent/not Sunday), ${errorCount} error(s)`);
    
  } catch (err) {
    console.error('[WEEKLY_REMINDER] Fatal error:', err);
    // Don't exit process - let scheduler continue
    throw err;
  }
}

// Scheduler function - runs reminder check every 30 minutes
function startWeeklyReminderScheduler() {
  console.log('[WEEKLY_REMINDER] Starting scheduler - will check every 30 minutes');
  console.log('⏰ Weekly upcoming birthdays reminder job running (30 min interval, triggers on Sundays at 9:00 AM local time)');
  
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
