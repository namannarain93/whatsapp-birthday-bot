const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REVIEWED_BIRTHDAY_FIXES,
  planReviewedBirthdayFix,
  applyReviewedBirthdayFixes
} = require('../src/db/reviewed-birthday-fixes');

function makePool(rows) {
  const data = rows.map(row => ({ ...row }));
  const sqlKind = sql => sql.replace(/\s+/g, ' ').trim().toUpperCase();

  return {
    data,
    query: async (sql, params = []) => {
      const kind = sqlKind(sql);
      if (kind === 'BEGIN' || kind === 'COMMIT' || kind === 'ROLLBACK') {
        return { rowCount: 0, rows: [] };
      }

      if (kind.startsWith('SELECT') && kind.includes('AND NAME = $2')) {
        const [phone, name, day, month, type] = params;
        const rowsFound = data.filter(row =>
          row.phone === phone &&
          row.name === name &&
          row.day === day &&
          row.month.toLowerCase() === String(month).toLowerCase() &&
          row.type === type
        );
        return { rowCount: rowsFound.length, rows: rowsFound.map(row => ({ ...row })) };
      }

      if (kind.startsWith('SELECT') && kind.includes('LOWER(NAME) = LOWER($2)')) {
        const [phone, name, day, month, type, id] = params;
        const rowsFound = data.filter(row =>
          row.phone === phone &&
          row.name.toLowerCase() === String(name).toLowerCase() &&
          row.day === day &&
          row.month.toLowerCase() === String(month).toLowerCase() &&
          row.type === type &&
          row.id !== id
        );
        return { rowCount: rowsFound.length, rows: rowsFound.map(row => ({ ...row })) };
      }

      if (kind.startsWith('UPDATE BIRTHDAYS SET NAME = $2')) {
        const [id, name, year, relationship, type] = params;
        const row = data.find(item => item.id === id);
        if (!row) return { rowCount: 0, rows: [] };
        row.name = name;
        row.year = year;
        row.relationship = relationship;
        if (type != null) row.type = type;
        return { rowCount: 1, rows: [{ ...row }] };
      }

      if (kind.startsWith('UPDATE BIRTHDAYS SET YEAR = $2')) {
        const [id, year, relationship, type] = params;
        const row = data.find(item => item.id === id);
        if (!row) return { rowCount: 0, rows: [] };
        row.year = year;
        row.relationship = relationship;
        if (type != null) row.type = type;
        return { rowCount: 1, rows: [{ ...row }] };
      }

      if (kind.startsWith('DELETE FROM BIRTHDAYS')) {
        const [id] = params;
        const index = data.findIndex(item => item.id === id);
        if (index === -1) return { rowCount: 0, rows: [] };
        data.splice(index, 1);
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

test('reviewed fixes cover year/relationship splits and known bad saves', () => {
  assert.deepEqual(
    REVIEWED_BIRTHDAY_FIXES.map(fix => [
      fix.action || 'update',
      fix.currentName,
      fix.name || null,
      fix.relationship || null,
      fix.year || null,
      fix.newType || null
    ]),
    [
      ['update', 'Brindha Sister 1989', 'Brindha', 'Sister', 1989, null],
      ['update', 'Mohan appa / dad', 'Mohan appa', 'dad', null, null],
      ['update', 'Malathi Amma / mom 1967', 'Malathi Amma', 'mom', 1967, null],
      ['update', 'Shreyas 1995', 'Shreyas', null, 1995, null],
      ['update', 'Krithika wife', 'Krithika', 'wife', 1997, null],
      ['update', 'Shivans', 'Shivani', null, null, null],
      ['update', 'Kamal is', 'Kamal', null, null, null],
      ['delete', 'Remove "Kamal "', null, null, null, null],
      ['delete', 'Kamal', null, null, null, null],
      ['update', 'Maithili Nayak - -2000', 'Maithili Nayak', null, 2000, null],
      ['update', 'Anniversary RishiTris', 'RishiTris', null, null, 'anniversary'],
      ['update', 'Anniversary UttAnu', 'UttAnu', null, null, 'anniversary']
    ]
  );
});

test('plan updates a unique row and merges a duplicate Shreyas', () => {
  assert.deepEqual(
    planReviewedBirthdayFix(
      REVIEWED_BIRTHDAY_FIXES[0],
      { id: 5, year: null, relationship: null },
      null
    ),
    {
      action: 'update',
      id: 5,
      name: 'Brindha',
      year: 1989,
      relationship: 'Sister',
      type: 'birthday'
    }
  );

  assert.deepEqual(
    planReviewedBirthdayFix(
      REVIEWED_BIRTHDAY_FIXES[3],
      { id: 8, year: null, relationship: null },
      { id: 10, year: null, relationship: null }
    ),
    {
      action: 'merge',
      survivorId: 10,
      deleteId: 8,
      year: 1995,
      relationship: null,
      type: 'birthday'
    }
  );

  assert.deepEqual(
    planReviewedBirthdayFix(REVIEWED_BIRTHDAY_FIXES[0], null, null),
    { action: 'skip' }
  );

  const deleteFix = REVIEWED_BIRTHDAY_FIXES.find(fix => fix.action === 'delete');
  assert.deepEqual(
    planReviewedBirthdayFix(deleteFix, { id: 10 }, null),
    { action: 'delete', id: 10 }
  );
});

test('apply writes columns, merges Shreyas, and is idempotent', async () => {
  const pool = makePool([
    { id: 5, phone: '918754443260', name: 'Brindha Sister 1989', day: 19, month: 'Jun', type: 'birthday', year: null, relationship: null },
    { id: 6, phone: '918754443260', name: 'Mohan appa / dad', day: 7, month: 'Oct', type: 'birthday', year: null, relationship: null },
    { id: 7, phone: '918754443260', name: 'Malathi Amma / mom 1967', day: 27, month: 'May', type: 'birthday', year: null, relationship: null },
    { id: 8, phone: '918754443260', name: 'Shreyas 1995', day: 22, month: 'Aug', type: 'birthday', year: null, relationship: null },
    { id: 9, phone: '918754443260', name: 'Krithika wife', day: 27, month: 'Dec', type: 'birthday', year: null, relationship: null },
    { id: 10, phone: '918754443260', name: 'Shreyas', day: 22, month: 'Aug', type: 'birthday', year: null, relationship: null }
  ]);

  const first = await applyReviewedBirthdayFixes(pool);
  assert.deepEqual(first, { updated: 4, merged: 1, deleted: 0, skipped: 7 });
  assert.deepEqual(
    pool.data.map(row => [row.name, row.relationship, row.year]).sort(),
    [
      ['Brindha', 'Sister', 1989],
      ['Krithika', 'wife', 1997],
      ['Malathi Amma', 'mom', 1967],
      ['Mohan appa', 'dad', null],
      ['Shreyas', null, 1995]
    ]
  );

  const second = await applyReviewedBirthdayFixes(pool);
  assert.deepEqual(second, { updated: 0, merged: 0, deleted: 0, skipped: 12 });
  assert.equal(pool.data.length, 5);
});

test('apply merges Shivani and repairs the Kamal edit leftovers', async () => {
  const pool = makePool([
    { id: 8, phone: '918369321103', name: 'Shivani', day: 10, month: 'Aug', type: 'birthday', year: null, relationship: null },
    { id: 9, phone: '918369321103', name: 'Shivans', day: 10, month: 'Aug', type: 'birthday', year: null, relationship: null },
    { id: 10, phone: '919167229363', name: 'Remove "Kamal "', day: 5, month: 'Aug', type: 'birthday', year: null, relationship: null },
    { id: 11, phone: '919167229363', name: 'Kamal is', day: 6, month: 'Aug', type: 'birthday', year: null, relationship: null },
    { id: 20, phone: '919167229363', name: 'Kamal', day: 5, month: 'Aug', type: 'birthday', year: null, relationship: null }
  ]);

  const first = await applyReviewedBirthdayFixes(pool);
  assert.deepEqual(first, { updated: 1, merged: 1, deleted: 2, skipped: 8 });
  assert.deepEqual(
    pool.data
      .map(row => [row.phone, row.name, row.day, row.month])
      .sort(),
    [
      ['918369321103', 'Shivani', 10, 'Aug'],
      ['919167229363', 'Kamal', 6, 'Aug']
    ]
  );

  const second = await applyReviewedBirthdayFixes(pool);
  assert.deepEqual(second, { updated: 0, merged: 0, deleted: 0, skipped: 12 });
});

test('apply moves Maithili year and retags anniversary names', async () => {
  const pool = makePool([
    { id: 1, phone: '918369321103', name: 'Maithili Nayak - -2000', day: 24, month: 'Jan', type: 'birthday', year: null, relationship: null },
    { id: 2, phone: '919769169062', name: 'Anniversary RishiTris', day: 3, month: 'Feb', type: 'birthday', year: null, relationship: null },
    { id: 3, phone: '919769169062', name: 'Anniversary UttAnu', day: 5, month: 'Feb', type: 'birthday', year: null, relationship: null }
  ]);

  const first = await applyReviewedBirthdayFixes(pool);
  assert.deepEqual(first, { updated: 3, merged: 0, deleted: 0, skipped: 9 });
  assert.deepEqual(
    pool.data
      .map(row => [row.name, row.year, row.type, row.day])
      .sort(),
    [
      ['Maithili Nayak', 2000, 'birthday', 24],
      ['RishiTris', null, 'anniversary', 3],
      ['UttAnu', null, 'anniversary', 5]
    ]
  );

  const second = await applyReviewedBirthdayFixes(pool);
  assert.deepEqual(second, { updated: 0, merged: 0, deleted: 0, skipped: 12 });
});
