// Webhook route handlers

const express = require('express');
const router = express.Router();
const { handleIncomingMessage } = require('../controllers/message.controller');

// GET webhook verification
router.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = 'birthday_reminder_verify';

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
});

// POST webhook handler
router.post('/webhook', handleIncomingMessage);

module.exports = router;

