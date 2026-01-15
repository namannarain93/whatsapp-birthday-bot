require('dotenv').config();
const express = require('express');
const webhookRoutes = require('./src/routes/webhook.routes');

// Initialize database (import triggers table creation)
require('./db.js');

// Import reminder schedulers
const { startReminderScheduler } = require('./reminder.js');
const { startWeeklyReminderScheduler } = require('./weeklyReminderJob.js');

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

// Test endpoint for sending template messages
app.get('/send-test', async (req, res) => {
  try {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneNumberId = process.env.PHONE_NUMBER_ID;
    const to = req.query.to; // e.g. 919819961371

    if (!token || !phoneNumberId || !to) {
      return res.status(400).json({
        error: 'Missing WHATSAPP_TOKEN, PHONE_NUMBER_ID, or ?to='
      });
    }

    const fetch = (...args) =>
      import('node-fetch').then(({ default: fetch }) => fetch(...args));

    const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: 'hello_world',
          language: { code: 'en_US' }
        }
      })
    });

    const data = await response.json();
    console.log('SEND TEST RESPONSE:', data);

    res.json(data);
  } catch (err) {
    console.error('SEND TEST ERROR:', err);
    res.status(500).send('Failed to send test message');
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Bot is alive on port', PORT);
  // Start daily reminder scheduler (runs every 30 minutes, checks for 9am local time)
  startReminderScheduler();
  // Start weekly reminder scheduler (runs every 30 minutes, checks for Sunday 9am local time)
  startWeeklyReminderScheduler();
});
