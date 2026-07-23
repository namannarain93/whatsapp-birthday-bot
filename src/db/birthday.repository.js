const { pool } = require('./pool');

// Save birthday
async function saveBirthday(phone, name, day, month, type = 'birthday') {
  await pool.query(
    `INSERT INTO birthdays (phone, name, day, month, type)
     VALUES ($1, $2, $3, $4, $5)`,
    [phone, name, day, month, type]
  );
}

// Check duplicate
async function birthdayExists(phone, name, day, month, type = 'birthday') {
  const res = await pool.query(
    `
    SELECT 1 FROM birthdays
    WHERE phone = $1
      AND LOWER(name) = LOWER($2)
      AND day = $3
      AND LOWER(month) = LOWER($4)
      AND type = $5
    `,
    [phone, name, day, month, type]
  );
  return res.rowCount > 0;
}

// Get birthdays for a month (per user)
async function getBirthdaysForMonth(phone, month) {
  const res = await pool.query(
    `
    SELECT name, day, month, type
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
    SELECT name, day, month, type
    FROM birthdays
    WHERE phone = $1
    ORDER BY month, day
    `,
    [phone]
  );
  return res.rows;
}

// Get birthdays for a specific day and month (for reminders)
async function getBirthdaysForDate(phone, day, month) {
  const res = await pool.query(
    `
    SELECT name, day, month, type
    FROM birthdays
    WHERE phone = $1 AND day = $2 AND LOWER(month) = LOWER($3)
    ORDER BY name
    `,
    [phone, day, month]
  );
  return res.rows;
}

// Get birthdays for a specific day/month for the day-of reminder, EXCLUDING any
// event that was added today (in the user's timezone). If a user just saved an
// event that falls on today, they already know about it, so a same-day reminder
// is redundant. created_at is stored as a UTC wall-clock timestamp.
async function getBirthdaysForReminder(phone, day, month, timezone, todayDate) {
  const res = await pool.query(
    `
    SELECT name, day, month, type
    FROM birthdays
    WHERE phone = $1 AND day = $2 AND LOWER(month) = LOWER($3)
      AND (
        created_at IS NULL
        OR to_char((created_at AT TIME ZONE 'UTC') AT TIME ZONE $4, 'YYYY-MM-DD') <> $5
      )
    ORDER BY name
    `,
    [phone, day, month, timezone, todayDate]
  );
  return res.rows;
}

// Get birthday by name (case-insensitive, partial match)
async function getBirthdayByName(phone, name) {
  const res = await pool.query(
    `
    SELECT name, day, month, type
    FROM birthdays
    WHERE phone = $1 AND LOWER(name) LIKE LOWER('%' || $2 || '%')
    ORDER BY name
    LIMIT 10
    `,
    [phone, name]
  );
  return res.rows;
}

// Get birthdays by date (day and month)
async function getBirthdaysByDate(phone, day, month) {
  const res = await pool.query(
    `
    SELECT name, day, month, type
    FROM birthdays
    WHERE phone = $1 AND day = $2 AND LOWER(month) = LOWER($3)
    ORDER BY name
    `,
    [phone, day, month]
  );
  return res.rows;
}

// Get upcoming birthdays within a date range (handles year wrap)
async function getUpcomingBirthdays(phone, fromDay, fromMonth, toDay, toMonth) {
  // Map month names to numbers for comparison
  const monthToNum = {
    'Jan': 1, 'Feb': 2, 'Mar': 3, 'Apr': 4, 'May': 5, 'Jun': 6,
    'Jul': 7, 'Aug': 8, 'Sep': 9, 'Oct': 10, 'Nov': 11, 'Dec': 12
  };
  
  const fromMonthNum = monthToNum[fromMonth] || 0;
  const toMonthNum = monthToNum[toMonth] || 0;
  
  // Get all birthdays for this user
  const allBirthdays = await pool.query(
    `
    SELECT name, day, month, type
    FROM birthdays
    WHERE phone = $1
    ORDER BY month, day
    `,
    [phone]
  );
  
  // Helper function to compare dates (month, day) for sorting
  function dateValue(monthNum, day) {
    return monthNum * 100 + day;
  }
  
  const fromValue = dateValue(fromMonthNum, fromDay);
  const toValue = dateValue(toMonthNum, toDay);
  
  // Filter birthdays within the range (handling year wrap)
  const upcoming = [];
  for (const b of allBirthdays.rows) {
    const bMonthNum = monthToNum[b.month] || 0;
    const bDay = b.day;
    const bValue = dateValue(bMonthNum, bDay);
    
    let inRange = false;
    
    if (fromMonthNum <= toMonthNum) {
      // Normal case: same year (e.g., Feb 1 to Mar 15)
      inRange = bValue >= fromValue && bValue <= toValue;
    } else {
      // Year wrap case: crosses year boundary (e.g., Dec 1 to Jan 15)
      // Birthday is in range if it's >= fromDate OR <= toDate
      inRange = bValue >= fromValue || bValue <= toValue;
    }
    
    if (inRange) {
      upcoming.push(b);
    }
  }
  
  // Sort by nearest date first (considering year wrap)
  upcoming.sort((a, b) => {
    const aValue = dateValue(monthToNum[a.month] || 0, a.day);
    const bValue = dateValue(monthToNum[b.month] || 0, b.day);
    
    // If we're in a year wrap scenario, adjust values for comparison
    if (fromMonthNum > toMonthNum) {
      const aAdjusted = aValue < fromValue ? aValue + 1200 : aValue;
      const bAdjusted = bValue < fromValue ? bValue + 1200 : bValue;
      return aAdjusted - bAdjusted;
    }
    return aValue - bValue;
  });
  
  return upcoming;
}

// Delete birthday
// Supports both exact match and fuzzy/partial match for corrupted names
async function deleteBirthday(phone, name, type = null) {
  let query = 'DELETE FROM birthdays WHERE phone = $1 AND LOWER(name) = LOWER($2)';
  let params = [phone, name];

  if (type) {
    query += ' AND type = $3';
    params.push(type);
  }

  // First try exact match (case-insensitive)
  const exactRes = await pool.query(query, params);
  
  if (exactRes.rowCount > 0) {
    console.log(`[DELETE] Exact match deleted ${exactRes.rowCount} row(s) for phone=${phone}, name="${name}", type="${type || 'any'}"`);
    return true;
  }
  
  // If exact match failed, try fuzzy/partial match
  let fuzzyQuery = 'DELETE FROM birthdays WHERE phone = $1 AND LOWER(name) LIKE LOWER(\'%\' || $2 || \'%\')';
  let fuzzyParams = [phone, name];

  if (type) {
    fuzzyQuery += ' AND type = $3';
    fuzzyParams.push(type);
  }

  const fuzzyRes = await pool.query(fuzzyQuery, fuzzyParams);
  
  if (fuzzyRes.rowCount > 0) {
    console.log(`[DELETE] Fuzzy match deleted ${fuzzyRes.rowCount} row(s) for phone=${phone}, name="${name}", type="${type || 'any'}"`);
    return true;
  }
  
  console.log(`[DELETE] No match found for phone=${phone}, name="${name}", type="${type || 'any'}"`);
  return false;
}

// Verify birthday exists (for post-delete verification)
async function birthdayExistsByName(phone, name, type = null) {
  let query = 'SELECT 1 FROM birthdays WHERE phone = $1 AND LOWER(name) = LOWER($2)';
  let params = [phone, name];

  if (type) {
    query += ' AND type = $3';
    params.push(type);
  }

  query += ' LIMIT 1';

  const res = await pool.query(query, params);
  return res.rowCount > 0;
}

// Update birthday
async function updateBirthday(phone, name, day, month, type = 'birthday') {
  await pool.query(
    `
    UPDATE birthdays
    SET day = $3, month = $4, type = $5
    WHERE phone = $1 AND LOWER(name) = LOWER($2)
    `,
    [phone, name, day, month, type]
  );
}

// Update birthday name (rename)
async function updateBirthdayName(phone, oldName, newName, type = null) {
  let query = 'UPDATE birthdays SET name = $3 WHERE phone = $1 AND LOWER(name) = LOWER($2)';
  let params = [phone, oldName, newName];

  if (type) {
    query += ' AND type = $4';
    params.push(type);
  }

  const res = await pool.query(query, params);
  return res.rowCount > 0;
}

module.exports = {
  saveBirthday,
  birthdayExists,
  getBirthdaysForMonth,
  getAllBirthdays,
  getBirthdaysForDate,
  getBirthdaysForReminder,
  getBirthdayByName,
  getBirthdaysByDate,
  getUpcomingBirthdays,
  deleteBirthday,
  birthdayExistsByName,
  updateBirthday,
  updateBirthdayName,
};
