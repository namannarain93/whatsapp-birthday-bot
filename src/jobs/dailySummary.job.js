require('dotenv').config();
const moment = require('moment-timezone');
const { pool } = require('../../db.js');
const metrics = require('../../metrics');
const { generateDailyMetricsSummary } = require('../../llm');

const SUMMARY_TIMEZONE = 'Asia/Kolkata';
const SUMMARY_HOUR = 7; // generate at/after 7 AM IST

async function generateDailySummary() {
  try {
    const now = moment().tz(SUMMARY_TIMEZONE);

    // Only generate at or after 7 AM local time
    if (now.hour() < SUMMARY_HOUR) {
      return;
    }

    const today = now.format('YYYY-MM-DD');

    // Idempotent check - skip if today's summary already exists
    const existing = await pool.query(
      `SELECT 1 FROM daily_summaries WHERE summary_date = $1`,
      [today]
    );
    if (existing.rows.length > 0) {
      return;
    }

    console.log('[DAILY SUMMARY] Generating AI summary for', today);

    const snapshot = await metrics.getDailySummarySnapshot();
    if (!snapshot) {
      console.error('[DAILY SUMMARY] Failed to build metrics snapshot, will retry next run');
      return;
    }

    const summaryText = await generateDailyMetricsSummary(snapshot);

    await pool.query(
      `INSERT INTO daily_summaries (summary_date, summary_text)
       VALUES ($1, $2)
       ON CONFLICT (summary_date) DO NOTHING`,
      [today, summaryText]
    );

    console.log('[DAILY SUMMARY] ✅ Summary stored for', today);
  } catch (err) {
    console.error('[DAILY SUMMARY] Error generating summary:', err.message);
    // Don't rethrow - the scheduler will retry on the next interval
  }
}

// Scheduler - checks every 15 minutes, so the summary lands between 7:00 and 7:15 AM
function startDailySummaryScheduler() {
  console.log('[DAILY SUMMARY] Starting scheduler - will check every 15 minutes');

  // Run immediately on startup (no-op if before 7 AM or already generated)
  generateDailySummary().catch(err => {
    console.error('[DAILY SUMMARY] Initial run failed:', err);
  });

  const intervalMs = 15 * 60 * 1000; // 15 minutes
  setInterval(() => {
    generateDailySummary().catch(err => {
      console.error('[DAILY SUMMARY] Scheduled run failed:', err);
    });
  }, intervalMs);

  console.log('[DAILY SUMMARY] Scheduler started successfully');
}

// Run if called directly (for manual testing)
if (require.main === module) {
  generateDailySummary()
    .then(() => {
      console.log('[DAILY SUMMARY] Script completed successfully');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[DAILY SUMMARY] Script failed:', err);
      process.exit(1);
    });
}

module.exports = { generateDailySummary, startDailySummaryScheduler };
