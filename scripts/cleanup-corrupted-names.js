// Approval-based cleanup for legacy birthday rows whose names may contain a
// year or relationship. This script NEVER applies inferred changes directly.
//
// 1) Generate a review report:
//      node scripts/cleanup-corrupted-names.js
// 2) Create an approvals JSON file containing only reviewed rows:
//      [
//        {
//          "id": 4,
//          "expectedName": "Shreyas 1995",
//          "action": "merge",
//          "survivorId": 6,
//          "name": "Shreyas",
//          "year": 1995,
//          "relationship": null
//        }
//      ]
// 3) Apply exactly those approvals in one transaction:
//      node scripts/cleanup-corrupted-names.js --apply approvals.json
//
// `expectedName` prevents stale approvals from modifying a row that changed
// after review. Conflicts and merges must be resolved explicitly in the file.

require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const { pool } = require('../src/db/pool');
const { splitRelationshipFromName } = require('../src/parsers/date.parser');

// Report-only heuristic: a year must be the final standalone token. Even then
// it is merely proposed for human review, never trusted automatically.
function proposeCandidate(row) {
  let working = row.name.trim();
  let year = null;
  const yearMatch = working.match(/\b(19\d{2}|20\d{2})\s*$/);
  if (yearMatch) {
    const y = parseInt(yearMatch[1], 10);
    if (y >= 1900 && y <= new Date().getFullYear()) {
      year = y;
      working = working.slice(0, yearMatch.index).trim();
    }
  }

  const split = splitRelationshipFromName(working);
  const name = split.name
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s,:–—-]+|[\s,:–—-]+$/g, '');

  const proposedYear = row.year || year || null;
  const proposedRelationship = row.relationship || split.relationship || null;
  const changed = (
    name !== row.name ||
    proposedYear !== (row.year || null) ||
    proposedRelationship !== (row.relationship || null)
  );
  if (!changed || !name) return null;

  return {
    id: row.id,
    phone: row.phone,
    originalName: row.name,
    day: row.day,
    month: row.month,
    type: row.type,
    currentYear: row.year || null,
    currentRelationship: row.relationship || null,
    proposedName: name,
    proposedYear,
    proposedRelationship,
    requiresApproval: true
  };
}

async function buildReport() {
  const { rows } = await pool.query(
    `
    SELECT id, phone, name, day, month, type, year, relationship
    FROM birthdays
    ORDER BY phone, name
    `
  );

  const report = [];
  for (const row of rows) {
    const candidate = proposeCandidate(row);
    if (!candidate) continue;
    const dup = await pool.query(
      `
      SELECT id, year, relationship FROM birthdays
      WHERE phone = $1 AND LOWER(name) = LOWER($2)
        AND day = $3 AND LOWER(month) = LOWER($4) AND type = $5 AND id <> $6
      ORDER BY id
      `,
      [row.phone, candidate.proposedName, row.day, row.month, row.type, row.id]
    );

    candidate.possibleDuplicates = dup.rows.map(existing => ({
      id: existing.id,
      year: existing.year || null,
      relationship: existing.relationship || null,
      yearConflict: Boolean(
        existing.year && candidate.proposedYear &&
        existing.year !== candidate.proposedYear
      ),
      relationshipConflict: Boolean(
        existing.relationship && candidate.proposedRelationship &&
        existing.relationship.toLowerCase() !== candidate.proposedRelationship.toLowerCase()
      )
    }));
    report.push(candidate);
  }
  return report;
}

function validateApproval(approval) {
  if (!approval || !Number.isInteger(approval.id) || approval.id < 1) {
    throw new Error('Each approval needs a positive integer id');
  }
  if (typeof approval.expectedName !== 'string' || !approval.expectedName.trim()) {
    throw new Error(`Approval ${approval.id} needs expectedName`);
  }
  if (!['update', 'merge'].includes(approval.action)) {
    throw new Error(`Approval ${approval.id} action must be "update" or "merge"`);
  }
  if (typeof approval.name !== 'string' || !approval.name.trim()) {
    throw new Error(`Approval ${approval.id} needs a non-empty reviewed name`);
  }
  if (!Object.hasOwn(approval, 'year') || !Object.hasOwn(approval, 'relationship')) {
    throw new Error(`Approval ${approval.id} must explicitly include year and relationship`);
  }
  if (
    approval.year !== null &&
    (!Number.isInteger(approval.year) || approval.year < 1900 || approval.year > new Date().getFullYear())
  ) {
    throw new Error(`Approval ${approval.id} has an invalid year`);
  }
  if (
    approval.relationship !== null &&
    (typeof approval.relationship !== 'string' || !approval.relationship.trim() || approval.relationship.length > 80)
  ) {
    throw new Error(`Approval ${approval.id} has an invalid relationship`);
  }
  if (approval.action === 'merge' && (!Number.isInteger(approval.survivorId) || approval.survivorId < 1)) {
    throw new Error(`Merge approval ${approval.id} needs a positive integer survivorId`);
  }
}

async function applyApprovals(approvals) {
  if (!Array.isArray(approvals) || approvals.length === 0) {
    throw new Error('Approvals file must contain a non-empty JSON array');
  }
  approvals.forEach(validateApproval);
  if (new Set(approvals.map(item => item.id)).size !== approvals.length) {
    throw new Error('Approvals file contains duplicate source ids');
  }

  await pool.query('BEGIN');
  try {
    for (const approval of approvals) {
      const sourceResult = await pool.query(
        `SELECT * FROM birthdays WHERE id = $1 FOR UPDATE`,
        [approval.id]
      );
      if (sourceResult.rowCount !== 1) {
        throw new Error(`Approved source row ${approval.id} no longer exists`);
      }
      const source = sourceResult.rows[0];
      if (source.name !== approval.expectedName) {
        throw new Error(
          `Row ${approval.id} changed since review: expected "${approval.expectedName}", found "${source.name}"`
        );
      }

      const reviewedName = approval.name.trim();
      const reviewedRelationship = approval.relationship === null
        ? null
        : approval.relationship.trim();

      if (approval.action === 'update') {
        const duplicate = await pool.query(
          `
          SELECT id FROM birthdays
          WHERE phone = $1 AND LOWER(name) = LOWER($2)
            AND day = $3 AND LOWER(month) = LOWER($4) AND type = $5 AND id <> $6
          LIMIT 1
          `,
          [source.phone, reviewedName, source.day, source.month, source.type, source.id]
        );
        if (duplicate.rowCount > 0) {
          throw new Error(
            `Row ${source.id} would duplicate row ${duplicate.rows[0].id}; approve an explicit merge instead`
          );
        }
        await pool.query(
          `UPDATE birthdays SET name = $2, year = $3, relationship = $4 WHERE id = $1`,
          [source.id, reviewedName, approval.year, reviewedRelationship]
        );
        continue;
      }

      if (approval.survivorId === source.id) {
        throw new Error(`Row ${source.id} cannot merge into itself`);
      }
      const survivorResult = await pool.query(
        `SELECT * FROM birthdays WHERE id = $1 FOR UPDATE`,
        [approval.survivorId]
      );
      if (survivorResult.rowCount !== 1) {
        throw new Error(`Approved survivor row ${approval.survivorId} no longer exists`);
      }
      const survivor = survivorResult.rows[0];
      const sameEvent = (
        survivor.phone === source.phone &&
        survivor.day === source.day &&
        survivor.month.toLowerCase() === source.month.toLowerCase() &&
        survivor.type === source.type &&
        survivor.name.toLowerCase() === reviewedName.toLowerCase()
      );
      if (!sameEvent) {
        throw new Error(
          `Rows ${source.id} and ${survivor.id} are not the same reviewed event`
        );
      }
      await pool.query(
        `UPDATE birthdays SET year = $2, relationship = $3 WHERE id = $1`,
        [survivor.id, approval.year, reviewedRelationship]
      );
      await pool.query(`DELETE FROM birthdays WHERE id = $1`, [source.id]);
    }
    await pool.query('COMMIT');
  } catch (err) {
    await pool.query('ROLLBACK');
    throw err;
  }
}

async function main() {
  const applyIndex = process.argv.indexOf('--apply');
  if (applyIndex === -1) {
    const report = await buildReport();
    console.log(JSON.stringify(report, null, 2));
    console.error(`\n${report.length} candidate(s); report only — no changes were made.`);
    return;
  }

  const approvalsPath = process.argv[applyIndex + 1];
  if (!approvalsPath) {
    throw new Error('--apply requires the path to a reviewed approvals JSON file');
  }
  const absolutePath = path.resolve(approvalsPath);
  const approvals = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  await applyApprovals(approvals);
  console.log(`Applied ${approvals.length} reviewed approval(s) transactionally.`);
}

if (require.main === module) {
  if (!process.env.DATABASE_URL) {
    console.error(
      'Cleanup failed: this computer does not have DATABASE_URL, so it cannot reach the live birthday database.\n' +
      'Copy DATABASE_URL from your hosting dashboard (the same place WHATSAPP_TOKEN lives),\n' +
      'put it in a .env file in this project folder, then run the command again.'
    );
    process.exit(1);
  }

  main()
    .catch(err => {
      console.error('Cleanup failed:', err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = { proposeCandidate, validateApproval, buildReport, applyApprovals };
