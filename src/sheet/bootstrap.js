// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// First-run bootstrap.
//
// Turns an empty (or partial) spreadsheet into a working one. The planning is
// pure — given the tabs that exist, it returns the operations needed — so the
// setup experience is testable without a Google account. A transport executes
// the plan.
//
// Design rules, both learned from v1:
//
//   Never destructive. The planner only ever creates a missing tab or adds a
//   missing header. It has no operation that clears or overwrites a populated
//   cell, so re-running it on a sheet someone has been using is safe and, in
//   fact, how a schema upgrade is applied.
//
//   Seed rows are examples, not data. A new tab arrives showing the shape of a
//   row rather than an empty grid, because a blank spreadsheet tells a
//   first-time user nothing about what belongs in it.
// ---------------------------------------------------------------------------
import { TABS, TAB_NAMES, headers, seedRow, colLetter, protectedBlocks } from './schema.js';

/**
 * @param {object} state - what's already there:
 *        { existingTabs: string[],
 *          populated?: Record<string, boolean>,   // has data rows below row 1
 *          headed?: Record<string, boolean> }     // has a header row
 *        The two are separate because a tab can have its headers and no data —
 *        which is the normal resting state of `matches` before the first run,
 *        and must not count as "needs headers" on every run afterwards.
 * @returns {{ operations, created, seeded, headered, summary }}
 */
export function planBootstrap(state = {}) {
  const existing = new Set(state.existingTabs || []);
  const populated = state.populated || {};
  // A caller that only knows whether a tab has data implies the header: the
  // rows it saw had to sit under one.
  const headed = state.headed || populated;

  const operations = [];
  const created = [];
  const seeded = [];
  const headered = [];
  const extended = [];
  const reformatted = [];
  const added = [];

  for (const name of TAB_NAMES) {
    const tab = TABS[name];
    const lastCol = colLetter(tab.columns.length - 1);

    if (!existing.has(name)) {
      operations.push({ op: 'addTab', tab: name, frozenRows: tab.frozenRows });
      created.push(name);
    }

    // Headers are written whenever a tab is new. On an existing tab they're
    // written only if row 1 is blank — never over an existing header, in case
    // someone has renamed a column heading to suit themselves.
    const want = headers(tab);
    const have = state.headers?.[name];

    if (!existing.has(name) || !headed[name]) {
      operations.push({
        op: 'writeRange',
        range: `${name}!A1:${lastCol}1`,
        values: [want],
      });
      headered.push(name);
    } else if (have && have.length < want.length &&
               want.slice(0, have.length).every((h, i) => h === have[i])) {
      // A later version added columns at the right edge. Writing the full
      // header row only adds cells beyond what is there, so a sheet in daily
      // use upgrades in place instead of having to be rebuilt. Anything other
      // than a clean append is left alone — reordering or renaming is the
      // user's business, and auditSheet reports it.
      operations.push({
        op: 'writeRange',
        range: `${name}!A1:${lastCol}1`,
        values: [want],
      });
      extended.push({ tab: name, columns: want.slice(have.length) });
    }

    // Column widths and validation are cosmetic-but-load-bearing: a Status
    // column without its dropdown invites typos that break filtering.
    if (!existing.has(name) || state.reformat) {
      operations.push({
        op: 'formatTab',
        tab: name,
        widths: tab.columns.map((c) => c.width || 140),
        validations: tab.columns
          .map((c, i) => (c.validation ? { column: i, ...c.validation } : null))
          .filter(Boolean),
        protections: protectedBlocks(tab),
        frozenRows: tab.frozenRows,
      });
      if (existing.has(name)) reformatted.push(name);
    }

    // Seed examples only into a tab that is genuinely empty.
    if (tab.seed?.length && !populated[name]) {
      operations.push({
        op: 'writeRange',
        range: `${name}!A2:${lastCol}${1 + tab.seed.length}`,
        values: tab.seed.map((s) => seedRow(tab, s)),
      });
      seeded.push(name);
    }

    // Settings are the exception: a later version's new setting has to reach a
    // sheet that already has rows in it, or nobody who set the tool up before
    // that release can ever use the thing.
    //
    // Only settings, and only ones absent by name. Appending missing seed rows
    // to any other tab would put the example rules back after someone deleted
    // them, which is a different and much less welcome behaviour.
    if (name === 'settings' && populated[name]) {
      const present = new Set(state.settingNames || []);
      const missing = tab.seed.filter((row) => !present.has(row.setting));
      if (missing.length && present.size) {
        const start = (state.rowCounts?.[name] || present.size + 1) + 1;
        operations.push({
          op: 'writeRange',
          range: `${name}!A${start}:${lastCol}${start + missing.length - 1}`,
          values: missing.map((row) => seedRow(tab, row)),
        });
        added.push(...missing.map((row) => row.setting));
      }
    }
  }

  return {
    operations,
    created,
    seeded,
    headered,
    extended,
    reformatted,
    added,
    summary: describe(created, seeded, headered, extended) +
      (reformatted.length && !created.length ? `re-applied formatting to ${reformatted.join(', ')}` : ''),
  };
}

function describe(created, seeded, headered = [], extended = []) {
  if (!created.length && !seeded.length && !headered.length && !extended.length) {
    return 'Sheet is already set up — nothing to do.';
  }
  const parts = [];
  if (created.length) parts.push(`created ${created.length} tab${created.length === 1 ? '' : 's'} (${created.join(', ')})`);
  const onlyHeaders = headered.filter((n) => !created.includes(n));
  if (onlyHeaders.length) parts.push(`added headers to ${onlyHeaders.join(', ')}`);
  if (seeded.length) parts.push(`added examples to ${seeded.join(', ')}`);
  for (const e of extended) {
    parts.push(`added ${e.columns.join(', ')} to ${e.tab}`);
  }
  return parts.join('; ');
}

/**
 * Human-readable setup instructions, generated from the schema so the docs
 * can't drift from the actual columns.
 */
export function describeTabs() {
  return TAB_NAMES.map((name) => {
    const tab = TABS[name];
    const cols = tab.columns
      .map((c) => (c.help ? `  ${c.header} — ${c.help}` : `  ${c.header}`))
      .join('\n');
    return `${tab.name}\n  ${tab.purpose}\n${cols}`;
  }).join('\n\n');
}

/**
 * Checks a sheet against the schema and reports drift, so a run can warn
 * rather than fail confusingly when someone has deleted a column.
 */
export function auditSheet(state = {}, { ignoreTabs = [] } = {}) {
  const existing = new Set(state.existingTabs || []);
  const skip = new Set(ignoreTabs);
  const problems = [];

  for (const name of TAB_NAMES) {
    if (skip.has(name)) continue;      // a tab the caller is about to create
    if (!existing.has(name)) {
      problems.push(`missing tab "${name}" — run setup to create it`);
      continue;
    }
    const seen = state.headers?.[name];
    if (!seen) continue;

    const expected = headers(TABS[name]);
    const missing = expected.filter((h) => !seen.includes(h));
    if (missing.length) {
      problems.push(`${name}: missing column${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`);
    }
  }

  return { ok: problems.length === 0, problems };
}
