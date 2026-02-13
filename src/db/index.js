const { pool } = require('./pool');
const { dbReady } = require('./migrations');
const birthdayRepo = require('./birthday.repository');
const userRepo = require('./user.repository');
const reminderRepo = require('./reminder.repository');
const messageRepo = require('./message.repository');
const onboardingRepo = require('./onboarding.repository');

module.exports = {
  pool,
  dbReady,
  ...birthdayRepo,
  ...userRepo,
  ...reminderRepo,
  ...messageRepo,
  ...onboardingRepo,
};
