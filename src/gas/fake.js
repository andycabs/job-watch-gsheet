// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// A spreadsheet that is not Google's.
//
// Enough of SpreadsheetApp to run the real code against: sheets, ranges,
// display values, growth past the grid's edge. It exists so the Apps Script
// half can be tested at all — Google's own runtime cannot be driven from a
// test suite, and code that can only be exercised by clicking a menu is code
// nobody exercises.
//
// Cells are strings, because getDisplayValues returns strings. Getting that
// wrong in a fake is how a test passes on a value the real sheet would hand
// back differently.
// ---------------------------------------------------------------------------

// Ranges arrive in three shapes: a single cell, a block, and — the one this
// first got wrong — an open-ended column range like `rules!A1:Z`, which is
// exactly what readRange builds. Sheets reads that to the bottom of the grid.
const A1 = /^'?([^'!]+)'?!([A-Z]+)(\d+)(?::([A-Z]+)(\d*))?$/;

const colNum = (letters) => {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
};

class FakeRange {
  constructor(sheet, row, col, rows, cols) {
    Object.assign(this, { sheet, row, col, rows, cols });
  }
  getDisplayValues() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const row = [];
      for (let c = 0; c < this.cols; c++) {
        const col = this.col + c;
        const raw = this.sheet.grid[this.row - 1 + r]?.[col - 1];
        // A cell carrying a checkbox displays FALSE when it is unticked, even
        // on a row nobody has touched. Modelling that is the difference
        // between a fake that agrees with Sheets and one that hides a bug:
        // without it every blank row looks blank, trailing rows get trimmed,
        // and an append lands at row 2 instead of row 1001.
        const checkbox = this.row - 1 + r > 0
          && this.sheet.validations.some((v) => v.col === col && v.rule && v.rule.type === 'boolean');
        row.push(raw === undefined || raw === null || raw === ''
          ? (checkbox ? 'FALSE' : '')
          : String(raw));
      }
      out.push(row);
    }
    return out;
  }
  setValues(values) {
    values.forEach((row, r) => {
      const target = (this.sheet.grid[this.row - 1 + r] ||= []);
      row.forEach((v, c) => { target[this.col - 1 + c] = String(v ?? ''); });
    });
    return this;
  }
  setDataValidation(rule) { this.sheet.validations.push({ col: this.col, rule }); return this; }
}

class FakeSheet {
  constructor(name, grid = [], gid = 100) {
    this.name = name;
    this.grid = grid.map((r) => [...r]);
    this.gid = gid;
    this.maxRows = Math.max(this.grid.length, 1000);
    this.maxColumns = 26;
    this.frozenRows = 0;
    this.widths = {};
    this.validations = [];
  }
  getName() { return this.name; }
  getSheetId() { return this.gid; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxColumns; }
  insertRowsAfter(_after, n) { this.maxRows += n; return this; }
  insertColumnsAfter(_after, n) { this.maxColumns += n; return this; }
  setFrozenRows(n) { this.frozenRows = n; return this; }
  setColumnWidth(i, w) { this.widths[i] = w; return this; }
  getRange(row, col, rows = 1, cols = 1) { return new FakeRange(this, row, col, rows, cols); }
}

class FakeSpreadsheet {
  constructor(tabs = {}, name = 'Test sheet') {
    this.timeZone = 'America/New_York';
    this.name = name;
    this.sheets = Object.entries(tabs).map(([n, grid], i) => new FakeSheet(n, grid, 100 + i));
  }
  getName() { return this.name; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/fake/edit'; }
  getSheets() { return this.sheets; }
  getSheetByName(name) { return this.sheets.find((s) => s.name === name) || null; }
  insertSheet(name) {
    const sheet = new FakeSheet(name, [], 100 + this.sheets.length);
    this.sheets.push(sheet);
    return sheet;
  }
  getRange(a1) {
    const m = A1.exec(String(a1));
    if (!m) throw new Error(`bad range ${a1}`);
    const sheet = this.getSheetByName(m[1]);
    if (!sheet) throw new Error(`no such tab ${m[1]}`);
    const startCol = colNum(m[2]);
    const startRow = Number(m[3]);
    const endCol = m[4] ? colNum(m[4]) : startCol;
    const endRow = m[5] ? Number(m[5]) : (m[4] ? sheet.getMaxRows() : startRow);
    return new FakeRange(sheet, startRow, startCol, endRow - startRow + 1, endCol - startCol + 1);
  }
  /**
   * Every real spreadsheet has one, and the daily run is scheduled against it.
   * The fake not having it is how "cannot read the time in null" got as far as
   * a test run.
   */
  getSpreadsheetTimeZone() { return this.timeZone; }

  /** What a tab holds, for a test to assert against. */
  grid(name) { return this.getSheetByName(name)?.grid ?? null; }
}

/** Installs the globals Apps Script provides. Returns a handle and a teardown. */
export function installFakes({ tabs = {}, timeZone = 'America/New_York', fetch: fetchImpl = () => { throw new Error('no fetch'); } } = {}) {
  const spreadsheet = new FakeSpreadsheet(tabs);
  spreadsheet.timeZone = timeZone;
  const slept = [];
  const mailed = [];

  const previous = {
    SpreadsheetApp: globalThis.SpreadsheetApp,
    UrlFetchApp: globalThis.UrlFetchApp,
    Utilities: globalThis.Utilities,
    MailApp: globalThis.MailApp,
    ScriptApp: globalThis.ScriptApp,
    PropertiesService: globalThis.PropertiesService,
  };

  globalThis.SpreadsheetApp = {
    getActive: () => spreadsheet,
    flush: () => {},
    newDataValidation: () => {
      const rule = { type: null, values: null };
      const builder = {
        requireCheckbox: () => { rule.type = 'boolean'; return builder; },
        requireValueInList: (v) => { rule.type = 'list'; rule.values = v; return builder; },
        build: () => rule,
      };
      return builder;
    },
  };
  globalThis.UrlFetchApp = { fetch: fetchImpl };

  // Triggers and script properties, because the daily run is the thing most
  // worth testing and the least possible to test by clicking.
  const triggers = [];
  const stored = new Map();
  const alerts = [];
  globalThis.ScriptApp = {
    getProjectTriggers: () => [...triggers],
    deleteTrigger: (t) => {
      const i = triggers.indexOf(t);
      if (i >= 0) triggers.splice(i, 1);
    },
    newTrigger: (handler) => {
      const spec = { handler, hour: null, days: null, hours: null };
      const builder = {
        timeBased: () => builder,
        atHour: (h) => { spec.hour = h; return builder; },
        everyDays: (d) => { spec.days = d; return builder; },
        everyHours: (h) => { spec.hours = h; return builder; },
        create: () => {
          const trigger = {
            getHandlerFunction: () => spec.handler,
            hour: spec.hour,
            days: spec.days,
            hours: spec.hours,
          };
          triggers.push(trigger);
          return trigger;
        },
      };
      return builder;
    },
  };
  globalThis.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (stored.has(k) ? stored.get(k) : null),
      setProperty: (k, v) => { stored.set(k, String(v)); },
      deleteProperty: (k) => { stored.delete(k); },
    }),
  };
  // The timezone database, for real. A fake answering from arithmetic would
  // agree with the code on every day of the year except the two that matter.
  globalThis.Utilities = {
    sleep: (ms) => slept.push(ms),
    formatDate: (date, tz, pattern) => {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', hour12: false,
      }).formatToParts(date).reduce((o, x) => (o[x.type] = x.value, o), {});
      const hour = parts.hour === '24' ? '00' : parts.hour;
      return pattern === 'yyyy-MM-dd'
        ? `${parts.year}-${parts.month}-${parts.day}`
        : String(Number(hour));
    },
  };
  globalThis.MailApp = {
    sendEmail: (msg) => mailed.push(msg),
    getRemainingDailyQuota: () => 100,
  };

  return {
    spreadsheet,
    slept,
    mailed,
    triggers,
    alerts,
    property: (k) => (stored.has(k) ? stored.get(k) : null),
    restore() { Object.assign(globalThis, previous); },
  };
}

export { FakeSpreadsheet };
