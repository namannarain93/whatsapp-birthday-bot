require('dotenv').config();
const moment = require('moment-timezone');
const {
  getAllUsers,
  getBirthdaysForDate,
  hasReminderBeenSentToday,
  logReminderSent
} = require('../../db.js');
const { sendTemplateMessage } = require('../services/whatsapp.service');
const { formatAgeSuffix } = require('../utils/age.utils');

const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Naman's birthday on 11 Jul (turns 31)"
function formatEventDetail(event, day, month, eventYear) {
  const label = event.type === 'anniversary' ? 'anniversary' : 'birthday';
  const rel = event.relationship ? ` (${event.relationship})` : '';
  const age = formatAgeSuffix(event.type, event.year, eventYear);
  return `${event.name}${rel}'s ${label} on ${day} ${month}${age}`;
}

// Sends the day-before reminder (event_details_reminder_2) at 9 AM local time,
// one day ahead of each saved birthday/anniversary.
async function sendDayBeforeReminders() {
  try {
    console.log('[DAY_BEFORE_REMINDER] Starting day-before reminder check...');
    const users = await getAllUsers();
    console.log(`[DAY_BEFORE_REMINDER] Found ${users.length} user(s) to check`);

    let remindedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;

    for (const user of users) {
      try {
        const { phone, timezone } = user;
        const userTimezone = timezone || 'Asia/Kolkata';
        const now = moment().tz(userTimezone);
        const todayAt9AM = now.clone().startOf('day').hour(9).minute(0).second(0).millisecond(0);

        // Only send after 9 AM local; the log below prevents duplicates later in the day
        if (now.isBefore(todayAt9AM)) {
          continue;
        }

        const todayDate = now.format('YYYY-MM-DD');

        // Idempotent: one day-before batch per send-day per user
        const alreadySent = await hasReminderBeenSentToday(phone, todayDate, 'daily_tomorrow');
        if (alreadySent) {
          console.log(`[DAY_BEFORE_REMINDER] ⏭️  Skipping ${phone} - reminder already sent today`);
          skippedCount++;
          continue;
        }

        // Look at TOMORROW's events (add handles month/year wrap)
        const tomorrow = now.clone().add(1, 'day');
        const tomorrowDay = tomorrow.date();
        const tomorrowMonth = monthNames[tomorrow.month()];

        const events = await getBirthdaysForDate(phone, tomorrowDay, tomorrowMonth);
        if (events.length === 0) {
          continue;
        }

        const detailString = events
          .map(e => formatEventDetail(e, tomorrowDay, tomorrowMonth, tomorrow.year()))
          .join(', ');

        // Template body: "Reminder: {{1}} is coming up and you have saved this event."
        await sendTemplateMessage(phone, 'event_details_reminder_2', [detailString], 'en_US');

        // Log that reminder was sent (idempotent - prevents duplicates)
        await logReminderSent(phone, todayDate, 'daily_tomorrow');

        console.log(`[DAY_BEFORE_REMINDER] ✅ Sent day-before reminder to ${phone} for ${events.length} event(s): ${detailString}`);
        remindedCount++;

      } catch (err) {
        console.error(`[DAY_BEFORE_REMINDER] ❌ Error processing user ${user.phone}:`, err.message);
        errorCount++;
      }
    }

    console.log(`[DAY_BEFORE_REMINDER] Completed: ${remindedCount} user(s) reminded, ${skippedCount} skipped (already sent), ${errorCount} error(s)`);

  } catch (err) {
    console.error('[DAY_BEFORE_REMINDER] Fatal error:', err);
    // Don't exit process - let scheduler continue
    throw err;
  }
}

// Scheduler function - runs reminder check every 30 minutes
function startDayBeforeReminderScheduler() {
  console.log('[DAY_BEFORE_REMINDER] Starting scheduler - will check every 30 minutes');

  // Run immediately on startup
  sendDayBeforeReminders().catch(err => {
    console.error('[DAY_BEFORE_REMINDER] Initial run failed:', err);
  });

  // Then run every 30 minutes (1800000 ms)
  const intervalMs = 30 * 60 * 1000; // 30 minutes
  setInterval(() => {
    sendDayBeforeReminders().catch(err => {
      console.error('[DAY_BEFORE_REMINDER] Scheduled run failed:', err);
    });
  }, intervalMs);

  console.log('[DAY_BEFORE_REMINDER] Scheduler started successfully');
}

// Run if called directly (for manual testing)
if (require.main === module) {
  sendDayBeforeReminders()
    .then(() => {
      console.log('[DAY_BEFORE_REMINDER] Script completed successfully');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[DAY_BEFORE_REMINDER] Script failed:', err);
      process.exit(1);
    });
}

module.exports = { sendDayBeforeReminders, startDayBeforeReminderScheduler };
