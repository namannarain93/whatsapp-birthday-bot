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
const XLSX = require('xlsx');
const webhookRoutes = require('./src/routes/webhook.routes');
const { sendTemplateMessage } = require('./src/services/whatsapp.service');
const metrics = require('./metrics');

// Initialize database
const { dbReady } = require('./db.js');

// Import job schedulers
const { startReminderScheduler } = require('./src/jobs/reminder.job');
const { startDailyUpcomingReminderScheduler } = require('./src/jobs/dailyUpcomingReminder.job');
const { startNewUserFollowupScheduler } = require('./src/jobs/newUserFollowup.job');
const { startOnboardingNudgeScheduler } = require('./src/jobs/onboardingNudge.job');

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
    const totalEvents = await metrics.getTotalEventsCount();
    const totalAnniversaries = await metrics.getTotalAnniversariesCount();
    const eventsAddedToday = await metrics.getEventsAddedToday();
    const eventsTrend = await metrics.getWeeklyEventsTrend();
    const recentMessages = await metrics.getRecentMessageStatusTable();
    const userEventSummary = await metrics.getUserEventSummaryTable();
    const recentIncoming = await metrics.getRecentIncomingMessages();
    const allEvents = await metrics.getAllEventsTable();
    const allUsers = await metrics.getAllUsersTable();
    const sundayReminderStats = await metrics.getSundayReminderStats();
    const monthlyMetrics = await metrics.getMonthlyMetrics();

    // New metrics
    const onboardingFunnel = await metrics.getOnboardingFunnel();
    const onboardingCompletionRate = await metrics.getOnboardingCompletionRate();
    const nudgeDistribution = await metrics.getNudgeDistribution();
    const dau = await metrics.getDAU();
    const wau = await metrics.getWAU();
    const dauTrend = await metrics.getDAUTrend();
    const intentDistribution = await metrics.getIntentDistribution();
    const unknownIntentRate = await metrics.getUnknownIntentRate();
    const recentUnknownMessages = await metrics.getRecentUnknownMessages();
    const remindersSentToday = await metrics.getRemindersSentToday();
    const reminderDeliveryRate = await metrics.getReminderDeliveryRate();
    const postReminderEngagement = await metrics.getPostReminderEngagement();
    const failuresByPhoneRaw = await metrics.getFailuresByPhone();

    const trendLabels = JSON.stringify(trend.map(t => new Date(t.day).toLocaleDateString()));
    const trendData = JSON.stringify(trend.map(t => parseInt(t.count)));
    
    const failureLabels = JSON.stringify(breakdown.map(f => f.error_code || 'Unknown'));
    const failureData = JSON.stringify(breakdown.map(f => parseInt(f.count)));

    const hourlyLabels = JSON.stringify(['12am', '1am', '2am', '3am', '4am', '5am', '6am', '7am', '8am', '9am', '10am', '11am', '12pm', '1pm', '2pm', '3pm', '4pm', '5pm', '6pm', '7pm', '8pm', '9pm', '10pm', '11pm']);
    const hourlyIncoming = JSON.stringify(hourly.incoming);
    const hourlyOutgoing = JSON.stringify(hourly.outgoing);

    const eventsTrendLabels = JSON.stringify(eventsTrend.map(t => t.week));
    const eventsTrendBirthdays = JSON.stringify(eventsTrend.map(t => t.birthdays));
    const eventsTrendAnniversaries = JSON.stringify(eventsTrend.map(t => t.anniversaries));

    // DAU trend chart data
    const dauTrendLabels = JSON.stringify(dauTrend.map(t => new Date(t.day).toLocaleDateString()));
    const dauTrendData = JSON.stringify(dauTrend.map(t => t.dau));

    // Intent distribution chart data
    const intentLabels = JSON.stringify(intentDistribution.map(i => i.intent));
    const intentData = JSON.stringify(intentDistribution.map(i => i.count));

    // Onboarding funnel chart data
    const onboardingFunnelLabels = JSON.stringify(['Step 1', 'Step 2', 'Step 3', 'Completed']);
    const onboardingFunnelData = JSON.stringify([
      onboardingFunnel.step_1,
      onboardingFunnel.step_2,
      onboardingFunnel.step_3,
      onboardingFunnel.completed
    ]);

    // Pivot failures-by-phone into { phone -> { errorCode -> count, total, firstFailure, lastFailure } }
    const istOpts = { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true };
    const failuresByPhoneCodes = [...new Set(failuresByPhoneRaw.map(r => r.error_code))].sort();
    const failuresByPhoneMap = {};
    for (const row of failuresByPhoneRaw) {
      const phone = row.recipient_phone || 'Unknown';
      if (!failuresByPhoneMap[phone]) failuresByPhoneMap[phone] = { total: 0, firstFailure: null, lastFailure: null };
      failuresByPhoneMap[phone][row.error_code] = parseInt(row.count) || 0;
      failuresByPhoneMap[phone].total += parseInt(row.count) || 0;
      const rowFirst = row.first_failure ? new Date(row.first_failure) : null;
      const rowLast = row.last_failure ? new Date(row.last_failure) : null;
      if (rowFirst && (!failuresByPhoneMap[phone].firstFailure || rowFirst < failuresByPhoneMap[phone].firstFailure)) {
        failuresByPhoneMap[phone].firstFailure = rowFirst;
      }
      if (rowLast && (!failuresByPhoneMap[phone].lastFailure || rowLast > failuresByPhoneMap[phone].lastFailure)) {
        failuresByPhoneMap[phone].lastFailure = rowLast;
      }
    }
    const failuresByPhoneRows = Object.entries(failuresByPhoneMap)
      .sort(([, a], [, b]) => b.total - a.total)
      .map(([phone, counts], i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${phone}</td>
          ${failuresByPhoneCodes.map(code => `<td>${counts[code] || 0}</td>`).join('')}
          <td><strong>${counts.total}</strong></td>
          <td>${counts.firstFailure ? counts.firstFailure.toLocaleString('en-IN', istOpts) : '—'}</td>
          <td>${counts.lastFailure ? counts.lastFailure.toLocaleString('en-IN', istOpts) : '—'}</td>
        </tr>
      `).join('');
    const failuresByPhoneHeaderCells = failuresByPhoneCodes.map(code => `<th>${code}</th>`).join('');

    // Unknown messages table rows
    const unknownMessageRows = recentUnknownMessages.map((row, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${row.phone}</td>
        <td>${row.message}</td>
        <td>${row.timestamp}</td>
      </tr>
    `).join('');

    const recentMessageRows = recentMessages.map((row, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${row.phone}</td>
        <td>${row.messageType}</td>
        <td>${row.templateName}</td>
        <td>${row.messageStatus}</td>
        <td>${row.failureCode}</td>
        <td>${row.timestamp}</td>
      </tr>
    `).join('');

    const userEventRows = userEventSummary.map((row, i) => `
      <tr
        data-birthdays="${row.birthdays}"
        data-anniversaries="${row.anniversaries}"
        data-total="${row.totalEvents}"
        data-last-interaction="${row.lastInteractionTs}"
      >
        <td>${i + 1}</td>
        <td>${row.phone}</td>
        <td>${row.birthdays}</td>
        <td>${row.anniversaries}</td>
        <td>${row.totalEvents}</td>
        <td>${row.lastInteraction}</td>
      </tr>
    `).join('');

    const incomingMessageRows = recentIncoming.map((row, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${row.phone}</td>
        <td>${row.message}</td>
        <td>${row.timestamp}</td>
      </tr>
    `).join('');

    const allUserRows = allUsers.map((row, i) => `
      <tr
        data-events="${row.eventCount}"
        data-last-interaction="${row.lastInteractionTs}"
        data-created="${row.createdAtTs}"
        data-sunday-reminder="${row.sundayReminderActive}"
      >
        <td>${i + 1}</td>
        <td>${row.phone}</td>
        <td>${row.timezone}</td>
        <td>${row.lastInteraction}</td>
        <td>${row.createdAt}</td>
        <td><span class="reminder-status reminder-status-${row.sundayReminderStatus}">${row.sundayReminderStatus}</span></td>
      </tr>
    `).join('');

    const monthlyMetricRows = monthlyMetrics.map(row => {
      const rowStyle = row.isCurrent
        ? ' style="background: #eaf4fb; font-weight: 600;"'
        : (row.isFuture ? ' style="color: #aaa;"' : '');
      const target = row.targetActiveUsers != null ? row.targetActiveUsers.toLocaleString() : '—';
      const activeUsers = row.activeUsers != null ? row.activeUsers : '—';
      let progressCell = '—';
      if (row.progress != null) {
        const pct = parseFloat(row.progress);
        const color = pct >= 100 ? '#27ae60' : (pct >= 50 ? '#e67e22' : '#e74c3c');
        progressCell = `<span style="color: ${color}; font-weight: 600;">${row.progress}%</span>`;
      }
      return `
      <tr${rowStyle}>
        <td>${row.label}</td>
        <td>${row.newUsers}</td>
        <td>${row.cumulativeUsers}</td>
        <td>${activeUsers}</td>
        <td>${target}</td>
        <td>${progressCell}</td>
        <td>${row.eventsAdded}</td>
        <td>${row.messagesSent}</td>
      </tr>
    `;
    }).join('');

    const allEventRows = allEvents.map((row, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${row.phone}</td>
        <td>${row.name}</td>
        <td>${row.day} ${row.month}</td>
        <td>${row.type}</td>
        <td>${row.createdAt}</td>
      </tr>
    `).join('');

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
              table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 0.95rem; }
              th, td { text-align: left; padding: 10px; border-bottom: 1px solid #eee; }
              th { background: #fafafa; font-weight: 600; color: #555; }
              th.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
              th.sortable:hover { background: #f0f0f0; color: #222; }
              th.sortable .sort-indicator { font-size: 0.75rem; color: #3498db; }
              .reminder-status { font-size: 0.85rem; font-weight: 600; text-transform: capitalize; }
              .reminder-status-active { color: #27ae60; }
              .reminder-status-dormant { color: #95a5a6; }
              tr:nth-child(even) td { background: #fcfcfc; }
              .scrollable-table { max-height: 500px; overflow-y: auto; }
          </style>
      </head>
      <body>
          <div class="container">
              <h1>Birthday Reminder Dashboard</h1>
              
              <div class="cards">
                  <div class="card">
                      <h3>Total Users</h3>
                      <div class="value">${totalUsers}</div>
                  </div>
                  <div class="card">
                      <h3>Active Users</h3>
                      <div class="value">${sundayReminderStats.active}</div>
                      <div style="font-size: 0.75rem; color: #888; margin-top: 4px;">receiving Sunday reminders</div>
                  </div>
                  <div class="card">
                      <h3>Stored Birthdays/Annivs</h3>
                      <div class="value">${totalEvents}</div>
                  </div>
                  <div class="card">
                      <h3>Stored Anniversaries</h3>
                      <div class="value">${totalAnniversaries}</div>
                  </div>
                  <div class="card">
                      <h3>Total All-Time Messages</h3>
                      <div class="value">${totalAllTime}</div>
                  </div>
              </div>

              <!-- ── ENGAGEMENT & HEALTH ── -->
              <h2 style="margin-top: 30px; color: #555;">Engagement & Health</h2>
              <div class="cards">
                  <div class="card">
                      <h3>Events Added Today</h3>
                      <div class="value">${eventsAddedToday.total}</div>
                      <div style="font-size: 0.75rem; color: #888; margin-top: 4px;">${eventsAddedToday.birthdays} birthdays, ${eventsAddedToday.anniversaries} anniversaries</div>
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
                  <div class="card">
                      <h3>DAU (Today)</h3>
                      <div class="value">${dau}</div>
                  </div>
                  <div class="card">
                      <h3>WAU (7 Days)</h3>
                      <div class="value">${wau}</div>
                  </div>
                  <div class="card">
                      <h3>Onboarding Completion</h3>
                      <div class="value">${onboardingCompletionRate}%</div>
                      <div style="font-size: 0.75rem; color: #888; margin-top: 4px;">Step 1: ${onboardingFunnel.step_1} · Step 2: ${onboardingFunnel.step_2} · Step 3: ${onboardingFunnel.step_3}</div>
                  </div>
                  <div class="card${parseFloat(unknownIntentRate) > 20 ? ' fail' : ''}">
                      <h3>Unknown Intent Rate</h3>
                      <div class="value">${unknownIntentRate}%</div>
                  </div>
                  <div class="card">
                      <h3>Sunday Reminder Active</h3>
                      <div class="value">${sundayReminderStats.active}</div>
                      <div style="font-size: 0.75rem; color: #888; margin-top: 4px;">${sundayReminderStats.dormant} dormant · ${sundayReminderStats.total} total</div>
                  </div>
              </div>

              <!-- ── REMINDER EFFECTIVENESS ── -->
              <h2 style="margin-top: 30px; color: #555;">Reminder Effectiveness</h2>
              <div class="cards">
                  <div class="card">
                      <h3>Reminders Sent Today</h3>
                      <div class="value">${remindersSentToday.total}</div>
                      <div style="font-size: 0.75rem; color: #888; margin-top: 4px;">${remindersSentToday.daily} daily, ${remindersSentToday.weekly} weekly</div>
                  </div>
                  <div class="card">
                      <h3>Reminder Delivery Rate</h3>
                      <div class="value">${reminderDeliveryRate.deliveryRate}%</div>
                      <div style="font-size: 0.75rem; color: #888; margin-top: 4px;">${reminderDeliveryRate.delivered} delivered / ${reminderDeliveryRate.total} sent</div>
                  </div>
                  <div class="card${reminderDeliveryRate.failed > 0 ? ' fail' : ''}">
                      <h3>Reminders Failed</h3>
                      <div class="value">${reminderDeliveryRate.failed}</div>
                  </div>
                  <div class="card">
                      <h3>Post-Reminder Engagement</h3>
                      <div class="value">${postReminderEngagement.engagementRate}%</div>
                      <div style="font-size: 0.75rem; color: #888; margin-top: 4px;">${postReminderEngagement.engagedSends} / ${postReminderEngagement.totalReminderSends} responded within 24h</div>
                  </div>
              </div>

              <!-- ── MONTHLY GROWTH METRICS ── -->
              <h2 style="margin-top: 30px; color: #555;">Monthly Metrics</h2>
              <p style="color: #888; font-size: 0.85rem; margin-top: -8px;">
                  Tracking toward <strong>1,000 active users</strong> (active = receiving Sunday reminders). Target ramps from the current
                  month to the goal over 6 months; progress compares active users against that target. Active users is a live snapshot,
                  so only the current month is populated (past months can't be reconstructed).
              </p>
              <div class="chart-container">
                  <table>
                      <thead>
                          <tr>
                              <th>Month</th>
                              <th>New Users</th>
                              <th>Cumulative Users</th>
                              <th>Active Users</th>
                              <th>Target Active Users</th>
                              <th>Progress vs Target</th>
                              <th>Events Added</th>
                              <th>Messages Sent</th>
                          </tr>
                      </thead>
                      <tbody>
                          ${monthlyMetricRows || '<tr><td colspan="8">No data yet.</td></tr>'}
                      </tbody>
                  </table>
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
                  <div class="chart-container" style="grid-column: span 2;">
                      <h3>Dates Added Per Week (Last 5 Weeks)</h3>
                      <canvas id="weeklyEventsChart"></canvas>
                  </div>
                  <div class="chart-container" style="grid-column: span 2;">
                      <h3>DAU Trend (Last 30 Days)</h3>
                      <canvas id="dauTrendChart"></canvas>
                  </div>
                  <div class="chart-container">
                      <h3>Onboarding Funnel</h3>
                      <canvas id="onboardingFunnelChart"></canvas>
                  </div>
                  <div class="chart-container">
                      <h3>Intent Distribution</h3>
                      <canvas id="intentChart"></canvas>
                  </div>
                  <div class="chart-container" style="grid-column: span 2;">
                      <h3>Unknown Intent Messages (Last 25)</h3>
                      <div class="scrollable-table">
                          <table>
                              <thead>
                                  <tr>
                                      <th>#</th>
                                      <th>Phone Number</th>
                                      <th>Message</th>
                                      <th>Timestamp (IST)</th>
                                  </tr>
                              </thead>
                              <tbody>
                                  ${unknownMessageRows || '<tr><td colspan="4">No unknown intent messages yet.</td></tr>'}
                              </tbody>
                          </table>
                      </div>
                  </div>
                  <div class="chart-container" style="grid-column: span 2;">
                      <h3>Failure Breakdown by Phone Number (All Time)</h3>
                      <div class="scrollable-table">
                          <table>
                              <thead>
                                  <tr>
                                      <th>#</th>
                                      <th>Phone Number</th>
                                      ${failuresByPhoneHeaderCells}
                                      <th>Total</th>
                                      <th>First Failure (IST)</th>
                                      <th>Last Failure (IST)</th>
                                  </tr>
                              </thead>
                              <tbody>
                                  ${failuresByPhoneRows || `<tr><td colspan="${5 + failuresByPhoneCodes.length}">No failures recorded.</td></tr>`}
                              </tbody>
                          </table>
                      </div>
                  </div>
                  <div class="chart-container" style="grid-column: span 2;">
                      <h3>Last 25 Outgoing Messages</h3>
                      <table>
                          <thead>
                              <tr>
                                  <th>#</th>
                                  <th>Phone Number</th>
                                  <th>Message Type</th>
                                  <th>Template Name</th>
                                  <th>Status</th>
                                  <th>Failure Code</th>
                                  <th>Timestamp</th>
                              </tr>
                          </thead>
                          <tbody>
                              ${recentMessageRows || '<tr><td colspan="7">No outgoing messages yet.</td></tr>'}
                          </tbody>
                      </table>
                  </div>
                  <div class="chart-container" style="grid-column: span 2;">
                      <h3>Last 25 Incoming Messages</h3>
                      <table>
                          <thead>
                              <tr>
                                  <th>#</th>
                                  <th>Phone Number</th>
                                  <th>Message</th>
                                  <th>Timestamp (IST)</th>
                              </tr>
                          </thead>
                          <tbody>
                              ${incomingMessageRows || '<tr><td colspan="4">No incoming messages yet.</td></tr>'}
                          </tbody>
                      </table>
                  </div>
                  <div class="chart-container" style="grid-column: span 2;">
                      <h3>Users: Birthdays and Anniversaries (Last 25)</h3>
                      <table id="userEventsTable">
                          <thead>
                              <tr>
                                  <th>#</th>
                                  <th>Phone Number</th>
                                  <th class="sortable" data-sort="birthdays">Birthdays<span class="sort-indicator"></span></th>
                                  <th class="sortable" data-sort="anniversaries">Anniversaries<span class="sort-indicator"></span></th>
                                  <th class="sortable" data-sort="total">Total<span class="sort-indicator"></span></th>
                                  <th class="sortable" data-sort="last-interaction">Last Interaction (IST)<span class="sort-indicator"></span></th>
                              </tr>
                          </thead>
                          <tbody>
                              ${userEventRows || '<tr><td colspan="6">No users found.</td></tr>'}
                          </tbody>
                      </table>
                  </div>
                  <div class="chart-container" style="grid-column: span 2;">
                      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
                          <h3 style="margin: 0;">All Birthdays & Anniversaries (${allEvents.length} entries)</h3>
                          <a href="/admin/export/events.xlsx" style="display: inline-block; padding: 7px 16px; background: #27ae60; color: #fff; text-decoration: none; border-radius: 6px; font-size: 0.85rem; font-weight: 600; letter-spacing: 0.02em;">⬇ Export to Excel</a>
                      </div>
                      <div class="scrollable-table">
                          <table>
                              <thead>
                                  <tr>
                                      <th>#</th>
                                      <th>Phone Number</th>
                                      <th>Name</th>
                                      <th>Date</th>
                                      <th>Type</th>
                                      <th>Added On (IST)</th>
                                  </tr>
                              </thead>
                              <tbody>
                                  ${allEventRows || '<tr><td colspan="6">No entries found.</td></tr>'}
                              </tbody>
                          </table>
                      </div>
                  </div>
                  <div class="chart-container" style="grid-column: span 2;">
                      <h3>All Users (${allUsers.length} users)</h3>
                      <div class="scrollable-table">
                          <table id="allUsersTable">
                              <thead>
                                  <tr>
                                      <th>#</th>
                                      <th>Phone Number</th>
                                      <th>Timezone</th>
                                      <th class="sortable" data-sort="last-interaction">Last Interaction (IST)<span class="sort-indicator"></span></th>
                                      <th class="sortable" data-sort="created">Joined On (IST)<span class="sort-indicator"></span></th>
                                      <th class="sortable" data-sort="sunday-reminder">Sunday Reminder<span class="sort-indicator"></span></th>
                                  </tr>
                              </thead>
                              <tbody>
                                  ${allUserRows || '<tr><td colspan="6">No users found.</td></tr>'}
                              </tbody>
                          </table>
                      </div>
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

              new Chart(document.getElementById('weeklyEventsChart'), {
                  type: 'bar',
                  data: {
                      labels: ${eventsTrendLabels},
                      datasets: [
                          {
                              label: 'Birthdays Added',
                              data: ${eventsTrendBirthdays},
                              backgroundColor: '#3498db'
                          },
                          {
                              label: 'Anniversaries Added',
                              data: ${eventsTrendAnniversaries},
                              backgroundColor: '#e67e22'
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

              // DAU Trend (30 days)
              new Chart(document.getElementById('dauTrendChart'), {
                  type: 'line',
                  data: {
                      labels: ${dauTrendLabels},
                      datasets: [{
                          label: 'Daily Active Users',
                          data: ${dauTrendData},
                          borderColor: '#9b59b6',
                          backgroundColor: 'rgba(155, 89, 182, 0.1)',
                          fill: true,
                          tension: 0.2
                      }]
                  },
                  options: { responsive: true, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
              });

              // Onboarding Funnel
              new Chart(document.getElementById('onboardingFunnelChart'), {
                  type: 'bar',
                  data: {
                      labels: ${onboardingFunnelLabels},
                      datasets: [{
                          label: 'Users',
                          data: ${onboardingFunnelData},
                          backgroundColor: ['#e74c3c', '#e67e22', '#f1c40f', '#2ecc71']
                      }]
                  },
                  options: { 
                      responsive: true, 
                      indexAxis: 'y',
                      scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } } },
                      plugins: { legend: { display: false } }
                  }
              });

              function enableNumericTableSort(tableId) {
                  const table = document.getElementById(tableId);
                  if (!table) return;
                  const tbody = table.querySelector('tbody');
                  const headers = table.querySelectorAll('th.sortable');
                  let currentSort = { key: null, asc: true };

                  headers.forEach(th => {
                      th.addEventListener('click', () => {
                          const key = th.dataset.sort;
                          const asc = currentSort.key === key ? !currentSort.asc : true;
                          currentSort = { key, asc };
                          headers.forEach(h => {
                              const indicator = h.querySelector('.sort-indicator');
                              if (h.dataset.sort === key) {
                                  indicator.textContent = asc ? ' ▲' : ' ▼';
                              } else {
                                  indicator.textContent = '';
                              }
                          });
                          const attr = 'data-' + key;
                          const rows = Array.from(tbody.querySelectorAll('tr')).filter(
                              row => row.querySelectorAll('td').length > 1 && row.hasAttribute(attr)
                          );
                          rows.sort((a, b) => {
                              const va = Number(a.getAttribute(attr)) || 0;
                              const vb = Number(b.getAttribute(attr)) || 0;
                              return asc ? va - vb : vb - va;
                          });
                          rows.forEach((row, i) => {
                              row.cells[0].textContent = i + 1;
                              tbody.appendChild(row);
                          });
                      });
                  });
              }

              enableNumericTableSort('userEventsTable');
              enableNumericTableSort('allUsersTable');

              // Intent Distribution
              new Chart(document.getElementById('intentChart'), {
                  type: 'doughnut',
                  data: {
                      labels: ${intentLabels},
                      datasets: [{
                          data: ${intentData},
                          backgroundColor: [
                              '#3498db', '#2ecc71', '#e74c3c', '#e67e22', '#9b59b6',
                              '#1abc9c', '#f1c40f', '#34495e', '#95a5a6', '#d35400',
                              '#c0392b', '#7f8c8d', '#2c3e50', '#16a085'
                          ]
                      }]
                  },
                  options: { 
                      responsive: true,
                      plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } } }
                  }
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

// Export all birthdays & anniversaries as Excel
app.get('/admin/export/events.xlsx', async (req, res) => {
  try {
    const events = await metrics.getAllEventsTable();
    const rows = events.map((e, i) => ({
      '#': i + 1,
      'Phone Number': e.phone,
      'Name': e.name,
      'Day': e.day,
      'Month': e.month,
      'Type': e.type,
      'Added On (IST)': e.createdAt
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Birthdays & Anniversaries');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="birthdays-anniversaries.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('Error exporting events to Excel:', err);
    res.status(500).json({ error: 'Failed to export events' });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('Bot is alive on port', PORT);
  // Wait for all DB migrations to finish before starting schedulers
  await dbReady;
  // Start daily reminder scheduler
  startReminderScheduler();
  // Start daily upcoming reminder scheduler
  startDailyUpcomingReminderScheduler();
  // Start new-user follow-up scheduler (8 PM nudge within 24h of signup)
  startNewUserFollowupScheduler();
  // Start onboarding nudge scheduler (5-min nudge for idle new users)
  startOnboardingNudgeScheduler();
});
