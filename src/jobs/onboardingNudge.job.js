require('dotenv').config();
const {
  getOnboardingUsersNeedingAction,
  incrementOnboardingNudgeCount,
  completeOnboarding
} = require('../../db.js');
const { sendWhatsAppMessage } = require('../services/whatsapp.service');

// Nudge messages per onboarding step
const NUDGE_MESSAGES = {
  1: "Go ahead — just type your name and birthday like this: *YourName 29 Aug* 😊",
  2: "Don't stop now! Add at least two people close to you. Just type:\n*Name 14 Feb* 💪",
  3: "Anyone you missed? One more won't hurt 😄\nType: *Name 14 Feb*"
};

// Main nudge + abandon job
// Timing (all relative to the original step message):
//   5 min  → 1st nudge
//   15 min → 2nd nudge
//   30 min → abandon onboarding
async function runOnboardingNudgeJob() {
  try {
    console.log('[ONBOARDING_NUDGE] Running nudge check...');

    const users = await getOnboardingUsersNeedingAction();

    let nudgedCount = 0;
    let abandonedCount = 0;

    for (const user of users) {
      try {
        if (user.onboarding_nudge_count >= 2) {
          // 30 min elapsed after two nudges — give up
          await completeOnboarding(user.phone);
          console.log(`[ONBOARDING_NUDGE] ⏭️  Abandoned onboarding for ${user.phone}`);
          abandonedCount++;
        } else {
          // Send nudge (1st at 5 min, 2nd at 15 min)
          const nudgeMsg = NUDGE_MESSAGES[user.onboarding_step];
          if (nudgeMsg) {
            await sendWhatsAppMessage(user.phone, nudgeMsg);
            await incrementOnboardingNudgeCount(user.phone);
            const which = user.onboarding_nudge_count === 0 ? '1st' : '2nd';
            console.log(`[ONBOARDING_NUDGE] ✅ Sent ${which} nudge to ${user.phone} (step ${user.onboarding_step})`);
            nudgedCount++;
          }
        }
      } catch (err) {
        console.error(`[ONBOARDING_NUDGE] ❌ Error processing ${user.phone}:`, err.message);
      }
    }

    console.log(`[ONBOARDING_NUDGE] Done: ${nudgedCount} nudged, ${abandonedCount} abandoned`);

  } catch (err) {
    console.error('[ONBOARDING_NUDGE] Fatal error:', err);
  }
}

// Scheduler — runs every 2 minutes (tight loop because nudge timing matters)
function startOnboardingNudgeScheduler() {
  console.log('[ONBOARDING_NUDGE] Starting scheduler — will check every 2 minutes');

  // Run immediately on startup
  runOnboardingNudgeJob().catch(err => {
    console.error('[ONBOARDING_NUDGE] Initial run failed:', err);
  });

  // Then every 2 minutes
  const intervalMs = 2 * 60 * 1000;
  setInterval(() => {
    runOnboardingNudgeJob().catch(err => {
      console.error('[ONBOARDING_NUDGE] Scheduled run failed:', err);
    });
  }, intervalMs);

  console.log('[ONBOARDING_NUDGE] Scheduler started successfully');
}

// Run if called directly (for manual testing)
if (require.main === module) {
  runOnboardingNudgeJob()
    .then(() => {
      console.log('[ONBOARDING_NUDGE] Script completed successfully');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[ONBOARDING_NUDGE] Script failed:', err);
      process.exit(1);
    });
}

module.exports = { runOnboardingNudgeJob, startOnboardingNudgeScheduler };
