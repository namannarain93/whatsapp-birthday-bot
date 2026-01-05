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

function getBirthdaysForMonth(month, callback) {
  db.all(
    'SELECT * FROM birthdays WHERE LOWER(month) = LOWER(?) OR LOWER(month) LIKE LOWER(?) ORDER BY day',
    [month, month + '%'],
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
function getAllBirthdays(callback) {
  db.all(
    "SELECT name, day, month FROM birthdays ORDER BY month, day",
    callback
  );
}

module.exports = {
  saveBirthday,
  getBirthdaysForMonth,
  getAllBirthdays
};
