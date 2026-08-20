const { Pool } = require('pg');

// Hosted databases (Render, Heroku, Neon, etc.) usually require SSL.
// Local Postgres typically does not, and forcing SSL produces:
// "The server does not support SSL connections".
function sslConfig() {
  const url = process.env.DATABASE_URL || '';
  if (!url) return false;

  try {
    const parsed = new URL(url);
    const sslmode = (parsed.searchParams.get('sslmode') || '').toLowerCase();
    if (sslmode === 'disable') return false;

    const host = parsed.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return false;
  } catch (_) {
    return false;
  }

  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig()
});

module.exports = { pool };
