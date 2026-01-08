// Onboarding and welcome message service

const { userExists, onboardUser } = require('../../db.js');
const { safeRewrite, sendWhatsAppMessage } = require('./whatsapp.service');

const WELCOME_MESSAGE =
  "Hi! 👋 Welcome to the *Birthday Bot* 🎂\n\n" +
  "This is an early version of a WhatsApp bot that helps you save birthdays, so please be kind and patient. 😊\n\n" +
  "To save a birthday, just type (example):\n" +
  " → *Papa, 29 Aug*\n" +
  " → *Mom, 9 Feb*\n\n" +
  "To search ordelete a birthday, just type:\n" +
  " → *search Papa*\n" +
  " → *delete Mom*\n\n" +
  "To see all birthdays, type:\n" +
  " → *Complete list*\n\n" +
  "That's it 👍\n" +
  "Just send messages like normal WhatsApp. No buttons, no forms.";

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

