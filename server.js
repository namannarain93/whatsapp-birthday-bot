require('dotenv').config();

// Required environment variables validation
const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'WHATSAPP_TOKEN',
  'PHONE_NUMBER_ID',
  'OPENAI_API_KEY'
];

const missingVars = REQUIRED_ENV_VARS.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error('❌ CRITICAL: Missing required environment variables:', missingVars.join(', '));
  process.exit(1);
}

const express = require('express');
const webhookRoutes = require('./src/routes/webhook.routes');
const { sendTemplateMessage } = require('./src/services/whatsapp.service');

// Initialize database (import triggers table creation)
require('./db.js');

// Import reminder schedulers
const { startReminderScheduler } = require('./reminder.js');
const { startDailyUpcomingReminderScheduler } = require('./dailyUpcomingReminderJob.js');

const app = express();

// Request logging middleware
app.use((req, res, next) => {
  console.log('⚡ INCOMING REQUEST:', req.method, req.path);
  next();
});

// JSON body parsing middleware
app.use(express.json());

// Register webhook routes
app.use('/', webhookRoutes);

// Root route for the landing page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Birthday Bot</title>
        <style>
            body {
                background-color: #FF66CC; /* Rose Pink background */
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                color: white;
            }
            .content {
                text-align: center;
                font-size: 1.5rem;
                font-weight: 500;
                padding: 20px;
                text-shadow: 1px 1px 2px rgba(0,0,0,0.1);
            }
        </style>
    </head>
    <body>
        <div class="content">
            Never forget birthdays or anniversaries again!
        </div>
    </body>
    </html>
  `);
});

// Test endpoint for sending template messages
app.get('/send-test', async (req, res) => {
  try {
    const to = req.query.to;
    if (!to) {
      return res.status(400).json({ error: 'Missing ?to=' });
    }

    const data = await sendTemplateMessage(to, 'hello_world');
    console.log('SEND TEST SUCCESS:', data);
    res.json({ success: true, data });
  } catch (err) {
    console.error('SEND TEST ERROR:', err.message);
    res.status(500).json({ error: 'Failed to send test message', details: err.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Bot is alive on port', PORT);
  // Start daily reminder scheduler
  startReminderScheduler();
  // Start daily upcoming reminder scheduler
  startDailyUpcomingReminderScheduler();
});
