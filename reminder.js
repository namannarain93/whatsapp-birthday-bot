require('dotenv').config();
const moment = require('moment-timezone');
const { 
  pool, 
  getAllUsers, 
  getBirthdaysForDate, 
  hasReminderBeenSentToday, 
  logReminderSent 
} = require('./db.js');
const { sendTemplateMessage } = require('./src/services/whatsapp.service');

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
        const currentHour = now.hour();
        const currentMinute = now.minute();
        
        // Only send reminders at 9:00 AM (user's local time)
        // Allow a small window (9:00-9:05) to account for scheduler timing variations
        if (currentHour !== 9 || currentMinute > 5) {
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
        
        // Get birthdays for today
        const birthdays = await getBirthdaysForDate(phone, todayDay, todayMonth);
        
        if (birthdays.length === 0) {
          // No birthdays today for this user
          continue;
        }
        
        // Prepare names for message
        const names = birthdays.map(b => {
          return b.type === 'anniversary' ? `${b.name} (Anniversary)` : b.name;
        });
        const namesString = names.join(', ');
        
        // Always use template message (as per requirements)
        // Template name: "birthday_reminder" (must be created in Meta dashboard)
        // Template body should accept {{1}} parameter with names
        await sendTemplateMessage(phone, 'birthday_reminder', [namesString]);
        
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
