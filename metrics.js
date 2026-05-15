const { pool } = require('./db.js');
const { getSundayReminderStatus } = require('./src/db/user.repository');

async function getTotalMessagesAllTime() {
  try {
    const result = await pool.query(`SELECT COUNT(*) FROM messages`);
    return parseInt(result.rows[0].count);
  } catch (err) {
    console.error('Error in getTotalMessagesAllTime:', err);
    return 0;
  }
}

async function getMessagesToday() {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) FROM messages WHERE created_at >= CURRENT_DATE AND direction = 'outgoing'`
    );
    return parseInt(result.rows[0].count);
  } catch (err) {
    console.error('Error in getMessagesToday:', err);
    return 0;
  }
}

async function getFailedToday() {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) FROM messages WHERE status = 'failed' AND created_at >= CURRENT_DATE`
    );
    return parseInt(result.rows[0].count);
  } catch (err) {
    console.error('Error in getFailedToday:', err);
    return 0;
  }
}

async function getFailureRateToday() {
  try {
    const sent = await getMessagesToday();
    if (sent === 0) return 0;
    const failed = await getFailedToday();
    return ((failed / sent) * 100).toFixed(1);
  } catch (err) {
    console.error('Error in getFailureRateToday:', err);
    return 0;
  }
}

function getDateKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

async function getLast7DayTrend() {
  try {
    const result = await pool.query(
      `SELECT DATE(created_at) as day, COUNT(*) 
       FROM messages
       WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
       GROUP BY day
       ORDER BY day`
    );
    // Build a lookup of counts by day string (YYYY-MM-DD)
    const countsByDay = {};
    result.rows.forEach(row => {
      const key = getDateKey(row.day);
      countsByDay[key] = parseInt(row.count) || 0;
    });

    // Generate a continuous range from 7 days ago through today (inclusive)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - 7);

    const filled = [];
    for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
      const key = getDateKey(d);
      filled.push({
        day: new Date(d),
        count: countsByDay[key] || 0
      });
    }

    return filled;
  } catch (err) {
    console.error('Error in getLast7DayTrend:', err);
    return [];
  }
}

async function getFailureBreakdown() {
  try {
    const result = await pool.query(
      `SELECT error_code, COUNT(*)
       FROM messages
       WHERE status = 'failed'
       GROUP BY error_code
       ORDER BY COUNT(*) DESC`
    );
    return result.rows;
  } catch (err) {
    console.error('Error in getFailureBreakdown:', err);
    return [];
  }
}

// Failures grouped by phone number and error code — used to spot repeatedly failing recipients
// Includes first and last failure timestamps per (phone, error_code) for full historical context
async function getFailuresByPhone() {
  try {
    const result = await pool.query(
      `SELECT
         recipient_phone,
         COALESCE(error_code::text, 'Unknown') AS error_code,
         COUNT(*) AS count,
         MIN(created_at) AS first_failure,
         MAX(created_at) AS last_failure
       FROM messages
       WHERE status = 'failed' AND direction = 'outgoing'
       GROUP BY recipient_phone, error_code
       ORDER BY recipient_phone`
    );
    return result.rows;
  } catch (err) {
    console.error('Error in getFailuresByPhone:', err);
    return [];
  }
}

async function getHourlyTrendToday() {
  try {
    // We use Asia/Kolkata since that's the bot's primary timezone
    const result = await pool.query(
      `SELECT 
         EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') AS hour, 
         direction,
         COUNT(*) 
       FROM messages 
       WHERE created_at >= CURRENT_DATE 
       GROUP BY hour, direction
       ORDER BY hour`
    );

    // Initialize arrays for 24 hours
    const incoming = Array(24).fill(0);
    const outgoing = Array(24).fill(0);
    
    result.rows.forEach(row => {
      const h = parseInt(row.hour);
      if (row.direction === 'incoming') {
        incoming[h] = parseInt(row.count);
      } else {
        outgoing[h] = parseInt(row.count);
      }
    });
    
    return { incoming, outgoing };
  } catch (err) {
    console.error('Error in getHourlyTrendToday:', err);
    return { incoming: Array(24).fill(0), outgoing: Array(24).fill(0) };
  }
}

async function getTotalUsersCount() {
  try {
    // Cumulative count starting from today (2026-01-31)
    const result = await pool.query(
      `SELECT COUNT(*) FROM users WHERE created_at >= '2026-01-31'`
    );
    return parseInt(result.rows[0].count);
  } catch (err) {
    console.error('Error in getTotalUsersCount:', err);
    return 0;
  }
}

async function getTotalEventsCount() {
  try {
    const result = await pool.query(`SELECT COUNT(*) FROM birthdays`);
    return parseInt(result.rows[0].count);
  } catch (err) {
    console.error('Error in getTotalEventsCount:', err);
    return 0;
  }
}

async function getTotalAnniversariesCount() {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) FROM birthdays WHERE LOWER(type) = 'anniversary'`
    );
    return parseInt(result.rows[0].count);
  } catch (err) {
    console.error('Error in getTotalAnniversariesCount:', err);
    return 0;
  }
}

async function getEventsAddedToday() {
  try {
    // Count events added since 12:00 AM IST today
    // IST is UTC+5:30, so 12 AM IST = previous day 6:30 PM UTC
    const result = await pool.query(
      `SELECT 
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE LOWER(type) = 'birthday') AS birthdays,
         COUNT(*) FILTER (WHERE LOWER(type) = 'anniversary') AS anniversaries
       FROM birthdays
       WHERE created_at >= (CURRENT_DATE AT TIME ZONE 'Asia/Kolkata')`
    );
    return {
      total: parseInt(result.rows[0].total) || 0,
      birthdays: parseInt(result.rows[0].birthdays) || 0,
      anniversaries: parseInt(result.rows[0].anniversaries) || 0
    };
  } catch (err) {
    console.error('Error in getEventsAddedToday:', err);
    return { total: 0, birthdays: 0, anniversaries: 0 };
  }
}

async function getWeeklyEventsTrend() {
  try {
    const result = await pool.query(
      `SELECT 
         DATE_TRUNC('week', created_at) AS week,
         COUNT(*) FILTER (WHERE LOWER(type) = 'birthday') AS birthdays,
         COUNT(*) FILTER (WHERE LOWER(type) = 'anniversary') AS anniversaries
       FROM birthdays 
       WHERE created_at >= CURRENT_DATE - INTERVAL '5 weeks'
       GROUP BY week
       ORDER BY week`
    );

    return result.rows.map(row => ({
      week: new Date(row.week).toLocaleDateString(),
      birthdays: parseInt(row.birthdays) || 0,
      anniversaries: parseInt(row.anniversaries) || 0
    }));
  } catch (err) {
    console.error('Error in getWeeklyEventsTrend:', err);
    return [];
  }
}

async function getRecentMessageStatusTable(limit = 25) {
  try {
    const result = await pool.query(
      `SELECT recipient_phone, template_name, status, error_code, created_at
       FROM messages
       WHERE direction = 'outgoing'
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    return result.rows.map(row => {
      const isTemplate = !!row.template_name;
      const isSuccess = row.status === 'delivered';
      return {
        phone: row.recipient_phone || 'Unknown',
        messageType: isTemplate ? 'Meta template' : 'Free form',
        templateName: row.template_name || '—',
        messageStatus: isSuccess ? 'Success' : 'Failure',
        failureCode: isSuccess ? 'NA' : (row.error_code || 'Unknown'),
        timestamp: row.created_at
          ? new Date(row.created_at).toLocaleString('en-IN', {
              timeZone: 'Asia/Kolkata',
              year: 'numeric',
              month: 'short',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: true
            })
          : 'Unknown'
      };
    });
  } catch (err) {
    console.error('Error in getRecentMessageStatusTable:', err);
    return [];
  }
}

async function getUserEventSummaryTable(limit = 25) {
  try {
    const result = await pool.query(
      `
      WITH all_phones AS (
        SELECT phone FROM users
        UNION
        SELECT phone FROM birthdays
      ),
      event_counts AS (
        SELECT
          phone,
          COUNT(*) FILTER (WHERE LOWER(type) = 'birthday') AS birthdays,
          COUNT(*) FILTER (WHERE LOWER(type) = 'anniversary') AS anniversaries,
          COUNT(*) AS total_events
        FROM birthdays
        GROUP BY phone
      )
      SELECT
        ap.phone,
        COALESCE(ec.birthdays, 0) AS birthdays,
        COALESCE(ec.anniversaries, 0) AS anniversaries,
        COALESCE(ec.total_events, 0) AS total_events,
        u.last_interaction_at
      FROM all_phones ap
      LEFT JOIN event_counts ec ON ec.phone = ap.phone
      LEFT JOIN users u ON u.phone = ap.phone
      ORDER BY u.last_interaction_at DESC NULLS LAST, ap.phone
      LIMIT $1
      `,
      [limit]
    );

    return result.rows.map(row => ({
      phone: row.phone || 'Unknown',
      birthdays: parseInt(row.birthdays, 10) || 0,
      anniversaries: parseInt(row.anniversaries, 10) || 0,
      totalEvents: parseInt(row.total_events, 10) || 0,
      lastInteractionTs: row.last_interaction_at
        ? new Date(row.last_interaction_at).getTime()
        : 0,
      lastInteraction: row.last_interaction_at
        ? new Date(row.last_interaction_at).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
          })
        : 'Unknown'
    }));
  } catch (err) {
    console.error('Error in getUserEventSummaryTable:', err);
    return [];
  }
}

async function getRecentIncomingMessages(limit = 25) {
  try {
    const result = await pool.query(
      `SELECT recipient_phone, message_body, created_at
       FROM messages
       WHERE direction = 'incoming'
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    return result.rows.map(row => ({
      phone: row.recipient_phone || 'Unknown',
      message: row.message_body || '—',
      timestamp: row.created_at
        ? new Date(row.created_at).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
          })
        : 'Unknown'
    }));
  } catch (err) {
    console.error('Error in getRecentIncomingMessages:', err);
    return [];
  }
}

async function getAllUsersTable() {
  try {
    const result = await pool.query(
      `SELECT
         u.phone,
         u.timezone,
         u.last_interaction_at,
         u.created_at,
         COUNT(b.id) AS event_count
       FROM users u
       LEFT JOIN birthdays b ON b.phone = u.phone
       WHERE u.created_at >= '2026-01-31'
       GROUP BY u.phone, u.timezone, u.last_interaction_at, u.created_at
       ORDER BY u.created_at DESC`
    );

    const istOpts = {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    };

    return result.rows.map(row => {
      const eventCount = parseInt(row.event_count, 10) || 0;
      const isActive = getSundayReminderStatus(row.last_interaction_at) === 'active';
      const eligible = isActive && eventCount > 0 && !!row.timezone;
      const sundayReminderStatus = eligible ? 'active' : 'dormant';
      return {
        phone: row.phone || 'Unknown',
        timezone: row.timezone || 'Unknown',
        eventCount,
        sundayReminderStatus,
        sundayReminderActive: eligible ? 1 : 0,
        lastInteractionTs: row.last_interaction_at
          ? new Date(row.last_interaction_at).getTime()
          : 0,
        lastInteraction: row.last_interaction_at
          ? new Date(row.last_interaction_at).toLocaleString('en-IN', istOpts)
          : 'Never',
        createdAtTs: row.created_at ? new Date(row.created_at).getTime() : 0,
        createdAt: row.created_at
          ? new Date(row.created_at).toLocaleString('en-IN', istOpts)
          : 'Unknown'
      };
    });
  } catch (err) {
    console.error('Error in getAllUsersTable:', err);
    return [];
  }
}

// Global Sunday reminder eligibility counts across ALL users.
// Eligible = has at least one saved event + timezone set + interacted within 3 months.
async function getSundayReminderStats() {
  try {
    const result = await pool.query(
      `
      WITH eligibility AS (
        SELECT
          u.phone,
          (
            u.timezone IS NOT NULL
            AND EXISTS (SELECT 1 FROM birthdays b WHERE b.phone = u.phone)
            AND u.last_interaction_at IS NOT NULL
            AND u.last_interaction_at >= NOW() - INTERVAL '3 months'
          ) AS is_active
        FROM users u
      )
      SELECT
        COUNT(*) FILTER (WHERE is_active) AS active,
        COUNT(*) FILTER (WHERE NOT is_active) AS dormant,
        COUNT(*) AS total
      FROM eligibility
      `
    );

    const row = result.rows[0] || {};
    return {
      active: parseInt(row.active, 10) || 0,
      dormant: parseInt(row.dormant, 10) || 0,
      total: parseInt(row.total, 10) || 0
    };
  } catch (err) {
    console.error('Error in getSundayReminderStats:', err);
    return { active: 0, dormant: 0, total: 0 };
  }
}

async function getAllEventsTable() {
  try {
    const result = await pool.query(
      `SELECT phone, name, day, month, type, created_at
       FROM birthdays
       ORDER BY created_at DESC`
    );

    return result.rows.map(row => ({
      phone: row.phone || 'Unknown',
      name: row.name || 'Unknown',
      day: row.day,
      month: row.month,
      type: row.type || 'birthday',
      createdAt: row.created_at
        ? new Date(row.created_at).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
          })
        : 'Unknown'
    }));
  } catch (err) {
    console.error('Error in getAllEventsTable:', err);
    return [];
  }
}

// ── ONBOARDING FUNNEL METRICS ──

// Get count of users at each onboarding step (0 = completed/not started, 1-3 = in progress)
async function getOnboardingFunnel() {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE onboarding_step = 0 AND has_seen_welcome = true) AS completed,
        COUNT(*) FILTER (WHERE onboarding_step = 1) AS step_1,
        COUNT(*) FILTER (WHERE onboarding_step = 2) AS step_2,
        COUNT(*) FILTER (WHERE onboarding_step = 3) AS step_3
      FROM users
      WHERE created_at >= '2026-01-31'
    `);
    const row = result.rows[0];
    return {
      completed: parseInt(row.completed) || 0,
      step_1: parseInt(row.step_1) || 0,
      step_2: parseInt(row.step_2) || 0,
      step_3: parseInt(row.step_3) || 0
    };
  } catch (err) {
    console.error('Error in getOnboardingFunnel:', err);
    return { completed: 0, step_1: 0, step_2: 0, step_3: 0 };
  }
}

// Onboarding completion rate (% of users who finished all 4 steps)
async function getOnboardingCompletionRate() {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE onboarding_step = 0 AND has_seen_welcome = true) AS completed
      FROM users
      WHERE created_at >= '2026-01-31'
    `);
    const row = result.rows[0];
    const total = parseInt(row.total) || 0;
    const completed = parseInt(row.completed) || 0;
    if (total === 0) return 0;
    return ((completed / total) * 100).toFixed(1);
  } catch (err) {
    console.error('Error in getOnboardingCompletionRate:', err);
    return 0;
  }
}

// Distribution of nudge counts across all users
async function getNudgeDistribution() {
  try {
    const result = await pool.query(`
      SELECT onboarding_nudge_count AS nudges, COUNT(*) AS count
      FROM users
      WHERE created_at >= '2026-01-31'
      GROUP BY onboarding_nudge_count
      ORDER BY onboarding_nudge_count
    `);
    return result.rows.map(row => ({
      nudges: parseInt(row.nudges),
      count: parseInt(row.count)
    }));
  } catch (err) {
    console.error('Error in getNudgeDistribution:', err);
    return [];
  }
}

// ── DAU / WAU METRICS ──

// Daily active users (distinct phones that sent an incoming message today)
async function getDAU() {
  try {
    const result = await pool.query(`
      SELECT COUNT(DISTINCT recipient_phone) AS dau
      FROM messages
      WHERE direction = 'incoming'
        AND created_at >= CURRENT_DATE
    `);
    return parseInt(result.rows[0].dau) || 0;
  } catch (err) {
    console.error('Error in getDAU:', err);
    return 0;
  }
}

// Weekly active users (distinct phones that sent an incoming message in last 7 days)
async function getWAU() {
  try {
    const result = await pool.query(`
      SELECT COUNT(DISTINCT recipient_phone) AS wau
      FROM messages
      WHERE direction = 'incoming'
        AND created_at >= CURRENT_DATE - INTERVAL '7 days'
    `);
    return parseInt(result.rows[0].wau) || 0;
  } catch (err) {
    console.error('Error in getWAU:', err);
    return 0;
  }
}

// DAU trend over the last 30 days
async function getDAUTrend() {
  try {
    const result = await pool.query(`
      SELECT DATE(created_at) AS day, COUNT(DISTINCT recipient_phone) AS dau
      FROM messages
      WHERE direction = 'incoming'
        AND created_at >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY day
      ORDER BY day
    `);
    // Build a lookup of DAU by day string (YYYY-MM-DD)
    const dauByDay = {};
    result.rows.forEach(row => {
      const key = getDateKey(row.day);
      dauByDay[key] = parseInt(row.dau) || 0;
    });

    // Generate a continuous range from 30 days ago through today (inclusive)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - 30);

    const filled = [];
    for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
      const key = getDateKey(d);
      filled.push({
        day: new Date(d),
        dau: dauByDay[key] || 0
      });
    }

    return filled;
  } catch (err) {
    console.error('Error in getDAUTrend:', err);
    return [];
  }
}

// ── INTENT DISTRIBUTION METRICS ──

// Breakdown of all parsed intents
async function getIntentDistribution() {
  try {
    const result = await pool.query(`
      SELECT COALESCE(intent, 'untracked') AS intent, COUNT(*) AS count
      FROM messages
      WHERE direction = 'incoming'
      GROUP BY intent
      ORDER BY count DESC
    `);
    return result.rows.map(row => ({
      intent: row.intent,
      count: parseInt(row.count)
    }));
  } catch (err) {
    console.error('Error in getIntentDistribution:', err);
    return [];
  }
}

// Percentage of messages that hit the "unknown" fallback
async function getUnknownIntentRate() {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE intent = 'unknown') AS unknown_count
      FROM messages
      WHERE direction = 'incoming'
        AND intent IS NOT NULL
    `);
    const row = result.rows[0];
    const total = parseInt(row.total) || 0;
    const unknown = parseInt(row.unknown_count) || 0;
    if (total === 0) return 0;
    return ((unknown / total) * 100).toFixed(1);
  } catch (err) {
    console.error('Error in getUnknownIntentRate:', err);
    return 0;
  }
}

// Recent messages that were classified as "unknown" intent
async function getRecentUnknownMessages(limit = 25) {
  try {
    const result = await pool.query(
      `SELECT recipient_phone, message_body, created_at
       FROM messages
       WHERE direction = 'incoming' AND intent = 'unknown'
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map(row => ({
      phone: row.recipient_phone || 'Unknown',
      message: row.message_body || '—',
      timestamp: row.created_at
        ? new Date(row.created_at).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
          })
        : 'Unknown'
    }));
  } catch (err) {
    console.error('Error in getRecentUnknownMessages:', err);
    return [];
  }
}

// ── REMINDER EFFECTIVENESS METRICS ──

// Count of reminder-type messages sent today (daily_today + weekly templates)
async function getRemindersSentToday() {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE template_name = 'birthday_reminder') AS daily,
        COUNT(*) FILTER (WHERE template_name = 'weekly_birthday_reminders') AS weekly
      FROM messages
      WHERE direction = 'outgoing'
        AND template_name IN ('birthday_reminder', 'weekly_birthday_reminders')
        AND created_at >= CURRENT_DATE
    `);
    const row = result.rows[0];
    return {
      total: parseInt(row.total) || 0,
      daily: parseInt(row.daily) || 0,
      weekly: parseInt(row.weekly) || 0
    };
  } catch (err) {
    console.error('Error in getRemindersSentToday:', err);
    return { total: 0, daily: 0, weekly: 0 };
  }
}

// Reminder delivery rate: sent vs delivered for template (reminder) messages
async function getReminderDeliveryRate() {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'delivered') AS delivered,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed
      FROM messages
      WHERE direction = 'outgoing'
        AND template_name IN ('birthday_reminder', 'weekly_birthday_reminders')
    `);
    const row = result.rows[0];
    const total = parseInt(row.total) || 0;
    const delivered = parseInt(row.delivered) || 0;
    const failed = parseInt(row.failed) || 0;
    return {
      total,
      delivered,
      failed,
      deliveryRate: total > 0 ? ((delivered / total) * 100).toFixed(1) : '0.0'
    };
  } catch (err) {
    console.error('Error in getReminderDeliveryRate:', err);
    return { total: 0, delivered: 0, failed: 0, deliveryRate: '0.0' };
  }
}

// Post-reminder engagement: users who sent a message within 24h after receiving a reminder
async function getPostReminderEngagement() {
  try {
    const result = await pool.query(`
      WITH reminders AS (
        SELECT DISTINCT recipient_phone, DATE(created_at) AS reminder_date
        FROM messages
        WHERE direction = 'outgoing'
          AND template_name IN ('birthday_reminder', 'weekly_birthday_reminders')
          AND created_at >= CURRENT_DATE - INTERVAL '30 days'
      ),
      engaged AS (
        SELECT DISTINCT r.recipient_phone, r.reminder_date
        FROM reminders r
        INNER JOIN messages m
          ON m.recipient_phone = r.recipient_phone
          AND m.direction = 'incoming'
          AND m.created_at >= r.reminder_date
          AND m.created_at < r.reminder_date + INTERVAL '1 day'
      )
      SELECT
        (SELECT COUNT(*) FROM reminders) AS total_reminder_sends,
        (SELECT COUNT(*) FROM engaged) AS engaged_sends
    `);
    const row = result.rows[0];
    const total = parseInt(row.total_reminder_sends) || 0;
    const engaged = parseInt(row.engaged_sends) || 0;
    return {
      totalReminderSends: total,
      engagedSends: engaged,
      engagementRate: total > 0 ? ((engaged / total) * 100).toFixed(1) : '0.0'
    };
  } catch (err) {
    console.error('Error in getPostReminderEngagement:', err);
    return { totalReminderSends: 0, engagedSends: 0, engagementRate: '0.0' };
  }
}

module.exports = {
  getTotalMessagesAllTime,
  getFailuresByPhone,
  getMessagesToday,
  getFailedToday,
  getFailureRateToday,
  getLast7DayTrend,
  getFailureBreakdown,
  getHourlyTrendToday,
  getTotalUsersCount,
  getTotalEventsCount,
  getTotalAnniversariesCount,
  getEventsAddedToday,
  getWeeklyEventsTrend,
  getRecentMessageStatusTable,
  getUserEventSummaryTable,
  getRecentIncomingMessages,
  getAllUsersTable,
  getSundayReminderStats,
  getAllEventsTable,
  // Onboarding funnel
  getOnboardingFunnel,
  getOnboardingCompletionRate,
  getNudgeDistribution,
  // DAU / WAU
  getDAU,
  getWAU,
  getDAUTrend,
  // Intent distribution
  getIntentDistribution,
  getUnknownIntentRate,
  getRecentUnknownMessages,
  // Reminder effectiveness
  getRemindersSentToday,
  getReminderDeliveryRate,
  getPostReminderEngagement
};
