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

async function getWeeklyEventsTrend() {
  try {
    // Get count of events added per week for the last 8 weeks
    const result = await pool.query(
      `SELECT 
         DATE_TRUNC('week', created_at) AS week, 
         COUNT(*) as count
       FROM birthdays 
       WHERE created_at >= CURRENT_DATE - INTERVAL '8 weeks'
       GROUP BY week
       ORDER BY week`
    );

    // To make it cumulative, we also need the total count before these 8 weeks
    const initialCountRes = await pool.query(
      `SELECT COUNT(*) FROM birthdays WHERE created_at < CURRENT_DATE - INTERVAL '8 weeks'`
    );
    let cumulativeCount = parseInt(initialCountRes.rows[0].count);

    const trend = result.rows.map(row => {
      cumulativeCount += parseInt(row.count);
      return {
        week: new Date(row.week).toLocaleDateString(),
        count: cumulativeCount
      };
    });

    return trend;
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
        messageStatus: isSuccess ? 'Success' : 'Failure',
        failureCode: isSuccess ? 'NA' : (row.error_code || 'Unknown'),
        timestamp: row.created_at ? new Date(row.created_at).toLocaleString() : 'Unknown'
      };
    });
  } catch (err) {
    console.error('Error in getRecentMessageStatusTable:', err);
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
  getWeeklyEventsTrend,
  getRecentMessageStatusTable
};
