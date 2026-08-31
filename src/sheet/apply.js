// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// Running a bootstrap against a real spreadsheet.
//
// Reads what's there, asks the planner what's missing, executes it. All the
// judgement lives in planBootstrap; this file is the part that touches the
// network, and it is deliberately thin so there is little here that can only
// be tested against Google.
// ---------------------------------------------------------------------------
import { planBootstrap, auditSheet } from './bootstrap.js';
import { TAB_NAMES, TABS, readRange, columnIndex } from './schema.js';

/**
 * Looks at the sheet as the planner needs to see it.
 *
 * "Populated" means a data row exists below the header. That distinction is
 * what stops a re-run from writing example rows over someone's real ones, so
 * it reads whole rows rather than probing one column — a rules tab whose
 * Active column is blank is still populated.
 */
const trimTrailingBlanks = (row) => {
  const out = [...row];
  while (out.length && String(out.at(-1) ?? '').trim() === '') out.pop();
  return out;
};

export async function readSheetState(client) {
  const tabs = await client.listTabs();
  const existingTabs = tabs.map((t) => t.name);
  const known = TAB_NAMES.filter((n) => existingTabs.includes(n));
  const head = known.length ? await client.headRows(known, 3) : {};

  const populated = {};
  const headed = {};
  const headers = {};
  for (const name of known) {
    const rows = head[name] || [];
    // Reads run wider than the schema so an inserted column is never missed,
    // which means the header row arrives padded with blank cells out to the
    // read's edge. Anything comparing its length — the schema-upgrade check
    // in planBootstrap, for one — needs the real width, not the padded one.
    if (rows[0]) rows[0] = trimTrailingBlanks(rows[0]);
    headed[name] = Boolean(rows[0]?.length);
    populated[name] = rows.length > 1;
    // An empty tab has no header row to compare against — leave it out rather
    // than reporting every column as missing.
    if (headed[name]) headers[name] = rows[0];
  }

  // The settings tab is read in full rather than three rows deep: adding a
  // later version's new setting means knowing which ones are already there by
  // name, and where the rows end.
  let settingNames = [];
  const rowCounts = {};
  if (known.includes('settings')) {
    const rows = await client.getValues(readRange(TABS.settings));
    const nameAt = columnIndex(TABS.settings, 'setting');
    const body = rows.slice(1);
    settingNames = body.map((r) => String(r?.[nameAt] || '').trim()).filter(Boolean);
    rowCounts.settings = rows.length;
  }

  return { existingTabs, populated, headed, headers, settingNames, rowCounts };
}

/**
 * Creates whatever is missing and leaves everything else alone.
 * Safe to run on a sheet in daily use — that's how a schema upgrade lands.
 */
export async function bootstrapSheet(client, { dryRun = false, reformat = false } = {}) {
  const state = await readSheetState(client);
  const plan = planBootstrap({ ...state, reformat });

  if (dryRun || !plan.operations.length) {
    // Nothing was applied, so the audit describes the sheet as found — minus
    // the tabs the plan would have created, which aren't yet worth reporting
    // as missing.
    return { ...plan, applied: 0, dryRun, audit: auditSheet(state, { ignoreTabs: plan.created }) };
  }

  const { applied } = await client.applyOps(plan.operations);

  // Audit against the sheet as it now is, not as it was — a bootstrap that
  // reported success while leaving the workbook wrong would be worse than
  // one that failed.
  const after = await readSheetState(client);
  return { ...plan, applied, dryRun: false, audit: auditSheet(after) };
}

