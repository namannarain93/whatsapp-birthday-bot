const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('birthdays.db', (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to birthdays database');
  }
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS birthdays (
    phone TEXT,
    name TEXT,
    day INTEGER,
    month TEXT
  )`, (err) => {
    if (err) {
      console.error('Error creating table:', err);
    } else {
      console.log('Birthdays table ready');
    }
  });
});

function saveBirthday(phone, name, day, month) {
  db.run(
    'INSERT INTO birthdays (phone, name, day, month) VALUES (?, ?, ?, ?)',
    [phone, name, day, month],
    (err) => {
      if (err) {
        console.error('Error saving birthday:', err);
      } else {
        console.log(`Saved birthday: ${name} - ${month} ${day}`);
      }
    }
  );
}

function getBirthdaysForMonth(phone, month, callback) {
  db.all(
    'SELECT * FROM birthdays WHERE phone = ? AND (LOWER(month) = LOWER(?) OR LOWER(month) LIKE LOWER(?)) ORDER BY day',
    [phone, month, month + '%'],
    (err, rows) => {
      if (err) {
        console.error('Error getting birthdays:', err);
        callback(err, null);
      } else {
        callback(null, rows);
      }
    }
  );
}
function getAllBirthdays(phone, callback) {
  db.all(
    "SELECT name, day, month FROM birthdays WHERE phone = ? ORDER BY month, day",
    [phone],
    callback
  );
}

function birthdayExists(phone, name, day, month, callback) {
  db.get(
    'SELECT * FROM birthdays WHERE phone = ? AND LOWER(name) = LOWER(?) AND day = ? AND LOWER(month) = LOWER(?)',
    [phone, name, day, month],
    (err, row) => {
      if (err) {
        console.error('Error checking birthday:', err);
        callback(err, null);
      } else {
        callback(null, row !== undefined);
      }
    }
  );
}

function deleteBirthday(phone, name, callback) {
  db.run(
    'DELETE FROM birthdays WHERE phone = ? AND LOWER(name) = LOWER(?)',
    [phone, name],
    function(err) {
      if (err) {
        console.error('Error deleting birthday:', err);
        callback(err, null);
      } else {
        callback(null, this.changes > 0);
      }
    }
  );
}

function updateBirthday(phone, name, day, month, callback) {
  db.run(
    'UPDATE birthdays SET day = ?, month = ? WHERE phone = ? AND LOWER(name) = LOWER(?)',
    [day, month, phone, name],
    function(err) {
      if (err) {
        console.error('Error updating birthday:', err);
        callback(err, null);
      } else {
        callback(null, this.changes > 0);
      }
    }
  );
}

module.exports = {
  saveBirthday,
  getBirthdaysForMonth,
  getAllBirthdays,
  birthdayExists,
  deleteBirthday,
  updateBirthday
};
