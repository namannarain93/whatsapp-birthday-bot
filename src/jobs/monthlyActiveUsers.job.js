require('dotenv').config();
const moment = require('moment-timezone');
const { snapshotMonthlyActiveUsers } = require('../../metrics');

const SNAPSHOT_TIMEZONE = 'Asia/Kolkata';

// Persist the current month's Sunday-reminder-eligible ("active") user count.
// Runs daily so when the month rolls over, the previous month keeps its last value.
async function snapshotActiveUsers() {
  try {
    const result = await snapshotMonthlyActiveUsers();
    if (!result) {
      console.error('[MONTHLY ACTIVE USERS] Snapshot failed, will retry next run');
      return;
    }
    console.log(
      `[MONTHLY ACTIVE USERS] ✅ Snapshot for ${result.month}: ${result.activeUsers} active users`
    );
  } catch (err) {
    console.error('[MONTHLY ACTIVE USERS] Error:', err.message);
  }
}

function startMonthlyActiveUsersScheduler() {
  console.log('[MONTHLY ACTIVE USERS] Starting scheduler - will snapshot daily (IST)');

  // Run immediately on startup so the current month is never blank after deploy
  snapshotActiveUsers().catch(err => {
    console.error('[MONTHLY ACTIVE USERS] Initial run failed:', err);
  });

  // Re-snapshot roughly once a day. Interval is 24h from process start; that's
  // fine for a rolling monthly number — we only need at least one write per day.
  const intervalMs = 24 * 60 * 60 * 1000;
  setInterval(() => {
    // Keep the log timezone explicit even though the snapshot itself uses IST
    const now = moment().tz(SNAPSHOT_TIMEZONE).format('YYYY-MM-DD HH:mm');
    console.log(`[MONTHLY ACTIVE USERS] Scheduled run at ${now} IST`);
    snapshotActiveUsers().catch(err => {
      console.error('[MONTHLY ACTIVE USERS] Scheduled run failed:', err);
    });
  }, intervalMs);

  console.log('[MONTHLY ACTIVE USERS] Scheduler started successfully');
}

if (require.main === module) {
  snapshotActiveUsers()
    .then(() => {
      console.log('[MONTHLY ACTIVE USERS] Script completed successfully');
      process.exit(0);
    })
    .catch(err => {
      console.error('[MONTHLY ACTIVE USERS] Script failed:', err);
      process.exit(1);
    });
}

module.exports = { snapshotActiveUsers, startMonthlyActiveUsersScheduler };
