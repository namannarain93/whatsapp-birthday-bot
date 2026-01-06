const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Create table on startup
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS birthdays (
        id SERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        name TEXT NOT NULL,
        day INTEGER NOT NULL,
        month TEXT NOT NULL,
        UNIQUE (phone, name, day, month)
      );
    `);    
    console.log('Birthdays table ready (Postgres)');
  } catch (err) {
    console.error('Error creating table:', err);
  }
})();

// Save birthday
async function saveBirthday(phone, name, day, month) {
  await pool.query(
    `INSERT INTO birthdays (phone, name, day, month)
     VALUES ($1, $2, $3, $4)`,
    [phone, name, day, month]
  );
}

// Check duplicate
async function birthdayExists(phone, name, day, month) {
  const res = await pool.query(
    `
    SELECT 1 FROM birthdays
    WHERE phone = $1
      AND LOWER(name) = LOWER($2)
      AND day = $3
      AND LOWER(month) = LOWER($4)
    `,
    [phone, name, day, month]
  );
  return res.rowCount > 0;
}

// Get birthdays for a month (per user)
async function getBirthdaysForMonth(phone, month) {
  const res = await pool.query(
    `
    SELECT name, day, month
    FROM birthdays
    WHERE phone = $1
      AND (LOWER(month) = LOWER($2) OR LOWER(month) LIKE LOWER($3))
    ORDER BY day
    `,
    [phone, month, `${month}%`]
  );
  return res.rows;
}

// Get all birthdays (per user)
async function getAllBirthdays(phone) {
  const res = await pool.query(
    `
    SELECT name, day, month
    FROM birthdays
    WHERE phone = $1
    ORDER BY month, day
    `,
    [phone]
  );
  return res.rows;
}

// Delete birthday
async function deleteBirthday(phone, name) {
  const res = await pool.query(
    `
    DELETE FROM birthdays
    WHERE phone = $1 AND LOWER(name) = LOWER($2)
    `,
    [phone, name]
  );
  return res.rowCount > 0;
}

// Verify birthday exists (for post-delete verification)
async function birthdayExistsByName(phone, name) {
  const res = await pool.query(
    `
    SELECT 1 FROM birthdays
    WHERE phone = $1 AND LOWER(name) = LOWER($2)
    LIMIT 1
    `,
    [phone, name]
  );
  return res.rowCount > 0;
}

// Update birthday
async function updateBirthday(phone, name, day, month) {
  await pool.query(
    `
    UPDATE birthdays
    SET day = $3, month = $4
    WHERE phone = $1 AND LOWER(name) = LOWER($2)
    `,
    [phone, name, day, month]
  );
}

// Update birthday name (rename)
async function updateBirthdayName(phone, oldName, newName) {
  const res = await pool.query(
    `
    UPDATE birthdays
    SET name = $3
    WHERE phone = $1 AND LOWER(name) = LOWER($2)
    `,
    [phone, oldName, newName]
  );
  return res.rowCount > 0;
}

// Check if this is the first time a phone number is using the bot
async function isFirstTimeUser(phone) {
  const res = await pool.query(
    `
    SELECT 1 FROM birthdays
    WHERE phone = $1
    LIMIT 1
    `,
    [phone]
  );
  // First time user if no rows exist for this phone
  return res.rowCount === 0;
}

module.exports = {
  saveBirthday,
  birthdayExists,
  birthdayExistsByName,
  getBirthdaysForMonth,
  getAllBirthdays,
  deleteBirthday,
  updateBirthday,
  updateBirthdayName,
  isFirstTimeUser
};