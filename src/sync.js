// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// Turning a run's results into sheet operations.
//
// Pure: given the rows already in the sheet and the postings found this run,
// it returns the writes. No network, so the upsert rules — which are the rules
// that decide whether someone's triage survives — are testable offline.
//
// Rows are keyed on `${slug}:${jobId}` and never deleted. A posting that
// leaves a board simply stops having its Last seen advanced, which is the
// signal it's gone; deleting the row would take the note attached to it too.
//
// THE ONE EXCEPTION TO THE COLUMN RULE
//
// Everywhere else, script writes start to the right of every user column, so
// clobbering typed text is impossible rather than merely avoided. Closing a
// stale row breaks that: Status is the leftmost column and user-owned, and
// "mark it Closed after 7 days unseen" cannot be done without writing it.
//
// So it is done as narrowly as the requirement allows:
//   - one cell, A{row}, never a range
//   - only when the cell currently reads exactly the untriaged default
//   - a row anyone has touched — Interested, Applied, or a value they typed
//     themselves — is never written to, whatever its age
//
// The guard is on the value read back from the sheet, not on what this code
// last wrote there, so a row triaged between two runs is still safe.
// ---------------------------------------------------------------------------
import { TABS, colLetter, columnIndex, resolveWriteRange, rowInSheetOrder } from './sheet/schema.js';
import { indexColumns } from './sheet/read.js';
import { formatSalary } from './salary.js';
import { ageInDays } from './score.js';

const MATCHES = TABS.matches;
const DROPPED = TABS.dropped;

/** The untriaged default. A row still reading this has never been looked at. */
export const UNTRIAGED = MATCHES.columns[0].initial;
export const CLOSED = 'Closed';

export const jobKey = (company, job) => `${company.slug}:${job.id}`;

/**
 * One posting, as the script-owned half of a row.
 * `firstSeen` is preserved from the existing row when there is one — it is the
 * only field here that describes the row's history rather than the posting.
 */
export function buildRecord({ job, company, salary, verdict, score, settings = {} }, now = new Date()) {
  const days = ageInDays(job.postedAt, now);
  const stale = settings.stalePostingDays || 60;
  const today = now.toISOString().slice(0, 10);

  return {
    key: jobKey(company, job),
    score: score?.score ?? '',
    company: company.name,
    title: job.title || '',
    salary: formatSalary(salary),
    location: job.location || '',
    posted: job.postedAt ? String(job.postedAt).slice(0, 10) : '',
    age: days === null ? '' : days >= stale ? `${days}d — stale` : `${days}d`,
    matched: (verdict?.signals || []).map((s) => s.label).join(', '),
    salaryMin: salary?.min ?? '',
    salaryMax: salary?.max ?? '',
    salaryBasis: salary?.basis || '',
    firstSeen: today,
    lastSeen: today,
    url: job.url || '',
    changed: '',
    payRank: '',
  };
}

/**
 * What moved on a posting since the last run.
 *
 * The watch sees the same posting every day and, until now, silently
 * overwrote yesterday's row with today's. A band going up on a live req is a
 * strong signal and exists nowhere else — nobody but the person holding a
 * daily snapshot of that board can see it.
 *
 * Only fields worth being told about are compared. `lastSeen` moves every run
 * and `age` moves every day; reporting either would bury the ones that matter.
 */
const WATCHED_FIELDS = [
  ['title', 'title'],
  ['salary', 'salary'],
  ['location', 'location'],
  ['posted', 'reposted'],
];

export function describeChange(before, after) {
  const was0 = before || {};
  const now0 = after || {};
  const parts = [];
  for (const [key, label] of WATCHED_FIELDS) {
    const was = String(was0[key] ?? '').trim();
    const now = String(now0[key] ?? '').trim();
    if (!was || !now || was === now) continue;   // first sight is not a change

    if (key === 'posted') {
      parts.push(`reposted (was ${was})`);
    } else if (key === 'salary') {
      parts.push(`salary ${was} → ${now}`);
    } else {
      parts.push(`${label} ${was} → ${now}`);
    }
  }
  return parts.join(' · ');
}

/**
 * @param existing  the matches tab's rows, header included
 * @param records   this run's postings, from buildRecord
 * @returns {{ operations, updated, added, closed, summary }}
 */
export function planSync(existing, records, { settings = {}, now = new Date() } = {}) {
  const [header = [], ...rows] = Array.isArray(existing) ? existing : [];
  records = Array.isArray(records) ? records : [];
  const { index } = indexColumns(MATCHES, header);
  const problems = [];

  // Both reads and writes are located from the sheet's own header, so a
  // column someone inserted moves the write range with it rather than being
  // written over. When no safe range exists, nothing is written at all.
  const target = resolveWriteRange(MATCHES, header, 2);
  if (target.problem) {
    return {
      operations: [], updated: 0, added: 0, addedRecords: [], closed: 0, closedRows: [],
      problems: [target.problem],
      summary: `nothing written — ${target.problem}`,
    };
  }

  // Where each key already lives, and what it looked like.
  const seen = new Map();
  rows.forEach((row, i) => {
    const key = String(row?.[index.key] ?? '').trim();
    if (key) seen.set(key, { line: i + 2, row });
  });

  const operations = [];
  const updates = [];
  const appends = [];
  // Which records were genuinely new. A digest that re-lists everything still
  // open gets muted within a week, so the notifier needs this rather than a
  // count.
  const added = [];
  const changes = [];

  for (let record of records) {
    const existingRow = seen.get(record.key);
    if (existingRow) {
      // First seen belongs to the row, not to this run.
      const kept = String(existingRow.row?.[index.firstSeen] ?? '').trim();

      // What moved since yesterday, compared before the row is overwritten.
      const before = Object.fromEntries(MATCHES.columns
        .map((c) => [c.key, existingRow.row?.[index[c.key]]]));
      const moved = describeChange(before, record);
      if (moved) changes.push({ key: record.key, record, change: moved });
      record = { ...record, changed: moved };
      // Values in the order the sheet has those columns, which is what
      // `target.keys` carries — not the order the schema declares them.
      const values = target.keys.map((key) =>
        String((key === 'firstSeen' && kept ? kept : record[key]) ?? ''));
      updates.push({
        op: 'writeRange',
        range: rangeAtRow(target.range, existingRow.line),
        values: [values],
      });
    } else {
      const seeded = Object.fromEntries(MATCHES.columns
        .filter((c) => c.owner === 'user')
        .map((c) => [c.key, c.initial ?? '']));
      appends.push(rowInSheetOrder(MATCHES, header, { ...seeded, ...record }));
      added.push(record);
    }
  }

  operations.push(...updates);

  // Appends go after the last row that currently exists. Doing it as a write
  // to a known range rather than an append keeps the transport down to three
  // operations, and two runs never collide because a run reads the sheet
  // immediately before planning.
  if (appends.length) {
    const start = rows.length + 2;
    const width = Math.max(header.length, MATCHES.columns.length);
    operations.push({
      op: 'writeRange',
      range: `${MATCHES.name}!A${start}:${colLetter(width - 1)}${start + appends.length - 1}`,
      values: appends,
    });
  }

  const closed = planClosures(rows, index, header, records, { settings, now });
  operations.push(...closed.operations);
  problems.push(...closed.problems);

  // A row whose Key has been cleared cannot be recognised again. The posting
  // re-appears as a second row and the original sits there unchanging, still
  // carrying whatever status and note someone put on it. It is the one way of
  // damaging this sheet that costs work and says nothing, so it says something.
  const keyless = rows
    .map((row, i) => ({ line: i + 2, row }))
    .filter(({ row }) => row?.some((cell) => String(cell ?? '').trim())
      && !String(row?.[index.key] ?? '').trim());

  if (keyless.length) {
    problems.push(
      `matches: ${keyless.length} row${keyless.length === 1 ? '' : 's'} ` +
      `(${keyless.slice(0, 4).map((k) => k.line).join(', ')}` +
      `${keyless.length > 4 ? '…' : ''}) ${keyless.length === 1 ? 'has' : 'have'} no Key. ` +
      `${keyless.length === 1 ? 'It' : 'They'} will never update again, and the postings will ` +
      `come back as new rows — restore the Key from the URL, or delete the row.`
    );
  }

  // A key appearing twice means someone copied a row. Only the last is kept
  // up to date, so the other silently ages — worth saying rather than leaving
  // them to notice a row that stopped moving.
  const counts = new Map();
  for (const row of rows) {
    const key = String(row?.[index.key] ?? '').trim();
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const doubled = [...counts].filter(([, n]) => n > 1).map(([k]) => k);
  if (doubled.length) {
    problems.push(`matches: ${doubled.length} key${doubled.length === 1 ? '' : 's'} appear twice ` +
      `(${doubled.slice(0, 3).join(', ')}${doubled.length > 3 ? '…' : ''}) — ` +
      `only the last row of each is kept up to date`);
  }

  return {
    operations,
    updated: updates.length,
    added: appends.length,
    addedRecords: added,
    changes,
    closed: closed.rows.length,
    closedRows: closed.rows,
    problems,
    summary: `${updates.length} updated, ${appends.length} added` +
      (changes.length ? `, ${changes.length} changed` : '') +
      (closed.rows.length ? `, ${closed.rows.length} closed` : ''),
  };
}

/** Moves a single-row range to another row: matches!C2:Q2 -> matches!C7:Q7. */
function rangeAtRow(range, row) {
  return range.replace(/([A-Z]+)\d+:([A-Z]+)\d+$/, `$1${row}:$2${row}`);
}

/**
 * Rows to mark Closed: not seen this run, unseen for longer than the setting
 * allows, and still untouched.
 *
 * Read the comment at the top of this file before changing anything here —
 * this is the only place in the codebase that writes a user-owned column.
 */
function planClosures(rows, index, header, records, { settings, now }) {
  const after = settings.closeAfterDays;
  const out = { operations: [], rows: [], problems: [] };
  if (!after) return out;

  const live = new Set(records.map((r) => r.key));
  // The Status cell, located in the sheet rather than assumed from the schema.
  // This is the one write that targets a user-owned column, so it is the one
  // that must not be off by a column.
  const statusAt = index.status;
  const seen = (header || []).map((h) => String(h ?? '').trim().toLowerCase());
  if (seen.length && seen[statusAt] !== MATCHES.columns[0].header.toLowerCase()) {
    out.problems.push(`matches: cannot find the Status column, so no row was closed`);
    return out;
  }
  const statusCol = colLetter(statusAt);

  rows.forEach((row, i) => {
    const key = String(row?.[index.key] ?? '').trim();
    if (!key || live.has(key)) return;

    // The guard: whatever is in the cell right now, not what we think we put
    // there. A row triaged between two runs is safe.
    const status = String(row?.[index.status] ?? '').trim();
    if (status !== UNTRIAGED) return;

    const lastSeen = String(row?.[index.lastSeen] ?? '').trim();
    const days = ageInDays(lastSeen, now);
    if (days === null || days < after) return;

    const line = i + 2;
    out.rows.push({ line, key, days });
    out.operations.push({
      op: 'writeRange',
      range: `${MATCHES.name}!${statusCol}${line}:${statusCol}${line}`,
      values: [[CLOSED]],
    });
  });

  return out;
}

/**
 * The dropped tab is a view of this run, not a record, so it's replaced each
 * time. There is no clear operation in this codebase, so the replacement is a
 * write padded with blank rows out to whatever the previous run left behind.
 */
export function planDropped(existingRowCount, dropped = []) {
  const width = DROPPED.columns.length;
  const lastCol = colLetter(width - 1);
  const rows = dropped.map((d) => DROPPED.columns.map((c) => String(d[c.key] ?? '')));

  const blanks = Math.max(0, existingRowCount - rows.length);
  for (let i = 0; i < blanks; i++) rows.push(Array(width).fill(''));
  if (!rows.length) return [];

  return [{
    op: 'writeRange',
    range: `${DROPPED.name}!A2:${lastCol}${1 + rows.length}`,
    values: rows,
  }];
}
