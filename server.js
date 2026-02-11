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
const metrics = require('./metrics');

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

// Admin dashboard route
app.get('/admin', async (req, res) => {
  try {
    const totalAllTime = await metrics.getTotalMessagesAllTime();
    const sentToday = await metrics.getMessagesToday();
    const failedToday = await metrics.getFailedToday();
    const failureRate = await metrics.getFailureRateToday();
    const trend = await metrics.getLast7DayTrend();
    const breakdown = await metrics.getFailureBreakdown();
    const hourly = await metrics.getHourlyTrendToday();
    const totalUsers = await metrics.getTotalUsersCount();

    const trendLabels = JSON.stringify(trend.map(t => new Date(t.day).toLocaleDateString()));
    const trendData = JSON.stringify(trend.map(t => parseInt(t.count)));
    
    const failureLabels = JSON.stringify(breakdown.map(f => f.error_code || 'Unknown'));
    const failureData = JSON.stringify(breakdown.map(f => parseInt(f.count)));

    const hourlyLabels = JSON.stringify(['12am', '1am', '2am', '3am', '4am', '5am', '6am', '7am', '8am', '9am', '10am', '11am', '12pm', '1pm', '2pm', '3pm', '4pm', '5pm', '6pm', '7pm', '8pm', '9pm', '10pm', '11pm']);
    const hourlyIncoming = JSON.stringify(hourly.incoming);
    const hourlyOutgoing = JSON.stringify(hourly.outgoing);

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Birthday Bot Admin</title>
          <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
          <style>
              body { font-family: sans-serif; background: #f4f7f6; margin: 0; padding: 20px; color: #333; }
              .container { max-width: 1000px; margin: 0 auto; }
              h1 { color: #444; }
              .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 20px; margin-bottom: 30px; }
              .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); text-align: center; }
              .card h3 { margin: 0; color: #888; font-size: 0.9rem; text-transform: uppercase; }
              .card .value { font-size: 2rem; font-weight: bold; margin-top: 10px; color: #222; }
              .card.fail .value { color: #e74c3c; }
              .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 20px; }
              .chart-container { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          </style>
      </head>
      <body>
          <div class="container">
              <h1>Bot Metrics Dashboard</h1>
              
              <div class="cards">
                  <div class="card">
                      <h3>Total Users</h3>
                      <div class="value">${totalUsers}</div>
                  </div>
                  <div class="card">
                      <h3>Total All-Time Messages</h3>
                      <div class="value">${totalAllTime}</div>
                  </div>
                  <div class="card">
                      <h3>Sent Today</h3>
                      <div class="value">${sentToday}</div>
                  </div>
                  <div class="card fail">
                      <h3>Failed Today</h3>
                      <div class="value">${failedToday}</div>
                  </div>
                  <div class="card">
                      <h3>Failure Rate</h3>
                      <div class="value">${failureRate}%</div>
                  </div>
              </div>

              <div class="charts">
                  <div class="chart-container" style="grid-column: span 2;">
                      <h3>Hourly Activity Today (IST)</h3>
                      <canvas id="hourlyChart"></canvas>
                  </div>
                  <div class="chart-container">
                      <h3>7-Day Message Trend</h3>
                      <canvas id="trendChart"></canvas>
                  </div>
                  <div class="chart-container">
                      <h3>Failure Breakdown (by Code)</h3>
                      <canvas id="failureChart"></canvas>
                  </div>
              </div>
          </div>

          <script>
              new Chart(document.getElementById('hourlyChart'), {
                  type: 'bar',
                  data: {
                      labels: ${hourlyLabels},
                      datasets: [
                          {
                              label: 'Incoming (User)',
                              data: ${hourlyIncoming},
                              backgroundColor: '#2ecc71'
                          },
                          {
                              label: 'Outgoing (Bot)',
                              data: ${hourlyOutgoing},
                              backgroundColor: '#3498db'
                          }
                      ]
                  },
                  options: { 
                      responsive: true, 
                      scales: { 
                          x: { stacked: true },
                          y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1 } } 
                      } 
                  }
              });

              new Chart(document.getElementById('trendChart'), {
                  type: 'line',
                  data: {
                      labels: ${trendLabels},
                      datasets: [{
                          label: 'Messages',
                          data: ${trendData},
                          borderColor: '#3498db',
                          backgroundColor: 'rgba(52, 152, 219, 0.1)',
                          fill: true,
                          tension: 0.1
                      }]
                  },
                  options: { responsive: true, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
              });

              new Chart(document.getElementById('failureChart'), {
                  type: 'bar',
                  data: {
                      labels: ${failureLabels},
                      datasets: [{
                          label: 'Count',
                          data: ${failureData},
                          backgroundColor: '#e74c3c'
                      }]
                  },
                  options: { responsive: true, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
              });
          </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Admin page error:', err);
    res.status(500).send('Error loading admin dashboard');
  }
});

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
