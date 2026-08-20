require('dotenv').config();
const moment = require('moment-timezone');
const { 
  pool, 
  getAllUsers, 
  getBirthdaysForReminder, 
  hasReminderBeenSentToday, 
  logReminderSent 
} = require('../../db.js');
const { sendTemplateMessage } = require('../services/whatsapp.service');
const { formatAgeSuffix } = require('../utils/age.utils');

// Main reminder function
async function sendBirthdayReminders() {
  try {
    console.log('[REMINDER] Starting birthday reminder check...');
    
    // Get all users
    const users = await getAllUsers();
    console.log(`[REMINDER] Found ${users.length} user(s) to check`);

    let remindedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;

    for (const user of users) {
      try {
        const { phone, timezone } = user;
        const userTimezone = timezone || 'Asia/Kolkata'; // Default timezone
        
        // Get current time in user's timezone
        const now = moment().tz(userTimezone);
        const todayAt9AM = now.clone().startOf('day').hour(9).minute(0).second(0).millisecond(0);
        
        // Only send reminders after 9:00 AM in the user's local timezone.
        // The daily reminder log below prevents duplicate sends later in the day.
        if (now.isBefore(todayAt9AM)) {
          continue;
        }
        
        // Get today's date in user's timezone (YYYY-MM-DD format)
        const todayDate = now.format('YYYY-MM-DD');
        const todayDay = now.date();
        const todayMonthNum = now.month() + 1; // moment months are 0-indexed
        
        // Convert month number to short month name (matches database format)
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                           'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const todayMonth = monthNames[todayMonthNum - 1];
        
        // Check if reminder was already sent today (idempotent check)
        const alreadySent = await hasReminderBeenSentToday(phone, todayDate, 'daily_today');
        if (alreadySent) {
          console.log(`[REMINDER] ⏭️  Skipping ${phone} - reminder already sent today`);
          skippedCount++;
          continue;
        }
        
        // Get birthdays for today, excluding any event the user added today.
        // If someone just saved an event that falls on today, they already know
        // about it, so sending a same-day reminder makes no sense.
        const birthdays = await getBirthdaysForReminder(phone, todayDay, todayMonth, userTimezone, todayDate);
        
        if (birthdays.length === 0) {
          // No birthdays today for this user (or the only ones were just added today)
          continue;
        }
        
        // Prepare event phrase for the message. The utility template reads
        // "It's *{{1}}* today. ...", so {{1}} is a possessive event phrase
        // (e.g. "John's birthday (turns 31)") rather than a bare name.
        const names = birthdays.map(b => {
          const label = b.type === 'anniversary' ? 'anniversary' : 'birthday';
          const rel = b.relationship ? ` (${b.relationship})` : '';
          const age = formatAgeSuffix(b.type, b.year, now.year());
          return `${b.name}${rel}'s ${label}${age}`;
        });
        const namesString = names.join(', ');
        
        // Utility template (won't get throttled like the old marketing template).
        // Template name: "event_details_reminder_3" (must be created in Meta dashboard).
        // Body: "It's *{{1}}* today. This event is on your saved reminders."
        await sendTemplateMessage(phone, 'event_details_reminder_3', [namesString], 'en_US');
        
        // Log that reminder was sent (idempotent - prevents duplicates)
        await logReminderSent(phone, todayDate, 'daily_today');
        
        console.log(`[REMINDER] ✅ Sent TEMPLATE reminder to ${phone} for ${birthdays.length} birthday(s): ${namesString}`);
        remindedCount++;
        
      } catch (err) {
        // Log error but continue with other users
        console.error(`[REMINDER] ❌ Error processing user ${user.phone}:`, err.message);
        errorCount++;
      }
    }
    
    console.log(`[REMINDER] Completed: ${remindedCount} user(s) reminded, ${skippedCount} skipped (already sent), ${errorCount} error(s)`);
    
  } catch (err) {
    console.error('[REMINDER] Fatal error:', err);
    // Don't exit process - let scheduler continue
    throw err;
  }
}

// Scheduler function - runs reminder check every 30 minutes
function startReminderScheduler() {
  console.log('[REMINDER] Starting scheduler - will check every 30 minutes');
  console.log('⏰ Birthday reminder job running (30 min interval)');
  
  // Run immediately on startup
  sendBirthdayReminders().catch(err => {
    console.error('[REMINDER] Initial run failed:', err);
  });
  
  // Then run every 30 minutes (1800000 ms)
  const intervalMs = 30 * 60 * 1000; // 30 minutes
  setInterval(() => {
    sendBirthdayReminders().catch(err => {
      console.error('[REMINDER] Scheduled run failed:', err);
    });
  }, intervalMs);
  
  console.log('[REMINDER] Scheduler started successfully');
}

// Run if called directly (for manual testing)
if (require.main === module) {
  sendBirthdayReminders()
    .then(() => {
      console.log('[REMINDER] Script completed successfully');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[REMINDER] Script failed:', err);
      process.exit(1);
    });
}

module.exports = { sendBirthdayReminders, startReminderScheduler };
