// One-shot, reviewed corrections for specific birthday rows. Matched by
// phone + current name + date so this is a no-op after the first successful
// run (no row IDs needed).
//
// Honorifics such as Amma/Appa stay in the name; only recognized relationship
// words and years are moved into their columns. Krithika's year comes from the
// original WhatsApp message "Krithika wife 27 12 1997". Command-like names
// (Shivans duplicate, "Remove Kamal") are merged or deleted. Anniversary
// labels that leaked into the name are moved onto type.

const REVIEWED_BIRTHDAY_FIXES = [
  {
    phone: '918754443260',
    currentName: 'Brindha Sister 1989',
    name: 'Brindha',
    year: 1989,
    relationship: 'Sister',
    day: 19,
    month: 'Jun',
    type: 'birthday'
  },
  {
    phone: '918754443260',
    currentName: 'Mohan appa / dad',
    name: 'Mohan appa',
    year: null,
    relationship: 'dad',
    day: 7,
    month: 'Oct',
    type: 'birthday'
  },
  {
    phone: '918754443260',
    currentName: 'Malathi Amma / mom 1967',
    name: 'Malathi Amma',
    year: 1967,
    relationship: 'mom',
    day: 27,
    month: 'May',
    type: 'birthday'
  },
  {
    phone: '918754443260',
    currentName: 'Shreyas 1995',
    name: 'Shreyas',
    year: 1995,
    relationship: null,
    day: 22,
    month: 'Aug',
    type: 'birthday'
  },
  {
    phone: '918754443260',
    currentName: 'Krithika wife',
    name: 'Krithika',
    year: 1997,
    relationship: 'wife',
    day: 27,
    month: 'Dec',
    type: 'birthday'
  },
  // "Shivani I mean" was saved as a second person instead of renaming Shivans.
  {
    phone: '918369321103',
    currentName: 'Shivans',
    name: 'Shivani',
    year: null,
    relationship: null,
    day: 10,
    month: 'Aug',
    type: 'birthday'
  },
  // Multiline edit "Kamal is 6 Aug" / "Remove Kamal 5 Aug" was saved as names.
  {
    phone: '919167229363',
    currentName: 'Kamal is',
    name: 'Kamal',
    year: null,
    relationship: null,
    day: 6,
    month: 'Aug',
    type: 'birthday'
  },
  {
    action: 'delete',
    phone: '919167229363',
    currentName: 'Remove "Kamal "',
    day: 5,
    month: 'Aug',
    type: 'birthday'
  },
  {
    action: 'delete',
    phone: '919167229363',
    currentName: 'Kamal',
    day: 5,
    month: 'Aug',
    type: 'birthday'
  },
  {
    phone: '918369321103',
    currentName: 'Maithili Nayak - -2000',
    name: 'Maithili Nayak',
    year: 2000,
    relationship: null,
    day: 24,
    month: 'Jan',
    type: 'birthday'
  },
  {
    phone: '919769169062',
    currentName: 'Anniversary RishiTris',
    name: 'RishiTris',
    year: null,
    relationship: null,
    day: 3,
    month: 'Feb',
    type: 'birthday',
    newType: 'anniversary'
  },
  {
    phone: '919769169062',
    currentName: 'Anniversary UttAnu',
    name: 'UttAnu',
    year: null,
    relationship: null,
    day: 5,
    month: 'Feb',
    type: 'birthday',
    newType: 'anniversary'
  }
];

function firstValue(preferred, ...fallbacks) {
  if (preferred != null) return preferred;
  for (const value of fallbacks) {
    if (value != null) return value;
  }
  return null;
}

function planReviewedBirthdayFix(fix, source, duplicate) {
  if (!source) return { action: 'skip' };
  if (fix.action === 'delete') {
    return { action: 'delete', id: source.id };
  }

  const name = fix.name.trim();
  const year = firstValue(fix.year, duplicate && duplicate.year, source.year);
  const relationship = firstValue(
    fix.relationship,
    duplicate && duplicate.relationship,
    source.relationship
  );
  const type = fix.newType || source.type || fix.type;

  if (duplicate) {
    return {
      action: 'merge',
      survivorId: duplicate.id,
      deleteId: source.id,
      year,
      relationship,
      type
    };
  }

  return {
    action: 'update',
    id: source.id,
    name,
    year,
    relationship,
    type
  };
}

async function findExactEvent(pool, phone, name, day, month, type) {
  const result = await pool.query(
    `
    SELECT id, phone, name, day, month, type, year, relationship
    FROM birthdays
    WHERE phone = $1 AND name = $2
      AND day = $3 AND LOWER(month) = LOWER($4) AND type = $5
    FOR UPDATE
    `,
    [phone, name, day, month, type]
  );
  if (result.rowCount > 1) {
    throw new Error(`Ambiguous birthday match for "${name}" on ${phone}`);
  }
  return result.rows[0] || null;
}

async function findDuplicateEvent(pool, source, reviewedName, reviewedType) {
  const result = await pool.query(
    `
    SELECT id, phone, name, day, month, type, year, relationship
    FROM birthdays
    WHERE phone = $1 AND LOWER(name) = LOWER($2)
      AND day = $3 AND LOWER(month) = LOWER($4) AND type = $5 AND id <> $6
    FOR UPDATE
    `,
    [source.phone, reviewedName, source.day, source.month, reviewedType, source.id]
  );
  if (result.rowCount > 1) {
    throw new Error(`Ambiguous duplicate for reviewed name "${reviewedName}" on ${source.phone}`);
  }
  return result.rows[0] || null;
}

async function applyReviewedBirthdayFixes(pool, fixes = REVIEWED_BIRTHDAY_FIXES) {
  const summary = { updated: 0, merged: 0, deleted: 0, skipped: 0 };

  await pool.query('BEGIN');
  try {
    for (const fix of fixes) {
      const source = await findExactEvent(
        pool,
        fix.phone,
        fix.currentName,
        fix.day,
        fix.month,
        fix.type
      );
      const duplicate = source && fix.action !== 'delete'
        ? await findDuplicateEvent(
          pool,
          source,
          fix.name.trim(),
          fix.newType || source.type
        )
        : null;
      const plan = planReviewedBirthdayFix(fix, source, duplicate);

      if (plan.action === 'skip') {
        summary.skipped += 1;
        continue;
      }

      if (plan.action === 'delete') {
        await pool.query(`DELETE FROM birthdays WHERE id = $1`, [plan.id]);
        summary.deleted += 1;
        continue;
      }

      if (plan.action === 'merge') {
        await pool.query(
          `UPDATE birthdays SET year = $2, relationship = $3, type = $4 WHERE id = $1`,
          [plan.survivorId, plan.year, plan.relationship, plan.type]
        );
        await pool.query(`DELETE FROM birthdays WHERE id = $1`, [plan.deleteId]);
        summary.merged += 1;
        continue;
      }

      await pool.query(
        `UPDATE birthdays SET name = $2, year = $3, relationship = $4, type = $5 WHERE id = $1`,
        [plan.id, plan.name, plan.year, plan.relationship, plan.type]
      );
      summary.updated += 1;
    }
    await pool.query('COMMIT');
  } catch (err) {
    await pool.query('ROLLBACK');
    throw err;
  }

  return summary;
}

module.exports = {
  REVIEWED_BIRTHDAY_FIXES,
  planReviewedBirthdayFix,
  applyReviewedBirthdayFixes
};
