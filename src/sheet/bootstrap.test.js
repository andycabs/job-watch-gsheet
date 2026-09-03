#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Offline tests for the sheet schema and bootstrap planner. No credentials.
//
// The safety property being protected here is the one v1 got right by
// accident and this version encodes deliberately: a sync must be structurally
// unable to overwrite what a person typed.
import {
  TABS, TAB_NAMES, colLetter, headers, userColumns, scriptColumns,
  scriptRange, assertUserColumnsFirst, seedRow, protectedBlocks, USER, SCRIPT,
} from './schema.js';
import { planBootstrap, auditSheet, } from './bootstrap.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

// --- the invariant ---------------------------------------------------------
console.log('--- column ownership ---');
{
  let err = null;
  try { assertUserColumnsFirst(); } catch (e) { err = e; }
  check('no tab interleaves user and script columns', err === null, err?.message);

  // The property that makes it matter: on the upsert tab, the writable range
  // starts after every user column.
  const matches = TABS.matches;
  const range = scriptRange(matches, 7);
  const firstScriptIdx = matches.columns.findIndex((c) => c.owner === SCRIPT);
  check('matches has a valid script range', range !== null, range);
  check('the range starts after the user columns',
    range.startsWith(`matches!${colLetter(firstScriptIdx)}7:`), range);
  check('Status is outside it', colLetter(0) === 'A' && !range.includes('!A'));
  check('user columns really are leftmost',
    matches.columns.slice(0, userColumns(matches).length).every((c) => c.owner === USER));
}
{
  // A tab that broke the rule must be rejected, not silently mis-ranged.
  const broken = {
    name: 'broken',
    columns: [
      { key: 'a', header: 'A', owner: SCRIPT },
      { key: 'b', header: 'B', owner: USER },
    ],
  };
  check('scriptRange refuses an interleaved tab', scriptRange(broken, 2) === null);
}

// --- column letters --------------------------------------------------------
console.log('\n--- ranges ---');
check('colLetter(0) is A', colLetter(0) === 'A');
check('colLetter(25) is Z', colLetter(25) === 'Z');
check('colLetter(26) is AA', colLetter(26) === 'AA');
check('the widest tab fits in single letters',
  Math.max(...TAB_NAMES.map((n) => TABS[n].columns.length)) <= 26);

// --- schema sanity ---------------------------------------------------------
console.log('\n--- schema ---');
for (const name of TAB_NAMES) {
  const tab = TABS[name];
  check(`${name}: has a purpose`, Boolean(tab.purpose));
  const keys = tab.columns.map((c) => c.key);
  check(`${name}: column keys are unique`, new Set(keys).size === keys.length);
  const hdrs = headers(tab);
  check(`${name}: headers are unique`, new Set(hdrs).size === hdrs.length);
  check(`${name}: every column has an owner`,
    tab.columns.every((c) => c.owner === USER || c.owner === SCRIPT));
}
{
  const m = TABS.matches;
  check('matches: Status is user-owned', m.columns[0].key === 'status' && m.columns[0].owner === USER);
  check('matches: Status has a dropdown', m.columns[0].validation?.type === 'list');
  check('matches: Status defaults to Not reviewed', m.columns[0].initial === 'Not reviewed');
  check('matches: the default is a valid dropdown option',
    m.columns[0].validation.values.includes(m.columns[0].initial));
  check('matches: has a key column for upserts', m.columns.some((c) => c.key === 'key'));
  check('matches: tracks lastSeen for staleness', m.columns.some((c) => c.key === 'lastSeen'));
  check('matches: has a score column', m.columns.some((c) => c.key === 'score'));
  // One band, plus a note of what it is. A figure with no stated basis is a
  // number nobody can check.
  for (const key of ['salaryMin', 'salaryMax', 'salaryBasis']) {
    check(`matches: records ${key}`, m.columns.some((c) => c.key === key));
  }
  check('matches: no separate OTE columns survive',
    !m.columns.some((c) => /^(base|ote)(Min|Max)$/.test(c.key)),
    m.columns.map((c) => c.key).join(','));
  const floor = TABS.settings.seed.find((r) => r.setting === 'salary floor');
  check('settings: the floor says what it is compared against',
    /top of the stated range/.test(floor.note), floor.note);
}
{
  const c = TABS.companies;
  const ats = c.columns.find((x) => x.key === 'ats');
  check('companies: ATS is a dropdown of real adapters', ats.validation.values.length === 6);
  check('companies: name is user-owned', c.columns.find((x) => x.key === 'name').owner === USER);
}

// --- seed rows -------------------------------------------------------------
console.log('\n--- seeds ---');
for (const name of TAB_NAMES) {
  const tab = TABS[name];
  if (!tab.seed?.length) continue;
  const widths = tab.seed.map((s) => seedRow(tab, s).length);
  check(`${name}: seed rows are full width`,
    widths.every((w) => w === tab.columns.length), `${widths.join(',')} vs ${tab.columns.length}`);
}
{
  // Seeds must be self-evidently examples, not data someone might act on.
  const co = TABS.companies.seed[0];
  check('companies seed is obviously a placeholder', /example/i.test(co.name), co.name);
  check('companies seed leaves ATS blank, to demo discovery', !co.ats);
  const rule = TABS.rules.seed.find((s) => /example/i.test(s.note || ''));
  check('rules seed is labelled as an example', Boolean(rule));
}
{
  // The settings tab carries its own documentation.
  const undocumented = TABS.settings.seed.filter((s) => !s.note);
  check('every setting explains itself', undocumented.length === 0,
    undocumented.map((s) => s.setting).join(', '));
  const weights = TABS.settings.seed.filter((s) => s.setting.startsWith('weight:'));
  check('all four scoring weights are present', weights.length === 4,
    weights.map((w) => w.setting).join(', '));
  check('the weights total 100',
    weights.reduce((n, w) => n + Number(w.value), 0) === 100,
    String(weights.reduce((n, w) => n + Number(w.value), 0)));
}

// --- planning: empty sheet -------------------------------------------------
console.log('\n--- bootstrap: empty sheet ---');
{
  const plan = planBootstrap({ existingTabs: [] });
  check('creates every tab', plan.created.length === TAB_NAMES.length, plan.created.join(', '));
  check('writes headers for each', plan.operations.filter((o) => o.op === 'writeRange' && o.range.includes('A1:')).length === TAB_NAMES.length);
  check('formats each new tab', plan.operations.filter((o) => o.op === 'formatTab').length === TAB_NAMES.length);
  check('seeds the tabs that have examples', plan.seeded.length > 0, plan.seeded.join(', '));
  check('never clears or deletes', !plan.operations.some((o) => /clear|delete/i.test(o.op)));
  check('summary reads sensibly', plan.summary.includes('created'), plan.summary);

  const validated = plan.operations.filter((o) => o.op === 'formatTab' && o.validations.length);
  check('carries validation rules through', validated.length >= 3, `${validated.length} tabs`);
}

// --- planning: re-run on a live sheet --------------------------------------
console.log('\n--- bootstrap: re-run ---');
{
  const populated = Object.fromEntries(TAB_NAMES.map((n) => [n, true]));
  const plan = planBootstrap({ existingTabs: TAB_NAMES, populated });
  check('does nothing to a complete sheet', plan.operations.length === 0, `${plan.operations.length} ops`);
  check('and says so', plan.summary.includes('already set up'), plan.summary);
}
{
  // Re-seeding a tab someone has filled in would clobber real work.
  const populated = Object.fromEntries(TAB_NAMES.map((n) => [n, true]));
  const plan = planBootstrap({ existingTabs: TAB_NAMES, populated });
  check('never re-seeds a populated tab', plan.seeded.length === 0);
}
{
  // A schema upgrade: a tab added in a later version appears on an existing sheet.
  const older = TAB_NAMES.filter((n) => n !== 'dropped');
  const populated = Object.fromEntries(older.map((n) => [n, true]));
  const plan = planBootstrap({ existingTabs: older, populated });
  check('adds only the missing tab', plan.created.length === 1 && plan.created[0] === 'dropped');
  check('and leaves the others alone',
    !plan.operations.some((o) => o.range && !o.range.startsWith('dropped') && !o.tab));
}
{
  // A tab with headers but no data rows — the resting state of `matches`
  // between runs — must not be treated as needing its headers written again.
  const headed = Object.fromEntries(TAB_NAMES.map((n) => [n, true]));
  const plan = planBootstrap({ existingTabs: TAB_NAMES, headed, populated: {} });
  check('a headed but empty tab is not re-headered', plan.headered.length === 0,
    plan.headered.join(', '));
  check('but an empty one still gets its examples', plan.seeded.length > 0, plan.seeded.join(', '));
  check('and the summary mentions only the examples',
    !plan.summary.includes('headers'), plan.summary);
}
{
  // An existing but empty tab still gets headers and examples.
  const plan = planBootstrap({ existingTabs: ['rules'], populated: {} });
  check('an empty existing tab gets headers',
    plan.operations.some((o) => o.range === `rules!A1:${colLetter(TABS.rules.columns.length - 1)}1`));
  check('and does not get re-created', !plan.created.includes('rules'));
}

// --- audit -----------------------------------------------------------------
console.log('\n--- audit ---');
{
  const ok = auditSheet({
    existingTabs: TAB_NAMES,
    headers: Object.fromEntries(TAB_NAMES.map((n) => [n, headers(TABS[n])])),
  });
  check('a correct sheet passes', ok.ok, ok.problems.join('; '));

  const missingTab = auditSheet({ existingTabs: TAB_NAMES.filter((n) => n !== 'matches') });
  check('a missing tab is reported', !missingTab.ok && missingTab.problems[0].includes('matches'));

  const missingCol = auditSheet({
    existingTabs: TAB_NAMES,
    headers: { ...Object.fromEntries(TAB_NAMES.map((n) => [n, headers(TABS[n])])), matches: ['Status', 'Note'] },
  });
  check('a deleted column is reported', !missingCol.ok);
  check('and names what is missing', missingCol.problems.some((p) => p.includes('Score')), missingCol.problems[0]);
}

// --- the help reaches the sheet -------------------------------------------
console.log('\n--- column help ---');
{
  // It used to exist only in the schema, rendered by a function with no
  // callers. A person wondering what a column was for had nowhere to look,
  // which is how "what is title-hint?" became a question somebody had to ask.
  const plan = planBootstrap({ existingTabs: [], reformat: true });
  const formats = plan.operations.filter((o) => o.op === 'formatTab');
  check('every tab is formatted', formats.length === TAB_NAMES.length, `${formats.length}`);

  const notes = formats.flatMap((o) => o.notes || []);
  check('columns carry notes', notes.length > 0, `${notes.length}`);
  check('each note names its column and explains it',
    notes.every((n) => typeof n.column === 'number' && String(n.text).includes('\n')));

  const rules = formats.find((o) => o.tab === 'rules');
  const kind = (rules.notes || []).find((n) => /^Kind\n/.test(n.text));
  check('the Kind column explains itself', Boolean(kind));
  check('including all four kinds',
    ['title —', 'body —', 'exclude —', 'title-hint —'].every((k) => kind.text.includes(k)));
  // The one that surprises people: a rule that matches nothing on its own.
  check('and says title-hint finds nothing alone', /on its own it finds nothing/i.test(kind.text));
  // The column most likely to be tidied away by somebody being helpful.
  check('the internal key column warns people off',
    notes.some((n) => /Do not edit/i.test(n.text)));
}

// --- protecting what nobody should be typing into ---------------------------
console.log('\n--- protection ---');
{
  const blocks = (name) => protectedBlocks(TABS[name]);

  // The tabs that are the user's own work are protected nowhere.
  check('rules is entirely theirs', blocks('rules').length === 0);
  check('so is companies', blocks('companies').length === 0);
  check('and dropped', blocks('dropped').length === 0);

  // Settings is a form: the names and the help are the question, the middle
  // column is the answer.
  const settings = blocks('settings');
  check('settings protects the names and the help, not the values',
    settings.length === 2 && settings[0].start === 0 && settings[1].start === 2,
    JSON.stringify(settings.map((b) => b.headers)));
  check('and leaves Value alone',
    !settings.some((b) => b.headers.includes('Value')));

  // The catalogue is shipped content: editing it is work that gets
  // overwritten, and deleting a row is undone on the next sync.
  const directory = blocks('directory');
  check('the directory protects everything but Add', directory.length === 1 && directory[0].start === 1);
  check('Add stays editable', !directory[0].headers.includes('Add'));

  // The one cell where a stray delete costs work silently.
  const matches = blocks('matches');
  check('matches protects only Key', matches.length === 1 && matches[0].headers.join() === 'Key');
  check('Status and Note are untouched',
    !matches.some((b) => b.headers.includes('Status') || b.headers.includes('Note')));
}
{
  // Contiguous runs, so each becomes one range rather than one per column.
  const tab = { name: 't', columns: [
    { key: 'a', header: 'A', owner: USER },
    { key: 'b', header: 'B', owner: USER, protect: true },
    { key: 'c', header: 'C', owner: USER, protect: true },
    { key: 'd', header: 'D', owner: USER },
    { key: 'e', header: 'E', owner: USER, protect: true },
  ] };
  const blocks = protectedBlocks(tab);
  check('adjacent protected columns become one block',
    blocks.length === 2 && blocks[0].start === 1 && blocks[0].end === 2,
    JSON.stringify(blocks));
  check('and a run ending at the last column is not lost',
    blocks[1].start === 4 && blocks[1].end === 4);
  check('a tab with nothing protected yields nothing',
    protectedBlocks({ name: 'x', columns: [{ key: 'a', header: 'A', owner: USER }] }).length === 0);
}
{
  // Formatting is applied when a tab is made; --reformat re-applies it to one
  // that already exists, which is how an older sheet gets protection at all.
  const all = Object.fromEntries(TAB_NAMES.map((n) => [n, true]));
  const quiet = planBootstrap({ existingTabs: TAB_NAMES, headed: all, populated: all });
  check('an ordinary re-run does not reformat', quiet.operations.length === 0, quiet.summary);

  const asked = planBootstrap({ existingTabs: TAB_NAMES, headed: all, populated: all, reformat: true });
  check('--reformat re-applies to every tab',
    asked.operations.filter((o) => o.op === 'formatTab').length === TAB_NAMES.length);
  check('and carries the protections',
    asked.operations.some((o) => o.protections?.length), 'no protections in the plan');
  check('it still writes no values', !asked.operations.some((o) => o.op === 'writeRange'));
  check('and says what it did', /re-applied formatting/.test(asked.summary), asked.summary);
}

console.log('\n--- a later version\'s new setting reaching an old sheet ---');
{
  // Seed rows are written only into an empty tab, which is right for the
  // example rules — nobody wants those back after deleting them. It was wrong
  // for settings: a setting added in a later release could never reach anyone
  // who set the tool up before it, so the release notes promising that `setup`
  // in apply mode brings you up to date were not true.
  const all = TABS.settings.seed.map((s) => s.setting);
  const older = all.slice(0, -1);
  const lived_in = (names) => ({
    existingTabs: [...TAB_NAMES],
    populated: Object.fromEntries(TAB_NAMES.map((n) => [n, true])),
    headed: Object.fromEntries(TAB_NAMES.map((n) => [n, true])),
    headers: Object.fromEntries(TAB_NAMES.map((n) => [n, headers(TABS[n])])),
    settingNames: names,
    rowCounts: { settings: names.length + 1 },
  });

  const plan = planBootstrap(lived_in(older));
  check('a missing setting is added to a sheet in daily use',
    String(plan.added) === all[all.length - 1], String(plan.added));

  const write = plan.operations.find((o) => o.op === 'writeRange' && o.range.startsWith('settings!'));
  check('it is appended below the existing rows',
    write?.range === `settings!A${older.length + 2}:C${older.length + 2}`, write?.range);
  check('and carries its documentation', (write?.values[0][2] || '').length > 20,
    'a setting arriving with no note is a cell nobody can act on');

  check('nothing to add means no write',
    planBootstrap(lived_in(all)).added.length === 0);
  check('and no settings write at all',
    !planBootstrap(lived_in(all)).operations.some((o) => o.op === 'writeRange' && o.range.startsWith('settings!')));

  // The rule is settings-only. Appending missing seed rows anywhere else would
  // put the example rules back after somebody deliberately deleted them.
  const other = planBootstrap(lived_in(older)).operations
    .filter((o) => o.op === 'writeRange' && !o.range.startsWith('settings!'));
  check('no other tab gets its seed rows re-added', other.length === 0,
    other.map((o) => o.range).join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
