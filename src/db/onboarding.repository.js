const { pool } = require('./pool');

// ── Onboarding state helpers ──

// Get the onboarding state for a user
async function getOnboardingState(phone) {
  const res = await pool.query(
    `SELECT onboarding_step, onboarding_last_sent_at, onboarding_nudge_count,
            onboarding_parse_failures
     FROM users WHERE phone = $1`,
    [phone]
  );
  if (res.rows.length === 0) return null;
  return res.rows[0];
}

// Set onboarding step (resets nudge count, parse failures, and timestamp)
async function setOnboardingStep(phone, step) {
  await pool.query(
    `UPDATE users
     SET onboarding_step = $2,
         onboarding_last_sent_at = NOW(),
         onboarding_nudge_count = 0,
         onboarding_parse_failures = 0
     WHERE phone = $1`,
    [phone, step]
  );
}

// Record that we re-prompted the user within the same onboarding step because
// their reply couldn't be parsed. Restarts the nudge clock (the re-prompt is a
// fresh outgoing question) and counts the failure so we don't re-prompt forever.
async function recordOnboardingReprompt(phone) {
  await pool.query(
    `UPDATE users
     SET onboarding_last_sent_at = NOW(),
         onboarding_nudge_count = 0,
         onboarding_parse_failures = onboarding_parse_failures + 1
     WHERE phone = $1`,
    [phone]
  );
}

// Mark onboarding as complete (step → 0)
async function completeOnboarding(phone) {
  await pool.query(
    `UPDATE users
     SET onboarding_step = 0
     WHERE phone = $1`,
    [phone]
  );
}

// Increment the nudge count for a user (after sending a nudge)
async function incrementOnboardingNudgeCount(phone) {
  await pool.query(
    `UPDATE users SET onboarding_nudge_count = onboarding_nudge_count + 1 WHERE phone = $1`,
    [phone]
  );
}

// Get all mid-onboarding users who need action (nudge or abandon).
// Timing is always relative to onboarding_last_sent_at (the original step message):
//   nudge_count 0 + 5 min elapsed  → needs 1st nudge
//   nudge_count 1 + 15 min elapsed → needs 2nd nudge
//   nudge_count 2 + 30 min elapsed → needs abandonment
async function getOnboardingUsersNeedingAction() {
  const res = await pool.query(
    `SELECT phone, onboarding_step, onboarding_nudge_count
     FROM users
     WHERE onboarding_step > 0
       AND (
         (onboarding_nudge_count = 0 AND onboarding_last_sent_at < NOW() - INTERVAL '5 minutes')
         OR (onboarding_nudge_count = 1 AND onboarding_last_sent_at < NOW() - INTERVAL '15 minutes')
         OR (onboarding_nudge_count >= 2 AND onboarding_last_sent_at < NOW() - INTERVAL '30 minutes')
       )`
  );
  return res.rows;
}

// Get new users created within the last 24 hours who haven't received the followup nudge yet
async function getNewUsersForFollowup() {
  const res = await pool.query(
    `
    SELECT u.phone, u.timezone, u.created_at, u.name
    FROM users u
    WHERE u.created_at >= NOW() - INTERVAL '24 hours'
      AND NOT EXISTS (
        SELECT 1 FROM birthday_reminder_log brl
        WHERE brl.phone = u.phone AND brl.type = 'new_user_followup'
      )
    `
  );
  return res.rows;
}

module.exports = {
  getOnboardingState,
  setOnboardingStep,
  recordOnboardingReprompt,
  completeOnboarding,
  incrementOnboardingNudgeCount,
  getOnboardingUsersNeedingAction,
  getNewUsersForFollowup,
};
