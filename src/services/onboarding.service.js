// Onboarding and welcome message service

const { userExists, onboardUser } = require('../../db.js');
const { safeRewrite, sendWhatsAppMessage } = require('./whatsapp.service');

const WELCOME_MESSAGE =
  "Hi! 👋 Welcome to the Birthday Bot 🎂\n" +
  "This is the easiest way to save birthdays so you never forget 😊\n\n" +
  "To save a birthday, just type:\n" +
  "Name, Date\n\n" +
  "Example:\n" +
  "Papa, 29 Aug\n" +
  "Tanni, 9 Feb\n\n" +
  "To see all birthdays, type:\n" +
  "Complete list\n\n" +
  "That's it 👍\n" +
  "Just send messages like normal WhatsApp. No buttons, no forms.";

// Check if user needs onboarding and send welcome if needed
async function handleOnboarding(phone) {
  const exists = await userExists(phone);
  if (!exists) {
    // New user: onboard them and send welcome message
    await onboardUser(phone);
    const reply = await safeRewrite(WELCOME_MESSAGE);
    await sendWhatsAppMessage(phone, reply);
    return true; // User was onboarded
  }
  return false; // Existing user
}

// Send help/welcome message
async function sendHelpMessage(phone) {
  const reply = await safeRewrite(WELCOME_MESSAGE);
  await sendWhatsAppMessage(phone, reply);
}

module.exports = {
  handleOnboarding,
  sendHelpMessage,
  WELCOME_MESSAGE
};

