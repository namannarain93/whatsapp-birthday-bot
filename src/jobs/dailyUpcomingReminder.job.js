require('dotenv').config();
const moment = require('moment-timezone');
const { 
  pool,
  getAllActiveUsersWithTimezone,
  getBirthdaysForNextWeek,
  updateLastDailyUpcomingReminderSent
} = require('../../db.js');
const { sendTemplateMessage } = require('../services/whatsapp.service');
const { isSundayReminderActive } = require('../db/user.repository');
const { formatAgeSuffix } = require('../utils/age.utils');

// Centralized WhatsApp template configuration
// Body: "You have upcoming special events next week!\n\n{{1}}\n\nThese events are in your saved reminders."
const TEMPLATE_CONFIG = {
  name: 'event_details_reminder_1',
  // Meta template is "English" (en), not "English (US)" (en_US)
  language: { code: 'en' }
};

// Format event list for template {{1}}
// e.g. "Tarin Poddar's birthday — 27 Jan, Priya & Rahul's anniversary — 29 Jan"
function formatBirthdayList(birthdays) {
  if (birthdays.length === 0) {
    return '';
  }

  return birthdays.map(b => {
    const label = b.type === 'anniversary' ? 'anniversary' : 'birthday';
    const rel = b.relationship ? ` (${b.relationship})` : '';
    const age = b.date ? formatAgeSuffix(b.type, b.year, b.date.year()) : '';
    return `${b.name}${rel}'s ${label} — ${b.day} ${b.month}${age}`;
  }).join(', ');
}

// Check if reminder was already sent today for a user
async function hasDailyUpcomingReminderBeenSentToday(phone, today) {
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

// Main weekly upcoming reminder function (Sundays only, when next week has events)
async function runDailyUpcomingBirthdaysJob() {
  const executionTimestamp = moment().toISOString();
  
  try {
    console.log(`[WEEKLY_UPCOMING_REMINDER] Starting weekly (Sunday) upcoming birthdays check at ${executionTimestamp}...`);
    
    // Get all active users
    const users = await getAllActiveUsersWithTimezone();
    console.log(`[WEEKLY_UPCOMING_REMINDER] Found ${users.length} active user(s) to check`);

    let remindedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;

    for (const user of users) {
      try {
        const { phone, timezone, last_interaction_at: lastInteractionAt } = user;
        const userTimezone = timezone || 'Asia/Kolkata';
        const now = moment().tz(userTimezone);

        if (!isSundayReminderActive(lastInteractionAt)) {
          console.log(`[WEEKLY_UPCOMING_REMINDER] ⏭️  Skipping ${phone} - inactive for 3+ months (no Sunday reminder)`);
          skippedCount++;
          continue;
        }
        
        // Only send on Sundays (day() === 0 is Sunday in moment.js)
        if (now.day() !== 0) {
          continue;
        }
        
        // Today at 9:00 AM
        const today = now.clone().startOf('day');
        const todayAt9AM = today.clone().hour(9).minute(0).second(0).millisecond(0);
        
        if (now.isBefore(todayAt9AM)) {
          // It's before 9 AM in the user's timezone, skip for now
          continue;
        }
        
        // Idempotent check
        const alreadySent = await hasDailyUpcomingReminderBeenSentToday(phone, today);
        if (alreadySent) {
          console.log(`[WEEKLY_UPCOMING_REMINDER] ⏭️  Skipping ${phone} - reminder already sent this week`);
          skippedCount++;
          continue;
        }

        // Next calendar week = Monday–Sunday after the current ISO week
        const upcomingBirthdays = await getBirthdaysForNextWeek(phone);

        if (upcomingBirthdays.length === 0) {
          console.log(`[WEEKLY_UPCOMING_REMINDER] ⏭️  Skipping ${phone} - no events next week`);
          skippedCount++;
          continue;
        }

        const formattedList = formatBirthdayList(upcomingBirthdays);
        
        // Send template message
        await sendTemplateMessage(phone, TEMPLATE_CONFIG.name, [formattedList], TEMPLATE_CONFIG.language.code);
        
        // Update last sent timestamp (reusing the column name for now to avoid DB migration)
        await updateLastDailyUpcomingReminderSent(phone, today.toISOString());
        
        console.log(`[WEEKLY_UPCOMING_REMINDER] ✅ Sent weekly upcoming reminder to ${phone} with ${upcomingBirthdays.length} upcoming event(s)`);
        remindedCount++;
        
      } catch (err) {
        console.error(`[WEEKLY_UPCOMING_REMINDER] ❌ Error processing user ${user.phone}:`, err.message);
        errorCount++;
      }
    }
    
    console.log(`[WEEKLY_UPCOMING_REMINDER] Completed: ${remindedCount} user(s) reminded, ${skippedCount} skipped, ${errorCount} error(s)`);
    
  } catch (err) {
    console.error('[WEEKLY_UPCOMING_REMINDER] Fatal error:', err);
    throw err;
  }
}

// Scheduler function
function startDailyUpcomingReminderScheduler() {
  console.log('[WEEKLY_UPCOMING_REMINDER] Starting scheduler - will check every 30 minutes (sends on Sundays at 9 AM when next week has events)');
  
  runDailyUpcomingBirthdaysJob().catch(err => {
    console.error('[WEEKLY_UPCOMING_REMINDER] Initial run failed:', err);
  });
  
  setInterval(() => {
    runDailyUpcomingBirthdaysJob().catch(err => {
      console.error('[WEEKLY_UPCOMING_REMINDER] Scheduled run failed:', err);
    });
  }, 30 * 60 * 1000);
}

// Run if called directly
if (require.main === module) {
  runDailyUpcomingBirthdaysJob()
    .then(() => {
      console.log('[WEEKLY_UPCOMING_REMINDER] Script completed successfully');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[WEEKLY_UPCOMING_REMINDER] Script failed:', err);
      process.exit(1);
    });
}

module.exports = { runDailyUpcomingBirthdaysJob, startDailyUpcomingReminderScheduler };
