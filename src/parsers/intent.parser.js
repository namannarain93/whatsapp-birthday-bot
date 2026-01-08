// LLM intent parsing wrapper

const { parseIntentWithLLM } = require('../../llm.js');

async function parseIntent(message) {
  return await parseIntentWithLLM(message);
}

module.exports = {
  parseIntent
};

