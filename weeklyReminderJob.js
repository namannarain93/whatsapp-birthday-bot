require('dotenv').config();
const moment = require('moment-timezone');
const { 
  pool,
  getAllActiveUsersWithTimezone,
  getUpcomingBirthdaysForUser,
  updateLastWeeklyReminderSent
} = require('./db.js');
const { sendTemplateMessage } = require('./src/services/whatsapp.service');

// Centralized WhatsApp template configuration
const TEMPLATE_CONFIG = {
  name: 'weekly_birthday_reminders',
  language: { code: 'en' }
};

// Format birthday list for template
function formatBirthdayList(birthdays) {
  if (birthdays.length === 0) {
    return 'No birthdays or anniversaries in the next 7 days.';
  }

  return birthdays.map(b => {
    // Format as "Name – 23 Jan"
    const day = b.day;
    const month = b.month; // Already in short form (Jan, Feb, etc.)
    const typeLabel = b.type === 'anniversary' ? ' (Anniversary)' : '';
    return `${b.name}${typeLabel} – ${day} ${month}`;
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
  return lastSent.isSame(today, 'day');
}

// Main weekly reminder function
async function runWeeklyUpcomingBirthdaysJob() {
  const executionTimestamp = moment().toISOString();
  
  try {
    console.log(`[WEEKLY_REMINDER] Starting weekly upcoming birthdays check at ${executionTimestamp}...`);
    
    // Get all active users
    const users = await getAllActiveUsersWithTimezone();
    console.log(`[WEEKLY_REMINDER] Found ${users.length} active user(s) to check`);

    let remindedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;

    for (const user of users) {
      try {
        const { phone, timezone } = user;
        const userTimezone = timezone || 'Asia/Kolkata';
        const now = moment().tz(userTimezone);
        
        // Check if today is Sunday
        if (now.day() !== 0) continue;
        
        // Today at 9:00 AM
        const today = now.clone().startOf('day');
        const todayAt9AM = today.clone().hour(9).minute(0).second(0).millisecond(0);
        
        if (now.isBefore(todayAt9AM)) continue;
        
        // Idempotent check
        const alreadySent = await hasWeeklyReminderBeenSentToday(phone, today);
        if (alreadySent) {
          console.log(`[WEEKLY_REMINDER] ⏭️  Skipping ${phone} - reminder already sent today`);
          skippedCount++;
          continue;
        }
        
        const upcomingBirthdays = await getUpcomingBirthdaysForUser(phone, 7);
        let formattedList = formatBirthdayList(upcomingBirthdays);
        
        // Ensure parameter is never empty
        if (!formattedList || formattedList.trim().length === 0) {
          formattedList = 'No birthdays or anniversaries in the next 7 days.';
        }
        
        // Send template message
        await sendTemplateMessage(phone, TEMPLATE_CONFIG.name, [formattedList], TEMPLATE_CONFIG.language.code);
        
        // Update last sent timestamp
        await updateLastWeeklyReminderSent(phone, today.toISOString());
        
        console.log(`[WEEKLY_REMINDER] ✅ Sent weekly reminder to ${phone} with ${upcomingBirthdays.length} upcoming birthday(s)`);
        remindedCount++;
        
      } catch (err) {
        console.error(`[WEEKLY_REMINDER] ❌ Error processing user ${user.phone}:`, err.message);
        errorCount++;
      }
    }
    
    console.log(`[WEEKLY_REMINDER] Completed: ${remindedCount} user(s) reminded, ${skippedCount} skipped, ${errorCount} error(s)`);
    
  } catch (err) {
    console.error('[WEEKLY_REMINDER] Fatal error:', err);
    throw err;
  }
}

// Scheduler function
function startWeeklyReminderScheduler() {
  console.log('[WEEKLY_REMINDER] Starting scheduler - will check every 30 minutes');
  
  runWeeklyUpcomingBirthdaysJob().catch(err => {
    console.error('[WEEKLY_REMINDER] Initial run failed:', err);
  });
  
  setInterval(() => {
    runWeeklyUpcomingBirthdaysJob().catch(err => {
      console.error('[WEEKLY_REMINDER] Scheduled run failed:', err);
    });
  }, 30 * 60 * 1000);
}

// Run if called directly
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
