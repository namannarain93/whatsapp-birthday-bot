const { pool } = require('./pool');

// Admin Metrics: Save sent message
async function saveSentMessage(wamid, phone, templateName = null, messageBody = null) {
  if (!wamid) return;
  await pool.query(
    `INSERT INTO messages (wamid, recipient_phone, status, template_name, direction, message_body)
     VALUES ($1, $2, 'sent', $3, 'outgoing', $4)
     ON CONFLICT (wamid) DO NOTHING`,
    [wamid, phone, templateName, messageBody]
  );
}

// Admin Metrics: Save received message
async function saveReceivedMessage(wamid, phone, messageBody = null) {
  if (!wamid) return;
  await pool.query(
    `INSERT INTO messages (wamid, recipient_phone, status, direction, message_body)
     VALUES ($1, $2, 'received', 'incoming', $3)
     ON CONFLICT (wamid) DO NOTHING`,
    [wamid, phone, messageBody]
  );
}

// Admin Metrics: Update message status from webhook
async function updateMessageStatus(wamid, status, errorCode = null) {
  if (!wamid) return;
  if (status === 'failed') {
    await pool.query(
      `UPDATE messages
       SET status = 'failed', error_code = $1, updated_at = NOW()
       WHERE wamid = $2`,
      [errorCode, wamid]
    );
  } else if (status === 'delivered') {
    await pool.query(
      `UPDATE messages
       SET status = 'delivered', updated_at = NOW()
       WHERE wamid = $1`,
      [wamid]
    );
  }
}

// Fetch the most recent messages exchanged with a user (both directions),
// oldest first, so the LLM can interpret the current message in context.
// Only looks at the last 2 hours: older context should not influence parsing.
async function getRecentConversation(phone, limit = 6, excludeWamid = null) {
  const res = await pool.query(
    `SELECT direction, message_body
     FROM messages
     WHERE recipient_phone = $1
       AND message_body IS NOT NULL
       AND message_body <> ''
       AND ($3::text IS NULL OR wamid IS NULL OR wamid <> $3)
       AND created_at > NOW() - INTERVAL '2 hours'
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [phone, limit, excludeWamid]
  );
  return res.rows.reverse();
}

// Update the parsed intent on an incoming message (for metrics)
async function updateMessageIntent(wamid, intent) {
  if (!wamid || !intent) return;
  await pool.query(
    `UPDATE messages SET intent = $1, updated_at = NOW() WHERE wamid = $2`,
    [intent, wamid]
  );
}

module.exports = {
  saveSentMessage,
  saveReceivedMessage,
  updateMessageStatus,
  updateMessageIntent,
  getRecentConversation,
};
