// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// The sheet, reached directly.
//
// The same four verbs every other backend implements — listTabs, headRows,
// getValues, applyOps — over SpreadsheetApp instead of HTTP. Running inside
// the spreadsheet, there is no web app to deploy, no URL to copy, no access
// setting to get wrong, and no token: the script is already the sheet.
//
// The bodies are the ones from apps-script/Code.gs, which have been reading
// and writing real spreadsheets for a while. Moving them here rather than
// rewriting keeps that mileage; what changes is that they are now a module the
// tests can drive with a fake, instead of code only Google can run.
//
// SpreadsheetApp is looked up when a call is made rather than when the file
// loads, so a test can stand one in and so importing this on Node is harmless.
// ---------------------------------------------------------------------------

const app = () => {
  const found = globalThis.SpreadsheetApp;
  if (!found) throw new Error('SpreadsheetApp is not available — this runs inside a spreadsheet');
  return found;
};

/** Trailing blank rows are an artefact of the grid's size, not data. */
export function trimGrid(rows) {
  const out = (rows || []).map((r) => [...r]);
  while (out.length && out[out.length - 1].every((c) => String(c ?? '').trim() === '')) out.pop();
  return out;
}

export function sheetClient(spreadsheet = null) {
  const ss = () => spreadsheet || app().getActive();

  return {
    kind: 'apps-script-bound',
    describe: () => `this spreadsheet (${ss().getName()})`,

    listTabs: () => ss().getSheets().map((s) => ({ name: s.getName(), gid: s.getSheetId() })),

    headRows: (names, rowCount = 3) => {
      const out = {};
      for (const name of names || []) {
        const sheet = ss().getSheetByName(name);
        if (!sheet) { out[name] = []; continue; }
        const rows = Math.min(rowCount, sheet.getMaxRows());
        out[name] = trimGrid(sheet.getRange(1, 1, rows, sheet.getMaxColumns()).getDisplayValues());
      }
      return out;
    },

    // A range naming a tab that does not exist throws; an empty answer is the
    // right one, because every caller is asking "what is there" and nothing is
    // a valid answer to that.
    getValues: (range) => {
      try {
        return trimGrid(ss().getRange(range).getDisplayValues());
      } catch {
        return [];
      }
    },

    applyOps: (ops = []) => {
      // The same three operations the other backends allow, refused by name
      // rather than ignored — a plan carrying something else is a bug in the
      // planner, and silently skipping it would hide that.
      const allowed = { addTab: 1, writeRange: 1, formatTab: 1 };
      for (const op of ops) {
        if (!allowed[op.op]) throw new Error(`refusing operation ${op.op}`);
      }

      for (const op of ops) {
        if (op.op === 'addTab') {
          if (!ss().getSheetByName(op.tab)) {
            const sheet = ss().insertSheet(op.tab);
            if (op.frozenRows) sheet.setFrozenRows(op.frozenRows);
          }
        } else if (op.op === 'writeRange') {
          writeRange(ss(), op.range, op.values);
        } else if (op.op === 'formatTab') {
          formatTab(ss(), op);
        }
      }

      app().flush();
      return { applied: ops.length };
    },
  };
}

/**
 * A write that grows the sheet rather than failing at its edge.
 *
 * A new spreadsheet is 1000 rows. A watch that finds the 1001st posting must
 * not fail, and must not quietly write 1000 of them either.
 */
export function writeRange(ss, range, values) {
  const rows = values.length;
  const cols = rows ? values[0].length : 0;
  if (!rows || !cols) return;

  const [tabName, cells] = String(range).split('!');
  const sheet = ss.getSheetByName(String(tabName).replace(/^'|'$/g, ''));
  if (!sheet) throw new Error(`no such tab "${tabName}"`);

  const first = String(cells).split(':')[0];
  const startRow = Number(first.replace(/[^0-9]/g, ''));
  const startCol = columnNumber(first.replace(/[0-9]/g, ''));

  const needRows = startRow + rows - 1;
  const needCols = startCol + cols - 1;
  if (needRows > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), needRows - sheet.getMaxRows());
  if (needCols > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), needCols - sheet.getMaxColumns());

  sheet.getRange(startRow, startCol, rows, cols).setValues(values);
}

/** "A" -> 1, "AA" -> 27. */
export function columnNumber(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n || 1;
}

/** Widths, dropdowns, frozen header, and the warning-only protections. */
export function formatTab(ss, op) {
  const sheet = ss.getSheetByName(op.tab);
  if (!sheet) return;

  if (op.frozenRows) sheet.setFrozenRows(op.frozenRows);
  (op.widths || []).forEach((w, i) => sheet.setColumnWidth(i + 1, w));

  for (const v of op.validations || []) {
    const range = sheet.getRange(2, v.column + 1, Math.max(sheet.getMaxRows() - 1, 1), 1);
    const builder = app().newDataValidation();
    const rule = v.type === 'boolean'
      ? builder.requireCheckbox().build()
      : builder.requireValueInList(v.values || [], true).build();
    range.setDataValidation(rule);
  }
}
