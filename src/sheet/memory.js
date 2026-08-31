// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// An in-memory spreadsheet implementing the same four verbs as the real
// backends.
//
// It exists because the interesting parts of setup — does a re-run leave an
// edited cell alone, does a schema upgrade add only the missing tab — are
// properties of the whole round trip, not of the planner alone, and testing
// them against Google would mean nobody can run the tests.
//
// It is strict on purpose: writing to a tab that doesn't exist throws here,
// exactly as it would against the API, so an ordering bug fails offline
// rather than on someone's live sheet.
// ---------------------------------------------------------------------------
import { SUPPORTED_OPS } from './schema.js';

/** Parses "tab!A1:D3", "tab!1:3" or "tab!A1". Rows/cols are 0-based. */
export function parseRange(range) {
  const [name, a1] = String(range).split('!');
  if (!a1) return { name, whole: true };

  const cell = /^([A-Z]*)(\d*)$/;
  const [from, to = from] = a1.split(':');
  const [, c1 = '', r1 = ''] = cell.exec(from) || [];
  const [, c2 = '', r2 = ''] = cell.exec(to) || [];

  return {
    name,
    startCol: c1 ? colIndex(c1) : 0,
    endCol: c2 ? colIndex(c2) : Infinity,
    startRow: r1 ? Number(r1) - 1 : 0,
    endRow: r2 ? Number(r2) - 1 : Infinity,
  };
}

export function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function memoryClient(initial = {}) {
  // tab name -> { gid, grid: string[][], frozenRows, widths, validations }
  const tabs = new Map();
  let nextGid = 100;

  for (const [name, grid] of Object.entries(initial)) {
    tabs.set(name, { gid: nextGid++, grid: grid.map((r) => [...r]), widths: [], validations: [] });
  }

  const need = (name) => {
    const tab = tabs.get(name);
    if (!tab) throw new Error(`no such tab "${name}" — a write reached it before it was created`);
    return tab;
  };

  const write = (range, values) => {
    const { name, startRow, startCol } = parseRange(range);
    const tab = need(name);
    values.forEach((row, r) => {
      const target = (tab.grid[startRow + r] ||= []);
      row.forEach((v, c) => { target[startCol + c] = String(v ?? ''); });
    });
  };

  const read = (range) => {
    const { name, startRow, endRow, startCol, endCol, whole } = parseRange(range);
    const tab = tabs.get(name);
    if (!tab) return [];
    const rows = whole ? tab.grid : tab.grid.slice(startRow, endRow === Infinity ? undefined : endRow + 1);
    return trimTrailingBlank(rows.map((row = []) =>
      whole ? [...row] : row.slice(startCol, endCol === Infinity ? undefined : endCol + 1)
    ));
  };

  return {
    kind: 'memory',
    describe: () => 'in-memory spreadsheet',

    listTabs: async () => [...tabs].map(([name, t]) => ({ name, gid: t.gid })),

    headRows: async (names, rows = 3) =>
      Object.fromEntries(names.map((n) => [n, read(`${n}!1:${rows}`)])),

    getValues: async (range) => read(range),

    applyOps: async (ops) => {
      const bad = ops.map((o) => o.op).filter((op) => !SUPPORTED_OPS.includes(op));
      if (bad.length) throw new Error(`unsupported operation ${bad[0]}`);

      for (const op of ops) {
        if (op.op === 'addTab') {
          if (tabs.has(op.tab)) throw new Error(`tab "${op.tab}" already exists`);
          tabs.set(op.tab, { gid: nextGid++, grid: [], frozenRows: op.frozenRows, widths: [], validations: [] });
        } else if (op.op === 'writeRange') {
          write(op.range, op.values);
        } else if (op.op === 'formatTab') {
          const tab = need(op.tab);
          tab.widths = op.widths || [];
          tab.validations = op.validations || [];
          tab.frozenRows = op.frozenRows;
        }
      }
      return { applied: ops.length };
    },

    // --- inspection, for tests -------------------------------------------
    _tabs: tabs,
    _grid: (name) => (tabs.get(name)?.grid || []).map((r = []) => [...r]),
    _set: (name, row, col, value) => { (need(name).grid[row] ||= [])[col] = value; },
  };
}

function trimTrailingBlank(rows) {
  const out = [...rows];
  while (out.length && (out.at(-1) || []).every((c) => c === undefined || c === '')) out.pop();
  return out;
}
