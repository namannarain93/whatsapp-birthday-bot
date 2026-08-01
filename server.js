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
const path = require('path');
const XLSX = require('xlsx');
const webhookRoutes = require('./src/routes/webhook.routes');
const { sendTemplateMessage } = require('./src/services/whatsapp.service');
const metrics = require('./metrics');

// Initialize database
const { dbReady } = require('./db.js');

// Import job schedulers
const { startReminderScheduler } = require('./src/jobs/reminder.job');
const { startDayBeforeReminderScheduler } = require('./src/jobs/eventDetailsReminder.job');
const { startDailyUpcomingReminderScheduler } = require('./src/jobs/dailyUpcomingReminder.job');
const { startNewUserFollowupScheduler } = require('./src/jobs/newUserFollowup.job');
const { startOnboardingNudgeScheduler } = require('./src/jobs/onboardingNudge.job');
const { startDailySummaryScheduler } = require('./src/jobs/dailySummary.job');
const { startMonthlyActiveUsersScheduler } = require('./src/jobs/monthlyActiveUsers.job');

const DASHBOARD_THEMES = [
  { id: 'light', label: '☀️ Light', dark: false },
  { id: 'dark', label: '🌙 Dark', dark: true },
  { id: 'zen', label: '🪷 Zen Garden', dark: false },
  { id: 'vault', label: '🟩 Vault', dark: true },
  { id: 'candy', label: '🍬 Candy Pop', dark: false }
];
const DASHBOARD_THEME_IDS = DASHBOARD_THEMES.map(theme => theme.id);

const app = express();

// Request logging middleware
app.use((req, res, next) => {
  console.log('⚡ INCOMING REQUEST:', req.method, req.path);
  next();
});

// JSON body parsing middleware
app.use(express.json());

// Static assets (favicon, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// Register webhook routes
app.use('/', webhookRoutes);

// India states GeoJSON for the 3D map (static, cacheable)
app.get('/admin/geo/india-states.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'src/data/india-states.json'));
});

// Admin dashboard route
app.get('/admin', async (req, res) => {
  try {
    const totalAllTime = await metrics.getTotalMessagesAllTime();
    const sentToday = await metrics.getMessagesToday();
    const failedToday = await metrics.getFailedToday();
    const failureRate = await metrics.getFailureRateToday();
    const trend = await metrics.getLast7DayTrend();
    const failureByTemplate = await metrics.getFailureBreakdownByTemplate();
    const hourly = await metrics.getHourlyTrendToday();
    const totalUsers = await metrics.getTotalUsersCount();
    const totalEvents = await metrics.getTotalEventsCount();
    const totalAnniversaries = await metrics.getTotalAnniversariesCount();
    const eventsAddedToday = await metrics.getEventsAddedToday();
    const eventsTrend = await metrics.getWeeklyEventsTrend();
    const recentMessages = await metrics.getRecentMessageStatusTable();
    const userEventSummary = await metrics.getUserEventSummaryTable();
    const recentIncoming = await metrics.getRecentIncomingMessages();
    const recentOutgoing = await metrics.getRecentOutgoingMessages();
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
    const nextReminderDate = await metrics.getNextReminderDate();
    const nextReminderValue = nextReminderDate
      ? (nextReminderDate.daysUntil === 1 ? 'Tomorrow' : `${nextReminderDate.daysUntil} days`)
      : '—';
    const nextReminderSubtitle = nextReminderDate
      ? `${nextReminderDate.label}<br>${nextReminderDate.total} event${nextReminderDate.total === 1 ? '' : 's'} (${nextReminderDate.birthdays} birthdays, ${nextReminderDate.anniversaries} anniversaries)`
      : 'no upcoming events';
    const reminderDeliveryRate = await metrics.getReminderDeliveryRate();
    const postReminderEngagement = await metrics.getPostReminderEngagement();
    const failuresByPhoneRaw = await metrics.getFailuresByPhone();
    const latestDailySummary = await metrics.getLatestDailySummary();
    const geoDistribution = await metrics.getGeoDistribution();
    const geoDistributionJson = JSON.stringify(geoDistribution);

    const trendLabels = JSON.stringify(trend.map(t => new Date(t.day).toLocaleDateString()));
    const trendData = JSON.stringify(trend.map(t => parseInt(t.count)));
    
    // Failure breakdown by template (stacked): X axis = templates, one dataset per error code
    const failureByTemplateLabels = JSON.stringify(failureByTemplate.templates);
    const failureByTemplatePalette = [
      '#e74c3c', '#3498db', '#e67e22', '#2ecc71', '#9b59b6',
      '#f1c40f', '#1abc9c', '#34495e', '#e84393', '#95a5a6'
    ];
    const sumCounts = arr => arr.reduce((s, n) => s + n, 0);
    const failureByTemplateDatasets = JSON.stringify(
      Object.keys(failureByTemplate.byCode)
        // Sort by total descending so the biggest codes stack at the bottom
        .sort((a, b) => sumCounts(failureByTemplate.byCode[b]) - sumCounts(failureByTemplate.byCode[a]))
        .map((code, i) => ({
          label: code,
          data: failureByTemplate.byCode[code],
          backgroundColor: failureByTemplatePalette[i % failureByTemplatePalette.length]
        }))
    );

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
    const onboardingFunnelLabels = JSON.stringify(['Step 1', 'Step 2', 'Completed']);
    const onboardingFunnelData = JSON.stringify([
      onboardingFunnel.step_1,
      onboardingFunnel.step_2,
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

    const outgoingMessageRows = recentOutgoing.map((row, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${row.phone}</td>
        <td>${row.message}</td>
        <td>${row.status}</td>
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
        ? ' style="background: var(--current-row-highlight); font-weight: 600;"'
        : (row.isFuture ? ' style="color: var(--text-faint);"' : '');
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
        <td>${row.cumulativeEvents}</td>
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

    // AI daily summary box (shown at top of dashboard)
    const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Split the summary into bullet points. New summaries come as "- " lines,
    // but older ones may be a single paragraph, so fall back to sentence splits.
    const toSummaryBullets = text => {
      const raw = String(text || '').trim();
      let items = raw
        .split('\n')
        .map(line => line.replace(/^\s*[-*•]\s*/, '').trim())
        .filter(Boolean);
      if (items.length <= 1) {
        items = raw
          .split(/(?<=[.!?])\s+/)
          .map(s => s.trim())
          .filter(Boolean);
      }
      return items;
    };
    const summaryBulletsHtml = latestDailySummary
      ? toSummaryBullets(latestDailySummary.text).map(item => `<li>${escapeHtml(item)}</li>`).join('')
      : '';
    // Summary is generated for the previous calendar day (rolling last-24h snapshot at ~7 AM IST)
    const summaryOfDate = latestDailySummary
      ? (() => {
          const raw = latestDailySummary.date;
          const iso = raw instanceof Date
            ? raw.toISOString().slice(0, 10)
            : String(raw).slice(0, 10);
          const [y, m, d] = iso.split('-').map(Number);
          const prev = new Date(Date.UTC(y, m - 1, d - 1));
          return prev.toLocaleDateString('en-IN', {
            timeZone: 'UTC',
            weekday: 'long',
            day: 'numeric',
            month: 'short',
            year: 'numeric'
          });
        })()
      : '';
    const summaryUpdatedAt = latestDailySummary?.updatedAt
      ? new Date(latestDailySummary.updatedAt).toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        })
      : '';
    const aiSummaryHtml = latestDailySummary
      ? `
          <div class="ai-summary">
              <h3>🤖 Daily AI Summary <span class="ai-summary-date">for ${summaryOfDate}</span></h3>
              ${summaryUpdatedAt ? `<p class="ai-summary-updated">Updated ${summaryUpdatedAt} IST</p>` : ''}
              <ul>${summaryBulletsHtml}</ul>
          </div>`
      : `
          <div class="ai-summary">
              <h3>🤖 Daily AI Summary</h3>
              <p class="ai-summary-pending">No summary yet — the first one will be generated at 7:00 AM IST.</p>
          </div>`;

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Birthday Bot Admin</title>
          <link rel="icon" href="/favicon.ico" sizes="32x32">
          <link rel="icon" type="image/png" href="/favicon.png" sizes="192x192">
          <link rel="apple-touch-icon" href="/apple-touch-icon.png">
          <script>
              // Apply saved/system theme before first paint to avoid a flash.
              (function () {
                  var THEMES = ${JSON.stringify(DASHBOARD_THEME_IDS)};
                  try {
                      var stored = localStorage.getItem('dashboard-theme');
                      var theme = THEMES.indexOf(stored) !== -1
                          ? stored
                          : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
                      document.documentElement.setAttribute('data-theme', theme);
                  } catch (e) {
                      document.documentElement.setAttribute('data-theme', 'light');
                  }
              })();
          </script>
          <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
          <script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>
          <script src="https://cdn.jsdelivr.net/npm/echarts-gl@2.0.9/dist/echarts-gl.min.js"></script>
          <style>
              /* ── THEME TOKENS ──
                 Each theme overrides colors AND widget design: surface treatment
                 (--card-*), accent bar (--panel-accent), table header (--th-bg),
                 shape (--radius) and type (--font-*). */
              :root {
                  --radius: 16px;
                  --font-body: -apple-system, 'Segoe UI', Roboto, sans-serif;
                  --font-heading: inherit;
                  --bg: #f4f7f6;
                  --surface: #ffffff;
                  --surface-alt: #fafafa;
                  --surface-hover: #f0f0f0;
                  --row-even: #fcfcfc;
                  --text: #333;
                  --text-heading: #444;
                  --text-subheading: #555;
                  --text-muted: #6b7280;
                  --text-faint: #aaa;
                  --text-strong: #222;
                  --border: #eee;
                  --accent: #3498db;
                  --danger: #e74c3c;
                  --shadow: rgba(0,0,0,0.1);
                  --current-row-highlight: #eaf4fb;
                  /* widget design */
                  --card-bg: #ffffff;
                  --card-border: #e9edf0;
                  --card-border-width: 1px;
                  --card-border-hover: #cfdae2;
                  --card-shadow: 0 1px 2px rgba(16,24,40,0.05), 0 10px 24px -14px rgba(16,24,40,0.14);
                  --card-hover-shadow: 0 2px 4px rgba(16,24,40,0.06), 0 18px 34px -14px rgba(16,24,40,0.22);
                  --card-lift: translateY(-3px);
                  --panel-accent: linear-gradient(90deg, var(--accent), transparent 70%);
                  --panel-accent-h: 2px;
                  --th-bg: #f7f9fa;
                  --value-font-weight: 700;
              }
              /* ── DARK: sleek glass — smoky gradients, frosted borders, soft glow ── */
              [data-theme="dark"] {
                  --radius: 18px;
                  --bg: #101216;
                  --surface: #1c2128;
                  --surface-alt: rgba(255,255,255,0.04);
                  --surface-hover: rgba(255,255,255,0.08);
                  --row-even: rgba(255,255,255,0.025);
                  --text: #c9d1d9;
                  --text-heading: #f2f4f7;
                  --text-subheading: #adbac7;
                  --text-muted: #8b949e;
                  --text-faint: #6e7681;
                  --text-strong: #ffffff;
                  --border: rgba(255,255,255,0.09);
                  --accent: #e8a34c;
                  --danger: #f85149;
                  --shadow: rgba(0,0,0,0.45);
                  --current-row-highlight: rgba(232,163,76,0.10);
                  --card-bg: linear-gradient(160deg, rgba(255,255,255,0.085) 0%, rgba(255,255,255,0.03) 45%, rgba(255,255,255,0.015) 100%);
                  --card-border: rgba(255,255,255,0.10);
                  --card-border-width: 1px;
                  --card-border-hover: rgba(232,163,76,0.45);
                  --card-shadow: inset 0 1px 0 rgba(255,255,255,0.09), 0 18px 40px -18px rgba(0,0,0,0.7);
                  --card-hover-shadow: inset 0 1px 0 rgba(255,255,255,0.12), 0 24px 48px -18px rgba(0,0,0,0.8), 0 0 24px -8px rgba(232,163,76,0.25);
                  --card-lift: translateY(-3px);
                  --panel-accent: linear-gradient(90deg, rgba(232,163,76,0.9), rgba(232,163,76,0) 65%);
                  --panel-accent-h: 2px;
                  --th-bg: #232931;
                  --value-font-weight: 600;
              }
              [data-theme="dark"] body {
                  background-image: radial-gradient(ellipse 900px 500px at 75% -10%, rgba(120,90,60,0.28) 0%, transparent 60%),
                                    radial-gradient(ellipse 700px 500px at 0% 100%, rgba(45,55,75,0.5) 0%, transparent 55%);
              }
              [data-theme="dark"] h1 { font-weight: 600; letter-spacing: -0.02em; }
              [data-theme="dark"] .card, [data-theme="dark"] .chart-container, [data-theme="dark"] .ai-summary { backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
              [data-theme="dark"] .card:not(.fail) .value { background: linear-gradient(180deg, #ffffff 30%, #b9c2cc 100%); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
              /* ── ZEN: gilded stillness — warm sand, soft gold, serif calm ── */
              [data-theme="zen"] {
                  --radius: 14px;
                  --font-body: Georgia, 'Times New Roman', serif;
                  --font-heading: Georgia, 'Times New Roman', serif;
                  --bg: #e8e1d1;
                  --surface: #f6f1e5;
                  --surface-alt: #efe8d8;
                  --surface-hover: #e9e0cc;
                  --row-even: #f1ebdd;
                  --text: #4c4437;
                  --text-heading: #3a3226;
                  --text-subheading: #5c5344;
                  --text-muted: #6f6758;
                  --text-faint: #aca391;
                  --text-strong: #2e2719;
                  --border: #d9cfb9;
                  --accent: #a8823c;
                  --danger: #b0492f;
                  --shadow: rgba(94, 80, 50, 0.18);
                  --current-row-highlight: #ece2c8;
                  --card-bg: linear-gradient(165deg, #faf6ec 0%, #f3ecdc 100%);
                  --card-border: #decf9f;
                  --card-border-width: 1px;
                  --card-border-hover: #c2a35c;
                  --card-shadow: inset 0 1px 0 rgba(255,252,240,0.9), 0 10px 26px -14px rgba(94,80,50,0.45);
                  --card-hover-shadow: inset 0 1px 0 rgba(255,252,240,0.9), 0 16px 32px -14px rgba(94,80,50,0.55);
                  --card-lift: translateY(-2px);
                  --panel-accent: linear-gradient(90deg, transparent, #c2a35c 50%, transparent);
                  --panel-accent-h: 1px;
                  --th-bg: #efe6cf;
                  --value-font-weight: 500;
              }
              [data-theme="zen"] body {
                  background-image: radial-gradient(ellipse at 20% 0%, #f0e9d8 0%, transparent 55%),
                                    radial-gradient(ellipse at 90% 100%, #ded4bd 0%, transparent 50%);
              }
              [data-theme="zen"] h1 { font-weight: 400; letter-spacing: 0.03em; font-style: italic; }
              /* Gilded frame: thin gold double border, centered ornament dot */
              [data-theme="zen"] .card, [data-theme="zen"] .chart-container, [data-theme="zen"] .ai-summary { outline: 1px solid rgba(168,130,60,0.28); outline-offset: -6px; }
              [data-theme="zen"] .card h3 { letter-spacing: 0.18em; font-size: 0.72rem; }
              [data-theme="zen"] .card .value { font-style: italic; color: #7a5f28; }
              [data-theme="zen"] th { text-transform: uppercase; letter-spacing: 0.1em; font-size: 0.78rem; }
              /* ── VAULT: brutalist neon — black steel, electric green, mono type ── */
              [data-theme="vault"] {
                  --radius: 0px;
                  --font-body: 'Courier New', ui-monospace, monospace;
                  --font-heading: 'Courier New', ui-monospace, monospace;
                  --bg: #0b0d0b;
                  --surface: #141714;
                  --surface-alt: #1b1f1b;
                  --surface-hover: #232823;
                  --row-even: #181c18;
                  --text: #c4d2c5;
                  --text-heading: #3dfc6e;
                  --text-subheading: #9be8ac;
                  --text-muted: #7c8f7e;
                  --text-faint: #5a685c;
                  --text-strong: #eafcee;
                  --border: #2c352d;
                  --accent: #3dfc6e;
                  --danger: #ff5c47;
                  --shadow: rgba(61, 252, 110, 0.08);
                  --current-row-highlight: #14261a;
                  --card-bg: linear-gradient(180deg, #161a16 0%, #101410 100%);
                  --card-border: #2c352d;
                  --card-border-width: 1px;
                  --card-border-hover: #3dfc6e;
                  --card-shadow: 0 0 0 1px rgba(61,252,110,0.06), 4px 4px 0 0 rgba(61,252,110,0.10);
                  --card-hover-shadow: 0 0 0 1px rgba(61,252,110,0.25), 6px 6px 0 0 rgba(61,252,110,0.18), 0 0 26px -6px rgba(61,252,110,0.35);
                  --card-lift: translate(-2px, -2px);
                  --panel-accent: repeating-linear-gradient(90deg, #3dfc6e 0 8px, transparent 8px 14px);
                  --panel-accent-h: 2px;
                  --th-bg: #10160f;
                  --value-font-weight: 700;
              }
              [data-theme="vault"] body {
                  background-image: repeating-linear-gradient(0deg, transparent 0 3px, rgba(61,252,110,0.012) 3px 4px);
              }
              [data-theme="vault"] h1, [data-theme="vault"] h2, [data-theme="vault"] h3 { text-transform: uppercase; letter-spacing: 0.12em; }
              [data-theme="vault"] h1 { text-shadow: 0 0 18px rgba(61,252,110,0.45); }
              /* Terminal frame: bracket corners on KPI cards */
              [data-theme="vault"] .card::after { content: ''; position: absolute; inset: 5px; border: 1px solid rgba(61,252,110,0.12); pointer-events: none; clip-path: polygon(0 0, 14px 0, 14px 1px, 1px 1px, 1px 14px, 0 14px, 0 0, 100% 0, 100% 14px, calc(100% - 1px) 14px, calc(100% - 1px) 1px, calc(100% - 14px) 1px, calc(100% - 14px) 0, 100% 0, 100% 100%, calc(100% - 14px) 100%, calc(100% - 14px) calc(100% - 1px), calc(100% - 1px) calc(100% - 1px), calc(100% - 1px) calc(100% - 14px), 100% calc(100% - 14px), 100% 100%, 0 100%, 0 calc(100% - 14px), 1px calc(100% - 14px), 1px calc(100% - 1px), 14px calc(100% - 1px), 14px 100%, 0 100%); }
              [data-theme="vault"] .card .value { color: #3dfc6e; text-shadow: 0 0 12px rgba(61,252,110,0.5); }
              [data-theme="vault"] .card.fail .value { color: var(--danger); text-shadow: 0 0 12px rgba(255,92,71,0.5); }
              [data-theme="vault"] .card h3::before, [data-theme="vault"] h2::before { content: '// '; color: var(--text-faint); }
              [data-theme="vault"] th { border-bottom: 1px solid rgba(61,252,110,0.25); }
              /* ── CANDY: playful pop — bubblegum pink, mint, rounded corners ── */
              [data-theme="candy"] {
                  --radius: 20px;
                  --font-body: 'Trebuchet MS', 'Segoe UI', sans-serif;
                  --font-heading: 'Trebuchet MS', 'Segoe UI', sans-serif;
                  --bg: #f7c5df;
                  --surface: #fffafd;
                  --surface-alt: #fdeaf4;
                  --surface-hover: #fadeee;
                  --row-even: #fef2f8;
                  --text: #53355c;
                  --text-heading: #8a2f7a;
                  --text-subheading: #6d4478;
                  --text-muted: #805c7d;
                  --text-faint: #c39fbe;
                  --text-strong: #3f1f47;
                  --border: #f3d3e6;
                  --accent: #17b8a6;
                  --danger: #e8467c;
                  --shadow: rgba(138, 47, 122, 0.14);
                  --current-row-highlight: #dff5ef;
                  --card-bg: linear-gradient(170deg, #ffffff 0%, #fff3fa 100%);
                  --card-border: #ffffff;
                  --card-border-width: 2px;
                  --card-border-hover: #17b8a6;
                  --card-shadow: 0 6px 0 -2px rgba(138,47,122,0.10), 0 14px 30px -12px rgba(138,47,122,0.30);
                  --card-hover-shadow: 0 9px 0 -2px rgba(23,184,166,0.25), 0 20px 36px -12px rgba(138,47,122,0.38);
                  --card-lift: translateY(-4px) rotate(-0.4deg);
                  --panel-accent: linear-gradient(90deg, #f77fbe, #ffd166 35%, #17b8a6 70%, #9b8cff);
                  --panel-accent-h: 5px;
                  --th-bg: #fdeaf4;
                  --value-font-weight: 800;
              }
              [data-theme="candy"] body {
                  background-image: radial-gradient(circle at 15% 20%, #b7ecd9 0%, transparent 40%),
                                    radial-gradient(circle at 85% 80%, #f9a8cf 0%, transparent 45%);
              }
              [data-theme="candy"] h1 { color: #8a2f7a; }
              [data-theme="candy"] .card:not(.fail) .value { background: linear-gradient(135deg, #e8467c, #8a2f7a); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
              [data-theme="candy"] .card h3 { color: #85527f; font-weight: 700; }
              [data-theme="candy"] th { color: #8a2f7a; border-bottom: 2px solid #f6c7e2; }
              [data-theme="candy"] tr:nth-child(even) td { background: #fdf3f9; }
              body { font-family: var(--font-body); background: var(--bg); background-attachment: fixed; box-sizing: border-box; min-height: 100vh; margin: 0; padding: 20px; color: var(--text); transition: background 0.2s ease, color 0.2s ease; }
              .container { max-width: 1000px; margin: 0 auto; }
              h1, h2, h3 { font-family: var(--font-heading); }
              h1 { color: var(--text-heading); }
              /* ── THEME PICKER ── */
              .dashboard-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
              .dashboard-header h1 { margin: 0; }
              .theme-select { appearance: none; -webkit-appearance: none; background: var(--surface); color: var(--text); border: 1px solid var(--border); box-shadow: 0 2px 4px var(--shadow); border-radius: 999px; padding: 8px 38px 8px 16px; font-size: 0.9rem; font-weight: 600; font-family: var(--font-body); line-height: 1.35; cursor: pointer; transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease; background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23888' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 14px center; }
              .theme-select:hover { border-color: var(--accent); color: var(--accent); }
              /* ── WIDGETS ── */
              .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 20px; margin-bottom: 30px; }
              .card, .chart-container, .ai-summary {
                  position: relative;
                  overflow: hidden;
                  background: var(--card-bg);
                  border: var(--card-border-width) solid var(--card-border);
                  border-radius: var(--radius);
                  box-shadow: var(--card-shadow);
                  transition: transform 0.2s ease, box-shadow 0.25s ease, border-color 0.25s ease, background 0.2s ease;
              }
              .card { padding: 20px; text-align: center; }
              .card:hover { transform: var(--card-lift); box-shadow: var(--card-hover-shadow); border-color: var(--card-border-hover); }
              .card h3 { margin: 0; color: var(--text-muted); font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.06em; }
              .card .value { font-size: 2rem; font-weight: var(--value-font-weight); margin-top: 10px; color: var(--text-strong); line-height: 1.15; max-width: 100%; overflow-wrap: normal; word-break: normal; padding: 0 0.08em; box-sizing: border-box; }
              .card .value-text { font-size: clamp(1.15rem, 3.6vw, 1.75rem); letter-spacing: -0.01em; }
              .card .card-sub { font-size: 0.75rem; color: var(--text-muted); margin-top: 4px; line-height: 1.35; }
              .card.fail .value { color: var(--danger); }
              .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 20px; }
              .chart-container { padding: 20px; }
              /* Signature accent bar along the top edge of every panel */
              .chart-container::before, .ai-summary::before {
                  content: '';
                  position: absolute;
                  top: 0; left: 0; right: 0;
                  height: var(--panel-accent-h);
                  background: var(--panel-accent);
                  pointer-events: none;
              }
              .chart-container:hover { border-color: var(--card-border-hover); box-shadow: var(--card-hover-shadow); }
              table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 0.95rem; }
              th, td { text-align: left; padding: 10px; border-bottom: 1px solid var(--border); }
              th { background: var(--th-bg); font-weight: 600; color: var(--text-subheading); position: sticky; top: 0; z-index: 1; }
              th.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
              th.sortable:hover { background: var(--surface-hover); color: var(--text-strong); }
              th.sortable .sort-indicator { font-size: 0.75rem; color: var(--accent); }
              .reminder-status { font-size: 0.85rem; font-weight: 600; text-transform: capitalize; }
              .reminder-status-active { color: #27ae60; }
              .reminder-status-dormant { color: #95a5a6; }
              tr:nth-child(even) td { background: var(--row-even); }
              .scrollable-table { max-height: 500px; overflow-y: auto; }
              .ai-summary { padding: 20px; margin-bottom: 30px; }
              .ai-summary h3 { margin: 0 0 10px; color: var(--text-heading); font-size: 1rem; }
              .ai-summary-date { font-weight: normal; color: var(--text-muted); font-size: 0.85rem; margin-left: 8px; }
              .ai-summary-updated { margin: -4px 0 10px; color: var(--text-muted); font-size: 0.8rem; }
              .ai-summary p { margin: 0; line-height: 1.6; color: var(--text); }
              .ai-summary ul { margin: 0; padding-left: 20px; line-height: 1.6; color: var(--text); }
              .ai-summary ul li { margin-bottom: 6px; }
              .ai-summary ul li:last-child { margin-bottom: 0; }
              .ai-summary-pending { color: var(--text-muted); font-style: italic; }
              .geo-caption { color: var(--text-muted); font-size: 0.85rem; margin: 0 0 6px; }
              #indiaMap { height: 560px; }

              /* ── MOBILE ── */
              @media (max-width: 640px) {
                  body { padding: 12px; }
                  h1 { font-size: 1.5rem; }
                  h2 { font-size: 1.15rem; }
                  /* Theme picker: give emoji + chevron room; tighten header stack */
                  .dashboard-header { align-items: flex-start; gap: 10px; margin-bottom: 14px; }
                  .dashboard-header h1 { width: 100%; line-height: 1.2; }
                  .theme-select {
                      padding: 10px 42px 10px 18px;
                      background-position: right 16px center;
                      font-size: 0.95rem;
                      min-height: 42px;
                  }
                  /* KPI cards: two side by side instead of stacking vertically */
                  .cards { grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 24px; }
                  .card { padding: 14px 12px; }
                  .card h3 { font-size: 0.7rem; }
                  .card .value { font-size: clamp(1.15rem, 5.2vw, 1.5rem); margin-top: 6px; }
                  .card .value-text { font-size: clamp(1rem, 4.6vw, 1.35rem); }
                  .card .card-sub, .card div[style*="font-size"] { font-size: 0.65rem !important; }
                  /* Charts stack in a single column */
                  .charts { grid-template-columns: 1fr; gap: 14px; }
                  .charts > .chart-container[style*="span 2"] { grid-column: auto !important; }
                  .chart-container { padding: 14px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
                  /* Wide tables scroll horizontally instead of squishing */
                  .chart-container table, .scrollable-table table { min-width: 560px; }
                  .scrollable-table { overflow-x: auto; -webkit-overflow-scrolling: touch; }
                  th, td { padding: 8px; font-size: 0.85rem; }
                  #indiaMap { height: 380px; }
              }
          </style>
      </head>
      <body>
          <div class="container">
              <div class="dashboard-header">
                  <h1>Birthday Reminder Dashboard</h1>
                  <select id="themeSelect" class="theme-select" aria-label="Select design theme">
                      ${DASHBOARD_THEMES.map(theme => `<option value="${theme.id}">${theme.label}</option>`).join('')}
                  </select>
              </div>
              
              ${aiSummaryHtml}
              
              <div class="cards">
                  <div class="card">
                      <h3>Total Users</h3>
                      <div class="value">${totalUsers}</div>
                  </div>
                  <div class="card">
                      <h3>Active Users</h3>
                      <div class="value">${sundayReminderStats.active}</div>
                      <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">receiving Sunday reminders</div>
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
              <h2 style="margin-top: 30px; color: var(--text-subheading);">Engagement & Health</h2>
              <div class="cards">
                  <div class="card">
                      <h3>Events Added Today</h3>
                      <div class="value">${eventsAddedToday.total}</div>
                      <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">${eventsAddedToday.birthdays} birthdays, ${eventsAddedToday.anniversaries} anniversaries</div>
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
                      <h3>Reminders Sent Today</h3>
                      <div class="value">${remindersSentToday.total}</div>
                      <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">${remindersSentToday.daily} daily, ${remindersSentToday.weekly} weekly</div>
                  </div>
                  <div class="card">
                      <h3>Next Event Day</h3>
                      <div class="value value-text">${nextReminderValue}</div>
                      <div class="card-sub">${nextReminderSubtitle}</div>
                  </div>
              </div>

              <!-- ── REMINDER EFFECTIVENESS ── -->
              <h2 style="margin-top: 30px; color: var(--text-subheading);">Reminder Effectiveness</h2>
              <div class="cards">
                  <div class="card">
                      <h3>Reminder Delivery Rate</h3>
                      <div class="value">${reminderDeliveryRate.deliveryRate}%</div>
                      <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">${reminderDeliveryRate.delivered} delivered / ${reminderDeliveryRate.total} sent</div>
                  </div>
                  <div class="card${reminderDeliveryRate.failed > 0 ? ' fail' : ''}">
                      <h3>Reminders Failed</h3>
                      <div class="value">${reminderDeliveryRate.failed}</div>
                  </div>
                  <div class="card">
                      <h3>Post-Reminder Engagement</h3>
                      <div class="value">${postReminderEngagement.engagementRate}%</div>
                      <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">${postReminderEngagement.engagedSends} / ${postReminderEngagement.totalReminderSends} responded within 24h</div>
                  </div>
                  <div class="card">
                      <h3>WAU (7 Days)</h3>
                      <div class="value">${wau}</div>
                  </div>
                  <div class="card">
                      <h3>Onboarding Completion</h3>
                      <div class="value">${onboardingCompletionRate}%</div>
                      <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">Step 1: ${onboardingFunnel.step_1} · Step 2: ${onboardingFunnel.step_2}</div>
                  </div>
                  <div class="card${parseFloat(unknownIntentRate) > 20 ? ' fail' : ''}">
                      <h3>Unknown Intent Rate</h3>
                      <div class="value">${unknownIntentRate}%</div>
                  </div>
                  <div class="card">
                      <h3>Sunday Reminder Active</h3>
                      <div class="value">${sundayReminderStats.active}</div>
                      <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">${sundayReminderStats.dormant} dormant · ${sundayReminderStats.total} total</div>
                  </div>
              </div>

              <!-- ── GEOGRAPHY ── -->
              <h2 style="margin-top: 30px; color: var(--text-subheading);">Where Your Users Are</h2>
              <div class="chart-container" style="margin-bottom: 20px;">
                  <h3>User Distribution Across India (3D)</h3>
                  <p class="geo-caption">
                      Inferred from each number's mobile prefix (telecom circle), so it reflects where the
                      number was issued — ~90% accurate due to number portability. Column height = users;
                      drag to rotate, scroll to zoom.
                  </p>
                  <div id="indiaMap"></div>
                  <p id="geoFootnote" class="geo-caption" style="margin-top: 8px;"></p>
              </div>

              <!-- ── MONTHLY GROWTH METRICS ── -->
              <h2 style="margin-top: 30px; color: var(--text-subheading);">Monthly Metrics</h2>

              <div class="charts">
                  <div class="chart-container" style="grid-column: span 2;">
                      <h3>Progress Toward 1,000 Active Users</h3>
                      <p style="color: var(--text-muted); font-size: 0.85rem; margin-top: 0;">
                          Active = users receiving Sunday reminders. Target ramps from the current month to the goal over 6 months;
                          progress compares active users against that target. The current month is live; past months use the last
                          saved daily snapshot (months before snapshots began may show —).
                      </p>
                      <table>
                          <thead>
                              <tr>
                                  <th>Month</th>
                                  <th>New Users</th>
                                  <th>Cumulative Users</th>
                                  <th>Active Users</th>
                                  <th>Target Active Users</th>
                                  <th>Progress vs Target</th>
                                  <th>Cumulative Birthdays/Annivs</th>
                                  <th>Messages Sent</th>
                              </tr>
                          </thead>
                          <tbody>
                              ${monthlyMetricRows || '<tr><td colspan="8">No data yet.</td></tr>'}
                          </tbody>
                      </table>
                  </div>
                  <div class="chart-container" style="grid-column: span 2;">
                      <h3>Hourly Activity Today (IST)</h3>
                      <canvas id="hourlyChart"></canvas>
                  </div>
                  <div class="chart-container">
                      <h3>7-Day Message Trend</h3>
                      <canvas id="trendChart"></canvas>
                  </div>
                  <div class="chart-container">
                      <h3>Failure Breakdown by Template (by Code)</h3>
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
                      <h3>Last 25 Outgoing Messages (Sent Text)</h3>
                      <table>
                          <thead>
                              <tr>
                                  <th>#</th>
                                  <th>Phone Number</th>
                                  <th>Message</th>
                                  <th>Status</th>
                                  <th>Timestamp (IST)</th>
                              </tr>
                          </thead>
                          <tbody>
                              ${outgoingMessageRows || '<tr><td colspan="5">No outgoing messages yet.</td></tr>'}
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
                      <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 12px;">
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
              // ── THEME-AWARE CHARTS ──
              const DARK_THEMES = ${JSON.stringify(DASHBOARD_THEMES.filter(theme => theme.dark).map(theme => theme.id))};
              const THEME_CHART_PALETTES = {
                  light: ['#2563eb', '#16a34a', '#dc2626', '#d97706', '#7c3aed', '#0891b2'],
                  dark: ['#e8a34c', '#60a5fa', '#34d399', '#f87171', '#c084fc', '#fbbf24'],
                  zen: ['#a8823c', '#6f7f52', '#a8583c', '#76628a', '#4f7f78', '#c09a58'],
                  vault: ['#3dfc6e', '#31c9ff', '#ff5c47', '#f5e642', '#bd67ff', '#42f5d1'],
                  candy: ['#e8467c', '#17b8a6', '#8a2f7a', '#f2a93b', '#7d70e8', '#ef6cb5']
              };
              function currentTheme() {
                  return document.documentElement.getAttribute('data-theme') || 'light';
              }
              function currentChartPalette() {
                  return THEME_CHART_PALETTES[currentTheme()] || THEME_CHART_PALETTES.light;
              }
              function isDarkTheme() {
                  // Charts only need to know light-vs-dark contrast, not the exact palette.
                  return DARK_THEMES.indexOf(currentTheme()) !== -1;
              }
              function applyChartDefaults() {
                  // Reuse the CSS theme token so chart text always matches the page.
                  Chart.defaults.color = getComputedStyle(document.documentElement).getPropertyValue('--text').trim();
                  Chart.defaults.borderColor = isDarkTheme() ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.1)';
              }
              // Set defaults before charts are created so the first render matches the theme.
              applyChartDefaults();
              const themedChartIds = ['hourlyChart', 'trendChart', 'failureChart', 'weeklyEventsChart', 'dauTrendChart', 'onboardingFunnelChart', 'intentChart'];
              function restyleCharts() {
                  applyChartDefaults();
                  const palette = currentChartPalette();
                  themedChartIds.forEach(function (id) {
                      const c = Chart.getChart(id);
                      if (!c) return;
                      c.data.datasets.forEach(function (dataset, datasetIndex) {
                          const color = palette[datasetIndex % palette.length];
                          dataset.borderColor = color;
                          dataset.backgroundColor = Array.isArray(dataset.backgroundColor)
                              ? dataset.data.map(function (_, pointIndex) { return palette[pointIndex % palette.length]; })
                              : (dataset.fill ? color + '26' : color);
                      });
                      c.update();
                  });
                  initIndiaMap();
              }

              // ── 3D INDIA MAP (ECharts GL) ──
              const GEO_DATA = ${geoDistributionJson};
              let indiaMapChart = null;
              let indiaMapRegistered = false;

              function initIndiaMap() {
                  const el = document.getElementById('indiaMap');
                  if (!el || !window.echarts || !indiaMapRegistered) return;
                  if (indiaMapChart) { indiaMapChart.dispose(); indiaMapChart = null; }

                  const styles = getComputedStyle(document.documentElement);
                  const surface = styles.getPropertyValue('--surface').trim();
                  const surfaceAlt = styles.getPropertyValue('--surface-alt').trim();
                  const borderColor = styles.getPropertyValue('--border').trim();
                  const textColor = styles.getPropertyValue('--text').trim();
                  const accentColor = styles.getPropertyValue('--accent').trim();
                  const mapFill = styles.getPropertyValue('--th-bg').trim();
                  const palette = currentChartPalette();
                  const maxUsers = Math.max(1, ...GEO_DATA.circles.map(c => c.users));
                  const barData = GEO_DATA.circles.map(c => ({
                      name: c.name,
                      value: [c.coord[0], c.coord[1], c.users],
                      messages: c.messages
                  }));

                  indiaMapChart = echarts.init(el);
                  indiaMapChart.setOption({
                      tooltip: {
                          backgroundColor: surfaceAlt,
                          borderColor: borderColor,
                          textStyle: { color: textColor }
                      },
                      visualMap: {
                          show: false,
                          min: 0,
                          max: maxUsers,
                          dimension: 2,
                          seriesIndex: 0,
                          inRange: {
                              color: palette
                          }
                      },
                      geo3D: {
                          map: 'india',
                          shading: 'lambert',
                          environment: surface,
                          itemStyle: {
                              color: mapFill,
                              borderWidth: 0.6,
                              borderColor: accentColor
                          },
                          emphasis: {
                              itemStyle: { color: palette[0] },
                              label: { show: false }
                          },
                          regionHeight: 1.2,
                          boxHeight: 22,
                          light: {
                              main: { intensity: 1.1, shadow: true, shadowQuality: 'medium', alpha: 55 },
                              ambient: { intensity: 0.35 }
                          },
                          viewControl: {
                              autoRotate: true,
                              autoRotateSpeed: 4,
                              autoRotateAfterStill: 4,
                              distance: 72,
                              alpha: 42,
                              beta: 0,
                              minAlpha: 15,
                              minDistance: 40,
                              maxDistance: 200,
                              panSensitivity: 1,
                              rotateSensitivity: 1.5
                          }
                      },
                      series: [{
                          type: 'bar3D',
                          coordinateSystem: 'geo3D',
                          shading: 'lambert',
                          barSize: 1.6,
                          minHeight: 2,
                          bevelSize: 0.4,
                          data: barData,
                          label: { show: false },
                          emphasis: {
                              label: {
                                  show: true,
                                  backgroundColor: surfaceAlt,
                                  color: textColor,
                                  padding: 6,
                                  borderRadius: 4,
                                  formatter: function (p) {
                                      return p.name + '\\n' + p.value[2] + ' users · ' + p.data.messages + ' msgs';
                                  }
                              }
                          }
                      }]
                  });
              }

              fetch('/admin/geo/india-states.json')
                  .then(function (r) { return r.json(); })
                  .then(function (geo) {
                      echarts.registerMap('india', geo);
                      indiaMapRegistered = true;
                      initIndiaMap();
                  })
                  .catch(function (e) {
                      const el = document.getElementById('indiaMap');
                      if (el) el.innerHTML = '<p class="geo-caption">Could not load India map data.</p>';
                      console.error('India map load failed:', e);
                  });

              window.addEventListener('resize', function () {
                  if (indiaMapChart) indiaMapChart.resize();
              });

              // Footnote: top circles + international + unmapped counts
              (function () {
                  const el = document.getElementById('geoFootnote');
                  if (!el) return;
                  const parts = [];
                  const top = GEO_DATA.circles.slice(0, 3).map(function (c) { return c.name + ' (' + c.users + ')'; });
                  if (top.length) parts.push('Top circles: ' + top.join(' · '));
                  if (GEO_DATA.international.length) {
                      parts.push('Outside India: ' + GEO_DATA.international.map(function (i) { return i.country + ' (' + i.users + ')'; }).join(' · '));
                  }
                  if (GEO_DATA.unmappedIndia) parts.push(GEO_DATA.unmappedIndia + ' Indian numbers with unmapped prefixes');
                  el.textContent = parts.join('  |  ');
              })();

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
                      labels: ${failureByTemplateLabels},
                      datasets: ${failureByTemplateDatasets}
                  },
                  options: {
                      responsive: true,
                      plugins: {
                          tooltip: { mode: 'index' },
                          legend: { position: 'bottom' }
                      },
                      scales: {
                          x: { stacked: true },
                          y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1 } }
                      }
                  }
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

              // Replace the fallback dataset colors with the active theme palette.
              restyleCharts();

              // ── THEME PICKER ──
              (function () {
                  const select = document.getElementById('themeSelect');
                  select.value = currentTheme();
                  select.addEventListener('change', function () {
                      const next = select.value;
                      document.documentElement.setAttribute('data-theme', next);
                      try { localStorage.setItem('dashboard-theme', next); } catch (e) {}
                      restyleCharts();
                  });
              })();
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
  // Start daily reminder scheduler (day-of birthday/anniversary)
  startReminderScheduler();
  // Start day-before reminder scheduler (event_details_reminder_2 at 9 AM the day before)
  startDayBeforeReminderScheduler();
  // Start daily upcoming reminder scheduler
  startDailyUpcomingReminderScheduler();
  // Start new-user follow-up scheduler (8 PM nudge within 24h of signup)
  startNewUserFollowupScheduler();
  // Start onboarding nudge scheduler (5-min nudge for idle new users)
  startOnboardingNudgeScheduler();
  // Start daily AI summary scheduler (generates dashboard summary at 7 AM IST)
  startDailySummaryScheduler();
  // Persist monthly active-user counts so past months stay populated in the table
  startMonthlyActiveUsersScheduler();
});
