// Onboarding and welcome message service

const { userExists, onboardUser } = require('../../db.js');
const { safeRewrite, sendWhatsAppMessage } = require('./whatsapp.service');

const WELCOME_MESSAGE =
  "Hi! 👋 Welcome to the *Birthday and Anniversary Reminder* created by Naman 🎂💍\n\n" +
  "This is a new bot and still being tested. Responses may be slow and some things may not work as expected. Please leave a message at +91-8769010233, for any feedback.😊\n\n" +
  "To save a birthday, just type (example):\n" +
  " → *Papa 29 Aug*\n" +
  " → *Mom 9 Feb*\n\n" +
  "To search or delete a birthday, just type (example):\n" +
  " → *search papa*\n" +
  " → *delete mom*\n\n" +
  "To see all birthdays and anniversaries, type:\n" +
  " → *complete list*\n\n" +
  "In case you get stuck, type:\n" +
  " → *help*\n\n" +
  "That's it 👍\n\n" +
  " Never miss birthdays or anniversaries again. I've got you covered :)";

// Check if user needs onboarding and send welcome if needed
async function handleOnboarding(phone) {
  const exists = await userExists(phone);
  if (!exists) {
    // New user: onboard them and send welcome message
    await onboardUser(phone);
    // Skip LLM rewrite for welcome message - it's already properly formatted
    await sendWhatsAppMessage(phone, WELCOME_MESSAGE);
    return true; // User was onboarded
  }
  return false; // Existing user
}

// Send help/welcome message
async function sendHelpMessage(phone) {
  // Skip LLM rewrite for welcome message - it's already properly formatted
  await sendWhatsAppMessage(phone, WELCOME_MESSAGE);
}

module.exports = {
  handleOnboarding,
  sendHelpMessage,
  WELCOME_MESSAGE
};

