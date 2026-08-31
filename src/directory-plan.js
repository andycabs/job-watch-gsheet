// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// What the catalogue does to the sheet.
//
// Separated from where the catalogue comes from, because that differs by
// runtime and this does not: on the command line it is a file in the
// repository, inside the spreadsheet it is fetched. The planning — which rows
// to write, which ticks to honour, what never to touch — is the same either
// way and is the part worth testing.
// ---------------------------------------------------------------------------
import { TABS, colLetter, readRange, resolveWriteRange, rowInSheetOrder, usedRows } from './sheet/schema.js';
import { indexColumns } from './sheet/read.js';
import { ATS_NAMES } from './boards.js';

/**
 * A catalogue document, cleaned.
 *
 * Only companies that can actually be watched reach the sheet: the
 * catalogue's promise is "tick this and it gets followed", and a row that can
 * never be followed breaks it every time somebody reads the tab.
 *
 * The unlisted are kept rather than deleted. That a company has no public
 * board is worth knowing — it says to go looking elsewhere — and one with
 * none today may have one next year.
 */
export function cleanDirectory(doc = {}) {
  return {
    ...doc,
    entries: (doc.entries || []).filter((e) => e && e.name && e.ats && e.slug),
    unlisted: (doc.unlisted || []).filter((e) => e && e.name),
  };
}

/** Names compare with case and punctuation ignored - "Apollo.io" is "Apollo io". */
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function planDirectorySync(existing = [], entries = []) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && e.name) : [];
  const tab = TABS.directory;
  const rows0 = Array.isArray(existing) ? existing : [];
  const [header = [], ...rows] = rows0;
  const { index } = indexColumns(tab, header);

  const target = resolveWriteRange(tab, header, 2);
  if (target.problem) return { operations: [], updated: 0, added: 0, problems: [target.problem] };

  const at = new Map();
  rows.forEach((row, i) => {
    const name = key(row && row[index.name]);
    if (name && !at.has(name)) at.set(name, { line: i + 2, row });
  });

  const operations = [];
  let updated = 0;
  const appended = [];

  for (const entry of list) {
    const found = at.get(key(entry.name));
    if (found) {
      const values = target.keys.map((k) => String(entry[k] != null ? entry[k] : ''));
      // Only write when something actually differs, so a no-op refresh is a
      // no-op on the wire too.
      const current = target.keys.map((k) => String((found.row && found.row[index[k]]) || ''));
      if (values.join(' ') === current.join(' ')) continue;
      operations.push({
        op: 'writeRange',
        range: target.range.replace(/([A-Z]+)\d+:([A-Z]+)\d+$/, `$1${found.line}:$2${found.line}`),
        values: [values],
      });
      updated++;
    } else {
      appended.push(rowInSheetOrder(tab, header, { add: '', ...entry }));
    }
  }

  if (appended.length) {
    // Not rows.length: the Add column is a checkbox, so every untouched row in
    // the grid reads FALSE and counts as occupied.
    const start = usedRows(rows, index.name) + 2;
    const width = Math.max(header.length, tab.columns.length);
    operations.push({
      op: 'writeRange',
      range: `${tab.name}!A${start}:${colLetter(width - 1)}${start + appended.length - 1}`,
      values: appended,
    });
  }

  return { operations, updated, added: appended.length, problems: [] };
}

// Every reasonable way of saying yes in a spreadsheet, including the single
// letters people type when a dropdown is in their way.
const isOn = (v) => /^(true|t|yes|y|on|1|x)$/i.test(String(v == null ? '' : v).trim());

/**
 * Which catalogue rows are ticked but not yet being watched, as companies-tab
 * rows ready to append.
 */
export function planEnable(directoryRows = [], companyRows = []) {
  const dir = TABS.directory;
  const co = TABS.companies;
  const [dirHeader = [], ...rows] = Array.isArray(directoryRows) ? directoryRows : [];
  const [coHeader = [], ...existing] = Array.isArray(companyRows) ? companyRows : [];

  const di = indexColumns(dir, dirHeader).index;
  const ci = indexColumns(co, coHeader).index;

  const watched = new Set(existing.map((r) => key(r && r[ci.name])).filter(Boolean));

  const rowsOut = [];
  const enabled = [];
  const already = [];
  const problems = [];

  for (const row of rows) {
    if (!isOn(row && row[di.add])) continue;
    const name = String((row && row[di.name]) || '').trim();
    if (!name) continue;
    enabled.push(name);

    if (watched.has(key(name))) { already.push(name); continue; }
    watched.add(key(name));

    const ats = String((row && row[di.ats]) || '').trim().toLowerCase();
    if (ats && !ATS_NAMES.includes(ats)) {
      problems.push(`directory: "${name}" names board "${ats}", which is not supported - left for discovery`);
    }

    rowsOut.push(rowInSheetOrder(co, coHeader, {
      active: 'TRUE',
      name,
      category: String((row && row[di.category]) || '').trim(),
      // Where it came from, since a row appearing on its own is otherwise a
      // small mystery a month later.
      note: 'added from the directory',
      ats: ATS_NAMES.includes(ats) ? ats : '',
      slug: ATS_NAMES.includes(ats) ? String((row && row[di.slug]) || '').trim() : '',
      verified: '',
    }));
  }

  const operations = [];
  if (rowsOut.length) {
    // The companies tab has a checkbox in Active, so the same rule applies
    // here: count the rows with a name, not the rows in the grid.
    const start = usedRows(existing, ci.name) + 2;
    const width = Math.max(coHeader.length, co.columns.length);
    operations.push({
      op: 'writeRange',
      range: `${co.name}!A${start}:${colLetter(width - 1)}${start + rowsOut.length - 1}`,
      values: rowsOut,
    });
  }

  return { operations, added: rowsOut.length, enabled, already, problems, rows: rowsOut };
}

/** Refresh the catalogue and enable what's ticked. Used by the watch. */
