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
};
