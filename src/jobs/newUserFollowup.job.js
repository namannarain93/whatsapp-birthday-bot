require('dotenv').config();
const moment = require('moment-timezone');
const {
  getNewUsersForFollowup,
  getAllBirthdays,
  logReminderSent
} = require('../../db.js');
const { sendWhatsAppMessage } = require('../services/whatsapp.service');
const { formatBirthdaysChronologically } = require('../formatters/birthday.formatter');

// Build the follow-up message depending on whether the user has entries
function buildFollowupMessage(name, birthdays) {
  const greeting = name ? `Hey ${name}!` : 'Hey there!';

  if (birthdays && birthdays.length > 0) {
    // User has already added entries — show them their list and nudge for more
    const list = formatBirthdaysChronologically(birthdays);
    return (
      `${greeting} Quick check-in 👋\n\n` +
      `Here's everything you've added so far:\n\n` +
      `${list}\n\n` +
      `Would you like to add some more birthdays and anniversaries?\n\n` +
      `Think again — have you added all your in-laws, and nieces and nephews?\n` +
      `Reply with entries like:\n` +
      `• Mom — 12 Feb\n` +
      `• Riya (Anniversary) — 3 Mar`
    );
  }

  // User has added nothing yet
  return (
    `${greeting} Quick check-in 👋\n\n` +
    `Looks like you're yet to begin.\n\n` +
    `Would you like to add your sibling's birthdays and anniversaries?\n` +
    `Reply like:\n` +
    `• Brother — 21 Apr\n` +
    `• Sister (Anniversary) — 9 Dec`
  );
}

// Main follow-up function
async function sendNewUserFollowups() {
  try {
    console.log('[NEW_USER_FOLLOWUP] Starting new-user follow-up check...');

    const newUsers = await getNewUsersForFollowup();
    console.log(`[NEW_USER_FOLLOWUP] Found ${newUsers.length} new user(s) eligible for follow-up`);

    let sentCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const user of newUsers) {
      try {
        const { phone, timezone, created_at, name } = user;
        const userTimezone = timezone || 'Asia/Kolkata';

        // Current time in user's local timezone
        const now = moment().tz(userTimezone);
        const currentHour = now.hour();

        // Only send during the 8 PM hour (20:00–20:59).
        // The 30-min scheduler may not land inside a narrow 5-min window,
        // so we allow the full hour; birthday_reminder_log ensures idempotency.
        if (currentHour !== 20) {
          skippedCount++;
          continue;
        }

        // Make sure the user signed up before 8 PM today (avoid sending within minutes of signup)
        const signupMoment = moment(created_at).tz(userTimezone);
        const hoursSinceSignup = now.diff(signupMoment, 'hours', true);
        if (hoursSinceSignup < 1) {
          // Signed up less than 1 hour ago — too soon, will catch them tomorrow or next cycle
          console.log(`[NEW_USER_FOLLOWUP] ⏭️  Skipping ${phone} — signed up less than 1 hour ago`);
          skippedCount++;
          continue;
        }

        // Fetch their birthdays/anniversaries
        const birthdays = await getAllBirthdays(phone);

        // Build and send the message
        const message = buildFollowupMessage(name, birthdays);
        await sendWhatsAppMessage(phone, message);

        // Log so we never send this again (idempotent via birthday_reminder_log)
        const todayDate = now.format('YYYY-MM-DD');
        await logReminderSent(phone, todayDate, 'new_user_followup');

        console.log(`[NEW_USER_FOLLOWUP] ✅ Sent follow-up to ${phone} (${birthdays.length} entries)`);
        sentCount++;

      } catch (err) {
        console.error(`[NEW_USER_FOLLOWUP] ❌ Error processing user ${user.phone}:`, err.message);
        errorCount++;
      }
    }

    console.log(`[NEW_USER_FOLLOWUP] Completed: ${sentCount} sent, ${skippedCount} skipped, ${errorCount} error(s)`);

  } catch (err) {
    console.error('[NEW_USER_FOLLOWUP] Fatal error:', err);
    throw err;
  }
}

// Scheduler function — runs every 30 minutes (same cadence as other jobs)
function startNewUserFollowupScheduler() {
  console.log('[NEW_USER_FOLLOWUP] Starting scheduler — will check every 30 minutes');

  // Run immediately on startup
  sendNewUserFollowups().catch(err => {
    console.error('[NEW_USER_FOLLOWUP] Initial run failed:', err);
  });

  // Then every 30 minutes
  const intervalMs = 30 * 60 * 1000;
  setInterval(() => {
    sendNewUserFollowups().catch(err => {
      console.error('[NEW_USER_FOLLOWUP] Scheduled run failed:', err);
    });
  }, intervalMs);

  console.log('[NEW_USER_FOLLOWUP] Scheduler started successfully');
}

// Run if called directly (for manual testing)
if (require.main === module) {
  sendNewUserFollowups()
    .then(() => {
      console.log('[NEW_USER_FOLLOWUP] Script completed successfully');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[NEW_USER_FOLLOWUP] Script failed:', err);
      process.exit(1);
    });
}

module.exports = { sendNewUserFollowups, startNewUserFollowupScheduler };
