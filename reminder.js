require('dotenv').config();
const { Pool } = require('pg');
const moment = require('moment-timezone');
const fetch = require('node-fetch');

// Connect to Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Send WhatsApp message (reused from server.js logic)
async function sendWhatsAppMessage(to, body) {
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
        type: 'text',
        text: { body }
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

// Get all users with their timezones
async function getAllUsers() {
  const res = await pool.query(
    `
    SELECT phone, timezone
    FROM users
    WHERE timezone IS NOT NULL
    `
  );
  return res.rows;
}

// Get birthdays for a specific day and month (for reminders)
async function getBirthdaysForDate(phone, day, month) {
  const res = await pool.query(
    `
    SELECT name, day, month
    FROM birthdays
    WHERE phone = $1 AND day = $2 AND LOWER(month) = LOWER($3)
    ORDER BY name
    `,
    [phone, day, month]
  );
  return res.rows;
}

// Main reminder function
async function sendBirthdayReminders() {
  try {
    console.log('[REMINDER] Starting birthday reminder check...');
    
    // Get all users
    const users = await getAllUsers();
    console.log(`[REMINDER] Found ${users.length} user(s) to check`);

    let remindedCount = 0;
    let errorCount = 0;

    for (const user of users) {
      try {
        const { phone, timezone } = user;
        
        // Get current time in user's timezone
        const now = moment().tz(timezone);
        const currentHour = now.hour();
        const currentMinute = now.minute();
        
        // Only send reminders at 9:00 AM (user's local time)
        // Allow a small window (9:00-9:05) to account for cron timing variations
        if (currentHour !== 9 || currentMinute > 5) {
          continue;
        }
        
        // Get today's date in user's timezone
        const todayDay = now.date();
        const todayMonthNum = now.month() + 1; // moment months are 0-indexed
        
        // Convert month number to short month name (matches database format)
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                           'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const todayMonth = monthNames[todayMonthNum - 1];
        
        // Get birthdays for today
        const birthdays = await getBirthdaysForDate(phone, todayDay, todayMonth);
        
        if (birthdays.length === 0) {
          // No birthdays today for this user
          continue;
        }
        
        // Format message based on number of birthdays
        let message;
        if (birthdays.length === 1) {
          message = `🎉 Today is ${birthdays[0].name}'s birthday! Don't forget to wish them 😊`;
        } else {
          const names = birthdays.map(b => b.name).join(', ');
          message = `🎉 Today are birthdays of: ${names}! Don't forget to wish them 😊`;
        }
        
        // Send WhatsApp message
        await sendWhatsAppMessage(phone, message);
        console.log(`[REMINDER] ✅ Sent reminder to ${phone} for ${birthdays.length} birthday(s)`);
        remindedCount++;
        
      } catch (err) {
        // Log error but continue with other users
        console.error(`[REMINDER] ❌ Error processing user ${user.phone}:`, err.message);
        errorCount++;
      }
    }
    
    console.log(`[REMINDER] Completed: ${remindedCount} user(s) reminded, ${errorCount} error(s)`);
    
  } catch (err) {
    console.error('[REMINDER] Fatal error:', err);
    process.exit(1);
  } finally {
    // Close database connection
    await pool.end();
    console.log('[REMINDER] Database connection closed');
  }
}

// Run if called directly
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

module.exports = { sendBirthdayReminders };

