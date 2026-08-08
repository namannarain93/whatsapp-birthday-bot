// LLM intent parsing wrapper

const { parseIntentWithLLM } = require('../../llm.js');

async function parseIntent(message, options = {}) {
  return await parseIntentWithLLM(message, options);
}

module.exports = {
  parseIntent
};

