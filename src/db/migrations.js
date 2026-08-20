const { pool } = require('./pool');
const { applyReviewedBirthdayFixes } = require('./reviewed-birthday-fixes');

// Create tables on startup (exported as dbReady so callers can await it)
const dbReady = (async () => {
  try {
    // Create users table for tracking welcome state, timezone, and last interaction
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        phone TEXT PRIMARY KEY,
        has_seen_welcome BOOLEAN NOT NULL DEFAULT false,
        timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
        last_interaction_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Add timezone column if it doesn't exist (for existing databases)
    await pool.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata';
    `);
    
    // Add last_interaction_at column if it doesn't exist (for existing databases)
    await pool.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS last_interaction_at TIMESTAMP;
    `);
    
    // Add last_weekly_reminder_sent column if it doesn't exist (for existing databases)
    // Use DO block for safer migration (works in all PostgreSQL versions)
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' AND column_name = 'last_weekly_reminder_sent'
        ) THEN
          ALTER TABLE users ADD COLUMN last_weekly_reminder_sent TIMESTAMP;
        END IF;
      END $$;
    `);
    console.log('✅ Weekly reminder column ensured');

    // Add name column if it doesn't exist (for storing user's own name)
    await pool.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS name TEXT;
    `);
    console.log('✅ User name column ensured');

    // Add onboarding state columns (for multi-step onboarding flow)
    await pool.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS onboarding_step INTEGER NOT NULL DEFAULT 0;
    `);
    await pool.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS onboarding_last_sent_at TIMESTAMP;
    `);
    await pool.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS onboarding_nudge_count INTEGER NOT NULL DEFAULT 0;
    `);
    await pool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS onboarding_parse_failures INTEGER NOT NULL DEFAULT 0;
    `);
    console.log('✅ Onboarding state columns ensured');

    // Add pending_action column (stores JSON context when bot asks a clarification question)
    await pool.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS pending_action JSONB;
    `);
    console.log('✅ Pending action column ensured');

    // Create birthdays table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS birthdays (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        name TEXT NOT NULL,
        day INTEGER NOT NULL,
        month TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'birthday',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (phone, name, day, month, type)
      );
    `);
    
    // Add created_at column if it doesn't exist (for existing databases)
    await pool.query(`
      ALTER TABLE birthdays 
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    `);
    
    // Add type column if it doesn't exist (for existing databases)
    await pool.query(`
      ALTER TABLE birthdays 
      ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'birthday';
    `);

    // Birth/wedding year (optional — enables age in reminders)
    await pool.query(`
      ALTER TABLE birthdays
      ADD COLUMN IF NOT EXISTS year INTEGER;
    `);

    // Relationship to the user (optional, e.g. "Mom", "wife")
    await pool.query(`
      ALTER TABLE birthdays
      ADD COLUMN IF NOT EXISTS relationship TEXT;
    `);
    console.log('✅ Birthday year and relationship columns ensured');
    
    // Create birthday_reminder_log table for tracking sent reminders
    await pool.query(`
      CREATE TABLE IF NOT EXISTS birthday_reminder_log (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        date DATE NOT NULL,
        type TEXT NOT NULL DEFAULT 'daily_today',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (phone, date, type)
      );
    `);
    
    // Create messages table for admin metrics
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        wamid TEXT UNIQUE,
        recipient_phone TEXT,
        status TEXT, -- sent / delivered / failed / received
        error_code TEXT,
        template_name TEXT,
        direction TEXT, -- 'incoming' or 'outgoing'
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    // Add direction column if it doesn't exist (for existing databases)
    await pool.query(`
      ALTER TABLE messages 
      ADD COLUMN IF NOT EXISTS direction TEXT;
    `);
    
    // Add message_body column if it doesn't exist (for incoming message text)
    await pool.query(`
      ALTER TABLE messages 
      ADD COLUMN IF NOT EXISTS message_body TEXT;
    `);
    
    // Add intent column if it doesn't exist (for tracking parsed intent on incoming messages)
    await pool.query(`
      ALTER TABLE messages 
      ADD COLUMN IF NOT EXISTS intent TEXT;
    `);
    console.log('✅ Message intent column ensured');
    
    // Create index on (phone, date, type) for faster lookups
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_birthday_reminder_log_phone_date_type 
      ON birthday_reminder_log (phone, date, type);
    `);
    
    // Create daily_summaries table for AI-generated daily metric summaries
    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_summaries (
        id SERIAL PRIMARY KEY,
        summary_date DATE NOT NULL UNIQUE,
        summary_text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Daily summaries table ensured');

    // Monthly snapshots of Sunday-reminder-eligible ("active") users.
    // Written daily so past months keep their last known count after month-end.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS monthly_active_user_snapshots (
        month DATE PRIMARY KEY,
        active_users INTEGER NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Monthly active-user snapshots table ensured');

    try {
      const summary = await applyReviewedBirthdayFixes(pool);
      console.log(
        `✅ Reviewed birthday fixes applied (updated ${summary.updated}, merged ${summary.merged}, deleted ${summary.deleted}, skipped ${summary.skipped})`
      );
    } catch (fixErr) {
      console.error('Reviewed birthday fixes failed:', fixErr);
    }
    
    console.log('Database tables ready (Postgres)');
  } catch (err) {
    console.error('Error creating tables:', err);
  }
})();

module.exports = { dbReady };
