const test = require('node:test');
const assert = require('node:assert/strict');

const openAIPath = require.resolve('openai');
require.cache[openAIPath] = {
  id: openAIPath,
  filename: openAIPath,
  loaded: true,
  exports: class OpenAI {
    constructor() {}
  }
};

const { normalizeLLMAction } = require('../llm');

test('keeps only years and recognized relationships explicit in the message', () => {
  const explicit = normalizeLLMAction(
    {
      intent: 'save',
      name: 'Krithika',
      day: 27,
      month: 'Dec',
      year: 1990,
      relationship: 'wife'
    },
    'Krithika wife 27 Dec 1990'
  );
  assert.equal(explicit.year, 1990);
  assert.equal(explicit.relationship, 'wife');

  const invented = normalizeLLMAction(
    {
      intent: 'save',
      name: 'Krithika',
      day: 27,
      month: 'Dec',
      year: 1990,
      relationship: 'wife'
    },
    'Krithika 27 Dec'
  );
  assert.equal(invented.year, null);
  assert.equal(invented.relationship, null);
});

test('rejects arbitrary relationship labels even when the LLM emits them', () => {
  const action = normalizeLLMAction(
    {
      intent: 'save',
      name: 'Ravi',
      day: 5,
      month: 'Aug',
      relationship: 'accountant'
    },
    'Ravi accountant 5 Aug'
  );
  assert.equal(action.relationship, null);
});
