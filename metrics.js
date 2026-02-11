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

module.exports = {
  getTotalMessagesAllTime,
  getMessagesToday,
  getFailedToday,
  getFailureRateToday,
  getLast7DayTrend,
  getFailureBreakdown,
  getHourlyTrendToday,
  getTotalUsersCount
};
