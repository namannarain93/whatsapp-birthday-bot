const test = require('node:test');
const assert = require('node:assert/strict');

const poolPath = require.resolve('../src/db/pool');
require.cache[poolPath] = {
  id: poolPath,
  filename: poolPath,
  loaded: true,
  exports: { pool: {} }
};

const {
  proposeCandidate,
  validateApproval
} = require('../scripts/cleanup-corrupted-names');

const baseRow = {
  id: 1,
  phone: '911234567890',
  day: 22,
  month: 'Aug',
  type: 'birthday',
  year: null,
  relationship: null
};

test('cleanup report proposes recognized legacy details without applying them', () => {
  const { year, relationship, ...expectedBase } = baseRow;
  assert.deepEqual(
    proposeCandidate({ ...baseRow, name: 'Malathi Amma / Mom 1967' }),
    {
      ...expectedBase,
      originalName: 'Malathi Amma / Mom 1967',
      currentYear: null,
      currentRelationship: null,
      proposedName: 'Malathi Amma',
      proposedYear: 1967,
      proposedRelationship: 'Mom',
      requiresApproval: true
    }
  );
});

test('cleanup report does not reinterpret arbitrary slashes', () => {
  assert.equal(proposeCandidate({ ...baseRow, name: 'AC/DC' }), null);
});

test('approval validation requires explicit reviewed values and merge target', () => {
  assert.throws(
    () => validateApproval({
      id: 1,
      expectedName: 'Shreyas 1995',
      action: 'update',
      name: 'Shreyas'
    }),
    /explicitly include year and relationship/
  );

  assert.throws(
    () => validateApproval({
      id: 1,
      expectedName: 'Shreyas 1995',
      action: 'merge',
      name: 'Shreyas',
      year: 1995,
      relationship: null
    }),
    /survivorId/
  );
});
