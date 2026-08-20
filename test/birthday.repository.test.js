const test = require('node:test');
const assert = require('node:assert/strict');

test('detail backfill is scoped to the exact event', async () => {
  const calls = [];
  const poolPath = require.resolve('../src/db/pool');
  require.cache[poolPath] = {
    id: poolPath,
    filename: poolPath,
    loaded: true,
    exports: {
      pool: {
        query: async (sql, params) => {
          calls.push({ sql, params });
          return { rowCount: 1, rows: [] };
        }
      }
    }
  };

  const repositoryPath = require.resolve('../src/db/birthday.repository');
  delete require.cache[repositoryPath];
  const { updateBirthdayDetails } = require(repositoryPath);

  const updated = await updateBirthdayDetails(
    '911234567890',
    'Shreyas',
    22,
    'Aug',
    'birthday',
    { year: 1995, relationship: 'brother' }
  );

  assert.equal(updated, true);
  assert.match(calls[0].sql, /day = \$3/);
  assert.match(calls[0].sql, /LOWER\(month\) = LOWER\(\$4\)/);
  assert.match(calls[0].sql, /type = \$5/);
  assert.deepEqual(calls[0].params, [
    '911234567890',
    'Shreyas',
    22,
    'Aug',
    'birthday',
    1995,
    'brother'
  ]);
});
