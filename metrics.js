const { pool } = require('./db.js');
const moment = require('moment-timezone');
const { getSundayReminderStatus } = require('./src/db/user.repository');
const { resolvePhone } = require('./src/utils/telecomCircle');
const { normalizeMonthToShort, normalizeMonthToCanonical, getMonthOrderNumber } = require('./src/utils/month.utils');

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

// Failures grouped by Meta template and error code — powers the stacked
// "Failure Breakdown by Template" chart. Any failed message that isn't one of the
// tracked templates (or has no template_name) is bucketed into "Misc".
const TRACKED_TEMPLATES = [
  'event_details_reminder_2',
  // Same-day reminder: 'birthday_reminder' is the legacy (marketing) template,
  // 'event_details_reminder_3' is the current utility replacement. Both kept so
  // historical and new sends are tracked.
  'event_details_reminder_3',
  'birthday_reminder',
  // Weekly Sunday reminder: 'weekly_birthday_reminders' is legacy;
  // 'event_details_reminder_1' is the current utility replacement.
  'event_details_reminder_1',
  'weekly_birthday_reminders'
];

async function getFailureBreakdownByTemplate() {
  try {
    const result = await pool.query(
      `SELECT
         CASE
           WHEN template_name = ANY($1::text[]) THEN template_name
           ELSE 'Misc'
         END AS template_bucket,
         COALESCE(error_code::text, 'Unknown') AS error_code,
         COUNT(*) AS count
       FROM messages
       WHERE status = 'failed'
       GROUP BY template_bucket, error_code`,
      [TRACKED_TEMPLATES]
    );

    // Fixed column order for the X axis; Misc always last.
    const templates = [...TRACKED_TEMPLATES, 'Misc'];
    const templateIndex = {};
    templates.forEach((t, i) => { templateIndex[t] = i; });

    // Pivot into { errorCode -> [count per template bucket] }
    const byCode = {};
    result.rows.forEach(row => {
      const code = row.error_code;
      const idx = templateIndex[row.template_bucket];
      if (idx == null) return;
      if (!byCode[code]) byCode[code] = new Array(templates.length).fill(0);
      byCode[code][idx] = parseInt(row.count, 10) || 0;
    });

    return { templates, byCode };
  } catch (err) {
    console.error('Error in getFailureBreakdownByTemplate:', err);
    return { templates: [...TRACKED_TEMPLATES, 'Misc'], byCode: {} };
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
    // Authoritative count = distinct phones across users + birthdays,
    // matching the "All Users" table at the bottom of the admin page.
    const result = await pool.query(
      `SELECT COUNT(*) FROM (
         SELECT phone FROM users
         UNION
         SELECT phone FROM birthdays
       ) all_phones`
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
      `WITH weeks AS (
         SELECT generate_series(
           DATE_TRUNC('week', CURRENT_DATE) - INTERVAL '4 weeks',
           DATE_TRUNC('week', CURRENT_DATE),
           INTERVAL '1 week'
         ) AS week
       )
       SELECT
         weeks.week AS week,
         COUNT(b.*) FILTER (WHERE LOWER(b.type) = 'birthday') AS birthdays,
         COUNT(b.*) FILTER (WHERE LOWER(b.type) = 'anniversary') AS anniversaries
       FROM weeks
       LEFT JOIN birthdays b
         ON DATE_TRUNC('week', b.created_at) = weeks.week
       GROUP BY weeks.week
       ORDER BY weeks.week`
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
      // Only Meta webhook "failed" is a real failure. "sent" means accepted by
      // WhatsApp and awaiting delivery; "delivered"/"read" are successes.
      const isFailure = row.status === 'failed';
      return {
        phone: row.recipient_phone || 'Unknown',
        messageType: isTemplate ? 'Meta template' : 'Free form',
        templateName: row.template_name || '—',
        messageStatus: isFailure ? 'Failure' : 'Success',
        failureCode: isFailure ? (row.error_code || 'Unknown') : 'NA',
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

async function getRecentOutgoingMessages(limit = 25) {
  try {
    const result = await pool.query(
      `SELECT recipient_phone, message_body, template_name, status, created_at
       FROM messages
       WHERE direction = 'outgoing'
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    return result.rows.map(row => {
      // Prefer the stored body; fall back to the template name for older rows
      // that were logged before message bodies were captured.
      let message = row.message_body;
      if (!message) {
        message = row.template_name ? `[Template: ${row.template_name}]` : '—';
      }
      return {
        phone: row.recipient_phone || 'Unknown',
        message,
        status: row.status || 'sent',
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
    console.error('Error in getRecentOutgoingMessages:', err);
    return [];
  }
}

async function getAllUsersTable() {
  try {
    const result = await pool.query(
      `WITH all_phones AS (
         SELECT phone FROM users
         UNION
         SELECT phone FROM birthdays
       ),
       event_counts AS (
         SELECT phone, COUNT(*) AS event_count
         FROM birthdays
         GROUP BY phone
       )
       SELECT
         ap.phone,
         u.timezone,
         u.last_interaction_at,
         u.created_at,
         COALESCE(ec.event_count, 0) AS event_count
       FROM all_phones ap
       LEFT JOIN users u ON u.phone = ap.phone
       LEFT JOIN event_counts ec ON ec.phone = ap.phone
       ORDER BY u.created_at DESC NULLS LAST, ap.phone`
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
      `SELECT phone, name, day, month, type, year, relationship, created_at
       FROM birthdays
       ORDER BY created_at DESC`
    );

    return result.rows.map(row => ({
      phone: row.phone || 'Unknown',
      name: row.name || 'Unknown',
      day: row.day,
      month: row.month,
      type: row.type || 'birthday',
      year: row.year || null,
      relationship: row.relationship || null,
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

// Get count of users at each onboarding step (0 = completed/not started, 1-2 = in progress)
async function getOnboardingFunnel() {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE onboarding_step = 0 AND has_seen_welcome = true) AS completed,
        COUNT(*) FILTER (WHERE onboarding_step = 1) AS step_1,
        -- step 3 is a removed legacy step; fold those users into step_2 for the funnel
        COUNT(*) FILTER (WHERE onboarding_step IN (2, 3)) AS step_2
      FROM users
      WHERE created_at >= '2026-01-31'
    `);
    const row = result.rows[0];
    return {
      completed: parseInt(row.completed) || 0,
      step_1: parseInt(row.step_1) || 0,
      step_2: parseInt(row.step_2) || 0
    };
  } catch (err) {
    console.error('Error in getOnboardingFunnel:', err);
    return { completed: 0, step_1: 0, step_2: 0 };
  }
}

// Onboarding completion rate (% of users who finished onboarding)
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
        COUNT(*) FILTER (WHERE template_name IN ('birthday_reminder', 'event_details_reminder_3')) AS daily,
        COUNT(*) FILTER (WHERE template_name IN ('weekly_birthday_reminders', 'event_details_reminder_1')) AS weekly
      FROM messages
      WHERE direction = 'outgoing'
        AND template_name IN ('birthday_reminder', 'event_details_reminder_3', 'weekly_birthday_reminders', 'event_details_reminder_1')
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

// Sunday weekly reminders actually sent this week (Sun–Sat, IST), from messages log
async function getSundayRemindersSentThisWeek() {
  const weekSunday = moment().tz('Asia/Kolkata').startOf('day').day(0); // this week's Sunday
  const dateLabel = weekSunday.format('ddd, MMM D');
  try {
    const result = await pool.query(
      `
      SELECT COUNT(*) AS count
      FROM messages
      WHERE direction = 'outgoing'
        AND template_name IN ('event_details_reminder_1', 'weekly_birthday_reminders')
        AND created_at >= $1::date
      `,
      [weekSunday.format('YYYY-MM-DD')]
    );
    return {
      count: parseInt(result.rows[0].count) || 0,
      date: weekSunday.format('YYYY-MM-DD'),
      dateLabel
    };
  } catch (err) {
    console.error('Error in getSundayRemindersSentThisWeek:', err);
    return { count: 0, date: weekSunday.format('YYYY-MM-DD'), dateLabel };
  }
}

// The next calendar day that has saved birthdays/anniversaries (recurring
// annually-driven event day). Today's events are excluded — their reminders are
// already in flight — so the card always looks ahead.
async function getNextReminderDate() {
  try {
    const result = await pool.query(`
      SELECT day, month,
             COUNT(*) FILTER (WHERE LOWER(type) = 'birthday') AS birthdays,
             COUNT(*) FILTER (WHERE LOWER(type) = 'anniversary') AS anniversaries,
             COUNT(*) AS total
      FROM birthdays
      GROUP BY day, month
    `);

    if (result.rows.length === 0) return null;

    const now = moment().tz('Asia/Kolkata').startOf('day');

    let best = null;
    for (const row of result.rows) {
      const monthShort = normalizeMonthToShort(row.month);
      if (!monthShort) continue;
      const monthNum = getMonthOrderNumber(normalizeMonthToCanonical(monthShort));
      const day = parseInt(row.day, 10);
      if (!monthNum || monthNum > 12 || !day) continue;

      // Next occurrence of this (day, month) strictly after today, in IST.
      let eventDate = moment.tz([now.year(), monthNum - 1, day], 'Asia/Kolkata').startOf('day');
      if (!eventDate.isValid()) continue;
      if (!eventDate.isAfter(now)) eventDate = eventDate.add(1, 'year');

      if (!best || eventDate.isBefore(best.eventDate)) {
        best = {
          eventDate,
          birthdays: parseInt(row.birthdays, 10) || 0,
          anniversaries: parseInt(row.anniversaries, 10) || 0,
          total: parseInt(row.total, 10) || 0
        };
      }
    }

    if (!best) return null;

    return {
      date: best.eventDate.format('YYYY-MM-DD'),
      label: best.eventDate.format('ddd, MMM D'),
      daysUntil: best.eventDate.diff(now, 'days'),
      total: best.total,
      birthdays: best.birthdays,
      anniversaries: best.anniversaries
    };
  } catch (err) {
    console.error('Error in getNextReminderDate:', err);
    return null;
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
        AND template_name IN ('birthday_reminder', 'event_details_reminder_3', 'weekly_birthday_reminders', 'event_details_reminder_1')
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
          AND template_name IN ('birthday_reminder', 'event_details_reminder_3', 'weekly_birthday_reminders', 'event_details_reminder_1')
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

// Upsert today's Sunday-reminder-eligible count into the current calendar month
// (Asia/Kolkata). Called daily so past months keep their last known value.
async function snapshotMonthlyActiveUsers() {
  try {
    const monthStart = moment().tz('Asia/Kolkata').startOf('month').format('YYYY-MM-DD');
    const activeUsers = (await getSundayReminderStats()).active;
    await pool.query(
      `INSERT INTO monthly_active_user_snapshots (month, active_users, updated_at)
       VALUES ($1::date, $2, NOW())
       ON CONFLICT (month) DO UPDATE
         SET active_users = EXCLUDED.active_users,
             updated_at = NOW()`,
      [monthStart, activeUsers]
    );
    return { month: monthStart, activeUsers };
  } catch (err) {
    console.error('Error in snapshotMonthlyActiveUsers:', err);
    return null;
  }
}

// ── MONTHLY GROWTH METRICS ──
// Builds a full 12-month table for the current year (including future/empty months)
// to track progress toward the active-users goal (1000 active users in 6 months).
async function getMonthlyMetrics(goalActiveUsers = 1000, goalHorizonMonths = 6) {
  // Run each query independently so a single failure never blanks the whole table.
  const safeRows = async (label, sql) => {
    try {
      const res = await pool.query(sql);
      return res.rows;
    } catch (err) {
      console.error(`getMonthlyMetrics query failed (${label}):`, err.message);
      return [];
    }
  };

  try {
    // New (first-seen) users per month, across users + birthdays phones
    const newUsersRows = await safeRows('newUsers', `
      WITH all_phones AS (
        SELECT phone, created_at FROM users WHERE created_at IS NOT NULL
        UNION ALL
        SELECT phone, created_at FROM birthdays WHERE created_at IS NOT NULL
      ),
      first_seen AS (
        SELECT phone, MIN(created_at) AS joined_at
        FROM all_phones
        GROUP BY phone
      )
      SELECT DATE_TRUNC('month', joined_at) AS month, COUNT(*) AS new_users
      FROM first_seen
      GROUP BY DATE_TRUNC('month', joined_at)
    `);
    // Events (birthdays + anniversaries) added per month.
    // NOTE: birthdays has its own "month" column, so we must GROUP BY the
    // DATE_TRUNC expression explicitly — "GROUP BY month" would bind to that
    // column instead of the alias and error out.
    const eventsRows = await safeRows('events', `
      SELECT DATE_TRUNC('month', created_at) AS month, COUNT(*) AS events
      FROM birthdays
      WHERE created_at IS NOT NULL
      GROUP BY DATE_TRUNC('month', created_at)
    `);
    // Outgoing messages sent per month
    const sentRows = await safeRows('sent', `
      SELECT DATE_TRUNC('month', created_at) AS month, COUNT(*) AS sent
      FROM messages
      WHERE direction = 'outgoing' AND created_at IS NOT NULL
      GROUP BY DATE_TRUNC('month', created_at)
    `);
    // Persisted end-of-month (last-known) active-user counts for past months
    const activeSnapshotRows = await safeRows('activeSnapshots', `
      SELECT month, active_users
      FROM monthly_active_user_snapshots
    `);
    // Active users = Sunday-reminder-eligible users (same definition as the KPI card).
    let currentActiveUsers = 0;
    try {
      currentActiveUsers = (await getSundayReminderStats()).active;
    } catch (err) {
      console.error('getMonthlyMetrics sunday stats failed:', err.message);
    }

    const monthKey = (val) => new Date(val).toISOString().slice(0, 7); // 'YYYY-MM'
    const toMap = (rows, field) => {
      const map = {};
      rows.forEach(r => {
        if (r.month == null) return;
        map[monthKey(r.month)] = parseInt(r[field], 10) || 0;
      });
      return map;
    };

    const newUsersMap = toMap(newUsersRows, 'new_users');
    const eventsMap = toMap(eventsRows, 'events');
    const sentMap = toMap(sentRows, 'sent');
    const activeSnapshotMap = toMap(activeSnapshotRows, 'active_users');

    const now = moment().tz('Asia/Kolkata');
    const year = now.year();
    const currentMonthIdx = now.month(); // 0-indexed

    // Cumulative users carried in from before this year
    let cumulative = Object.entries(newUsersMap)
      .filter(([k]) => k < `${year}-01`)
      .reduce((sum, [, v]) => sum + v, 0);

    // Cumulative stored events (birthdays/annivs) carried in from before this year
    let cumulativeEvents = Object.entries(eventsMap)
      .filter(([k]) => k < `${year}-01`)
      .reduce((sum, [, v]) => sum + v, 0);

    // Baseline for the target curve = cumulative users through the current month
    let baseline = cumulative;
    for (let m = 0; m <= currentMonthIdx; m++) {
      baseline += newUsersMap[`${year}-${String(m + 1).padStart(2, '0')}`] || 0;
    }
    const safeBaseline = Math.max(baseline, 1);
    const growth = Math.pow(goalActiveUsers / safeBaseline, 1 / goalHorizonMonths);

    const months = [];
    for (let m = 0; m < 12; m++) {
      const key = `${year}-${String(m + 1).padStart(2, '0')}`;
      const newUsers = newUsersMap[key] || 0;
      cumulative += newUsers;
      cumulativeEvents += eventsMap[key] || 0;

      // Current month: live Sunday-reminder count.
      // Past months: last persisted snapshot (null if never saved, e.g. before snapshots existed).
      let activeUsers = null;
      if (m === currentMonthIdx) {
        activeUsers = currentActiveUsers;
      } else if (m < currentMonthIdx && Object.prototype.hasOwnProperty.call(activeSnapshotMap, key)) {
        activeUsers = activeSnapshotMap[key];
      }

      // Target active users: ramp from baseline (current month) to goal over the horizon
      let target = null;
      if (m >= currentMonthIdx) {
        const k = m - currentMonthIdx;
        target = Math.round(safeBaseline * Math.pow(growth, k));
      }
      const progress = activeUsers != null && target && target > 0
        ? ((activeUsers / target) * 100).toFixed(1)
        : null;

      months.push({
        label: new Date(year, m, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
        isCurrent: m === currentMonthIdx,
        isFuture: m > currentMonthIdx,
        newUsers,
        cumulativeUsers: cumulative,
        activeUsers,
        eventsAdded: eventsMap[key] || 0,
        cumulativeEvents,
        messagesSent: sentMap[key] || 0,
        targetActiveUsers: target,
        progress
      });
    }

    return months;
  } catch (err) {
    console.error('Error in getMonthlyMetrics:', err);
    return [];
  }
}

// Compares the last 24 hours against the 24 hours before that,
// used as input for the AI-generated daily summary.
async function getDailySummarySnapshot() {
  try {
    const periodCompare = async (sqlWhere) => {
      const result = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS current,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '48 hours'
                             AND created_at <  NOW() - INTERVAL '24 hours') AS previous
        FROM ${sqlWhere}
      `);
      return {
        last24h: parseInt(result.rows[0].current) || 0,
        previous24h: parseInt(result.rows[0].previous) || 0
      };
    };

    const messagesSent = await periodCompare(`messages WHERE direction = 'outgoing'`);
    const messagesReceived = await periodCompare(`messages WHERE direction = 'incoming'`);
    const messagesFailed = await periodCompare(`messages WHERE status = 'failed'`);
    const newUsers = await periodCompare(`users WHERE true`);
    const eventsAdded = await periodCompare(`birthdays WHERE true`);
    const remindersSent = await periodCompare(`birthday_reminder_log WHERE true`);
    const unknownIntents = await periodCompare(`messages WHERE direction = 'incoming' AND intent = 'unknown'`);

    // Active users (distinct incoming senders), last 24h vs previous 24h
    const activeResult = await pool.query(`
      SELECT
        COUNT(DISTINCT recipient_phone) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS current,
        COUNT(DISTINCT recipient_phone) FILTER (WHERE created_at >= NOW() - INTERVAL '48 hours'
                                                  AND created_at <  NOW() - INTERVAL '24 hours') AS previous
      FROM messages
      WHERE direction = 'incoming'
    `);
    const activeUsers = {
      last24h: parseInt(activeResult.rows[0].current) || 0,
      previous24h: parseInt(activeResult.rows[0].previous) || 0
    };

    // Top failure error codes in the last 24 hours
    const failureResult = await pool.query(`
      SELECT error_code, COUNT(*) AS count
      FROM messages
      WHERE status = 'failed' AND created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY error_code
      ORDER BY count DESC
      LIMIT 5
    `);
    const topFailures = failureResult.rows.map(r => ({
      errorCode: r.error_code || 'Unknown',
      count: parseInt(r.count) || 0
    }));

    // Intent distribution for incoming messages in the last 24 hours
    const intentResult = await pool.query(`
      SELECT COALESCE(intent, 'unparsed') AS intent, COUNT(*) AS count
      FROM messages
      WHERE direction = 'incoming' AND created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY intent
      ORDER BY count DESC
    `);
    const intentDistribution = intentResult.rows.map(r => ({
      intent: r.intent,
      count: parseInt(r.count) || 0
    }));

    const totalsResult = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COUNT(*) FROM birthdays) AS total_events
    `);

    return {
      messagesSent,
      messagesReceived,
      messagesFailed,
      newUsers,
      eventsAdded,
      remindersSent,
      unknownIntents,
      activeUsers,
      topFailures,
      intentDistribution,
      totals: {
        users: parseInt(totalsResult.rows[0].total_users) || 0,
        events: parseInt(totalsResult.rows[0].total_events) || 0
      }
    };
  } catch (err) {
    console.error('Error in getDailySummarySnapshot:', err);
    return null;
  }
}

// ── GEO DISTRIBUTION (3D India map) ──
// Maps every known phone to an Indian telecom circle (from the mobile prefix)
// or a foreign country, and joins in per-phone outgoing message counts.
async function getGeoDistribution() {
  try {
    const result = await pool.query(`
      WITH all_phones AS (
        SELECT phone FROM users
        UNION
        SELECT phone FROM birthdays
      ),
      msg_counts AS (
        SELECT recipient_phone AS phone, COUNT(*) AS messages
        FROM messages
        WHERE direction = 'outgoing'
        GROUP BY recipient_phone
      )
      SELECT ap.phone, COALESCE(mc.messages, 0) AS messages
      FROM all_phones ap
      LEFT JOIN msg_counts mc ON mc.phone = ap.phone
    `);

    const circles = {};
    const international = {};
    let unmappedIndia = 0;
    let unknown = 0;

    for (const row of result.rows) {
      const messages = parseInt(row.messages, 10) || 0;
      const loc = resolvePhone(row.phone);
      if (loc.kind === 'india' && loc.code) {
        if (!circles[loc.code]) {
          circles[loc.code] = { code: loc.code, name: loc.name, coord: loc.coord, users: 0, messages: 0 };
        }
        circles[loc.code].users += 1;
        circles[loc.code].messages += messages;
      } else if (loc.kind === 'india') {
        unmappedIndia += 1;
      } else if (loc.kind === 'international') {
        international[loc.country] = (international[loc.country] || 0) + 1;
      } else {
        unknown += 1;
      }
    }

    return {
      circles: Object.values(circles).sort((a, b) => b.users - a.users),
      international: Object.entries(international)
        .map(([country, users]) => ({ country, users }))
        .sort((a, b) => b.users - a.users),
      unmappedIndia,
      unknown
    };
  } catch (err) {
    console.error('Error in getGeoDistribution:', err);
    return { circles: [], international: [], unmappedIndia: 0, unknown: 0 };
  }
}

async function getLatestDailySummary() {
  try {
    const result = await pool.query(`
      SELECT summary_date, summary_text, created_at
      FROM daily_summaries
      ORDER BY summary_date DESC
      LIMIT 1
    `);
    if (result.rows.length === 0) return null;
    return {
      date: result.rows[0].summary_date,
      text: result.rows[0].summary_text,
      updatedAt: result.rows[0].created_at
    };
  } catch (err) {
    console.error('Error in getLatestDailySummary:', err);
    return null;
  }
}

module.exports = {
  getTotalMessagesAllTime,
  getFailuresByPhone,
  getMessagesToday,
  getFailedToday,
  getFailureRateToday,
  getLast7DayTrend,
  getFailureBreakdownByTemplate,
  getHourlyTrendToday,
  getTotalUsersCount,
  getTotalEventsCount,
  getTotalAnniversariesCount,
  getEventsAddedToday,
  getMonthlyMetrics,
  snapshotMonthlyActiveUsers,
  getWeeklyEventsTrend,
  getRecentMessageStatusTable,
  getUserEventSummaryTable,
  getRecentIncomingMessages,
  getRecentOutgoingMessages,
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
  getSundayRemindersSentThisWeek,
  getNextReminderDate,
  getReminderDeliveryRate,
  getPostReminderEngagement,
  // AI daily summary
  getDailySummarySnapshot,
  getLatestDailySummary,
  // Geo distribution (3D India map)
  getGeoDistribution
};
