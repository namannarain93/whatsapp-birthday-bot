const { pool } = require('./db.js');

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

async function getLast7DayTrend() {
  try {
    const result = await pool.query(
      `SELECT DATE(created_at) as day, COUNT(*) 
       FROM messages
       WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
       GROUP BY day
       ORDER BY day`
    );
    return result.rows;
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
      `SELECT phone, timezone, last_interaction_at, created_at
       FROM users
       WHERE created_at >= '2026-01-31'
       ORDER BY created_at DESC`
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

    return result.rows.map(row => ({
      phone: row.phone || 'Unknown',
      timezone: row.timezone || 'Unknown',
      lastInteraction: row.last_interaction_at
        ? new Date(row.last_interaction_at).toLocaleString('en-IN', istOpts)
        : 'Never',
      createdAt: row.created_at
        ? new Date(row.created_at).toLocaleString('en-IN', istOpts)
        : 'Unknown'
    }));
  } catch (err) {
    console.error('Error in getAllUsersTable:', err);
    return [];
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

module.exports = {
  getTotalMessagesAllTime,
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
  getAllEventsTable
};
