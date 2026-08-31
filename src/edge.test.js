#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// Adversarial tests: the sheet as people actually leave it, and the payloads
// boards actually return.
//
// Every case here is a way the tool can be wrong without appearing to be. The
// unit tests check that each part does its job on reasonable input; these check
// what happens on the input nobody intended.
// ---------------------------------------------------------------------------
import { TABS, headers, resolveWriteRange, rowInSheetOrder, readRange, colLetter, columnIndex } from './sheet/schema.js';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { planSync, buildRecord, UNTRIAGED, CLOSED } from './sync.js';
import { readSheetState } from './sheet/apply.js';
import { planBootstrap, auditSheet } from './sheet/bootstrap.js';
import { triage } from './triage.js';
import { planDiscoveryWrites, slugVariants, probeOrder } from './probe.js';
import { parseRules, parseCompanies, parseSettings, readConfig } from './sheet/read.js';
import { compileRules } from './rules.js';
import { matchJob } from './match.js';
import { extractSalary, evaluateSalary } from './salary.js';
import { scoreJob } from './score.js';
import { discordPayload, notify } from './notify.js';
import { countPhrases } from './phrases.js';
import { planTemplateRows } from './template-plan.js';
import { memoryClient } from './sheet/memory.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const NOW = new Date('2026-08-29T09:00:00Z');
const SETTINGS = {
  salaryFloor: null, unpriced: 'keep', closeAfterDays: 7, stalePostingDays: 60,
  seniorityTarget: [], weightTitle: 40, weightSalary: 25, weightSeniority: 20, weightFreshness: 15,
};
const RULES = compileRules({ title: ['staff engineer'] });
const COMPANY = { name: 'ClickUp', slug: 'clickup' };
const HEAD = headers(TABS.matches);
const job = (over = {}) => ({
  id: '1', title: 'Staff Engineer', location: 'Remote', url: 'https://x/1',
  postedAt: '2026-08-28', body: '', ...over,
});

// ===========================================================================
console.log('=== a sheet people have edited ===');
// ===========================================================================
{
  // The one that matters: someone adds a column of their own. Reads find
  // columns by name; if writes used schema positions they would land one
  // column left and overwrite it.
  const drifted = [...HEAD];
  drifted.splice(2, 0, 'My priority');
  const row = new Array(drifted.length).fill('');
  row[0] = 'Interested'; row[1] = 'my note'; row[2] = 'HIGH';
  row[drifted.indexOf('Key')] = 'clickup:1';
  row[drifted.indexOf('First seen')] = '2026-08-01';

  const rec = buildRecord({ job: job(), company: COMPANY, settings: SETTINGS }, NOW);
  const plan = planSync([drifted, row], [rec], { settings: SETTINGS, now: NOW });

  check('the write moves with the inserted column',
    plan.operations[0].range === 'matches!D2:T2', plan.operations[0].range);

  const sheet = memoryClient({ matches: [drifted, row] });
  await sheet.applyOps(plan.operations);
  const after = sheet._grid('matches')[1];
  check('the inserted column survives', after[2] === 'HIGH', after[2]);
  check('so does the status', after[0] === 'Interested');
  check('and the note', after[1] === 'my note');
  check('while the script columns still update', after[drifted.indexOf('Company')] === 'ClickUp');
  check('and first seen is still preserved', after[drifted.indexOf('First seen')] === '2026-08-01');
}
{
  // Reads run wider than the schema, so a header row comes back padded with
  // blank cells. A schema upgrade compares header lengths to decide whether
  // columns were added — and a padded row is longer than the schema, so the
  // upgrade silently never fired and setup reported "nothing to do" while the
  // audit reported the columns missing.
  const older = HEAD.slice(0, HEAD.length - 2);
  const padded = [...older, ...Array(26 - older.length).fill('')];
  const sheet = memoryClient({ matches: [padded, Array(padded.length).fill('x')] });
  const state = await readSheetState(sheet);
  check('the header is measured at its real width',
    state.headers.matches.length === older.length,
    `${state.headers.matches.length} vs ${older.length}`);

  const plan = planBootstrap(state);
  check('so a schema upgrade is planned', plan.extended.length === 1, JSON.stringify(plan.extended));
  check('and names the new columns',
    plan.extended[0].columns.join(', ') === 'Changed, Pay rank', plan.extended[0].columns.join(', '));
  check('the summary says so', /added Changed, Pay rank/.test(plan.summary), plan.summary);

  await sheet.applyOps(plan.operations);
  check('the header now carries them', sheet._grid('matches')[0].includes('Pay rank'));
  check('and the audit is clean afterwards',
    auditSheet(await readSheetState(sheet)).ok);
}
{
  // The twin of the write bug. Reading exactly the schema's width means one
  // inserted column pushes Key outside the read, every row then looks
  // keyless, and every posting re-appends on every run — forever.
  const drifted = [...HEAD];
  drifted.splice(2, 0, 'My priority');
  const row = new Array(drifted.length).fill('');
  row[drifted.indexOf('Key')] = 'clickup:1';
  const sheet = memoryClient({ matches: [drifted, row] });

  const wide = await sheet.getValues(readRange(TABS.matches));
  check('the read is wider than the schema', wide[0].length === drifted.length, String(wide[0].length));
  check('so Key is still read', wide[0].includes('Key'));

  const rec = buildRecord({ job: job(), company: COMPANY, settings: SETTINGS }, NOW);
  const plan = planSync(wide, [rec], { settings: SETTINGS, now: NOW });
  check('and the row updates instead of duplicating',
    plan.updated === 1 && plan.added === 0, plan.summary);
}
{
  check('the read range leaves room for inserted columns',
    readRange(TABS.matches).endsWith('!A1:Z'), readRange(TABS.matches));
  check('every tab reads at least as wide as its schema',
    Object.values(TABS).every((t) => t.columns.length <= 26));
}
{
  // A column deleted outright: refuse rather than write to the wrong cells.
  const missing = HEAD.filter((h) => h !== 'Score');
  const rec = buildRecord({ job: job(), company: COMPANY, settings: SETTINGS }, NOW);
  const plan = planSync([missing], [rec], { settings: SETTINGS, now: NOW });
  check('a missing column stops the write', plan.operations.length === 0);
  check('and says which one', /no "Score" column/.test(plan.problems[0]), plan.problems[0]);
  check('and says what to do', /re-run setup/i.test(plan.problems[0]));
}
{
  // A user column dragged into the middle of the script block.
  const moved = HEAD.filter((h) => h !== 'Note');
  moved.splice(5, 0, 'Note');
  const rec = buildRecord({ job: job(), company: COMPANY, settings: SETTINGS }, NOW);
  const plan = planSync([moved], [rec], { settings: SETTINGS, now: NOW });
  check('a user column inside the block stops the write', plan.operations.length === 0);
  check('and names it as the user\'s own', /"Note" is yours/.test(plan.problems[0]), plan.problems[0]);
}
{
  // Clearing the Key cell is the one way of damaging this sheet that costs
  // work and says nothing: the row is orphaned, the posting re-appends as a
  // second row, and the original sits there with someone's triage on it,
  // never updating and looking live.
  const withKey = TABS.matches.columns.map((c) =>
    (c.key === 'key' ? 'clickup:1' : c.key === 'status' ? 'Interested' : c.key === 'company' ? 'ClickUp' : ''));
  const cleared = withKey.map((v, i) => (i === columnIndex(TABS.matches, 'key') ? '' : v));

  const plan = planSync([HEAD, cleared], [], { settings: SETTINGS, now: NOW });
  check('a row with no Key is reported', plan.problems.some((p) => /no Key/.test(p)),
    plan.problems.join(' | '));
  check('and names the row number', plan.problems.some((p) => /\(2\)/.test(p)));
  check('and says what will happen', plan.problems.some((p) => /come back as new rows/.test(p)));
  check('and what to do about it', plan.problems.some((p) => /restore the Key|delete the row/.test(p)));

  // A blank row is blank, not damaged.
  const blank = new Array(HEAD.length).fill('');
  check('an empty row is not reported as keyless',
    !planSync([HEAD, blank], [], { settings: SETTINGS, now: NOW }).problems.some((p) => /no Key/.test(p)));
  check('a row with its key intact is not reported',
    !planSync([HEAD, withKey], [], { settings: SETTINGS, now: NOW }).problems.some((p) => /no Key/.test(p)));
}
{
  // Someone copies a row. Only one can be kept current; say so.
  const dup = (key) => TABS.matches.columns.map((c) =>
    (c.key === 'key' ? key : c.key === 'status' ? UNTRIAGED : ''));
  const plan = planSync([HEAD, dup('clickup:1'), dup('clickup:1')], [], { settings: SETTINGS, now: NOW });
  check('a duplicated key is reported', plan.problems.some((p) => /appear twice/.test(p)),
    plan.problems.join(' | '));
}
{
  // An empty sheet with no header at all — the tab exists but setup never ran.
  const rec = buildRecord({ job: job(), company: COMPANY, settings: SETTINGS }, NOW);
  const plan = planSync([], [rec], { settings: SETTINGS, now: NOW });
  check('an unheadered tab still works off the schema', plan.added === 1, plan.summary);
}

// ===========================================================================
console.log('\n=== postings boards actually return ===');
// ===========================================================================
{
  // Rows are keyed on the posting id. Without one, two postings become one
  // row that overwrites itself.
  const jobs = [
    job({ id: undefined, title: 'Staff Engineer A' }),
    job({ id: '', title: 'Staff Engineer B' }),
    job({ id: null, title: 'Staff Engineer C' }),
    job({ id: '4', title: 'Staff Engineer D' }),
  ];
  const { matches, skipped } = triage(jobs, COMPANY, { rules: RULES, settings: SETTINGS }, NOW);
  check('postings with no id are skipped, not merged', matches.length === 1, String(matches.length));
  check('and counted', skipped.length === 3, String(skipped.length));
  check('the one with an id survives', matches[0].key === 'clickup:4');
  check('no key ever contains "undefined"', !matches.some((m) => /undefined/.test(m.key)));
}
{
  const nasty = [
    null, undefined, {}, { id: '1' }, { id: '2', title: null },
    { id: '3', title: 'Staff Engineer', location: null, body: null, url: null, postedAt: 'not a date' },
    { id: '4', title: 'Staff Engineer', compensation: { compensationTiers: [null] } },
    { id: '5', title: 'x'.repeat(5000), body: 'y'.repeat(200000) },
  ];
  let threw = null;
  try { triage(nasty, COMPANY, { rules: RULES, settings: SETTINGS }, NOW); }
  catch (e) { threw = e.message; }
  check('a malformed payload does not stop the run', threw === null, threw || '');
}
{
  const r = triage([{ id: '3', title: 'Staff Engineer', postedAt: 'not a date' }],
    COMPANY, { rules: RULES, settings: SETTINGS }, NOW);
  check('an unparseable date leaves the age blank rather than NaN',
    r.matches[0].age === '' && !/NaN/.test(JSON.stringify(r.matches[0])), r.matches[0].age);
}
{
  const s = scoreJob({ job: job({ postedAt: '2027-01-01' }), verdict: matchJob(job(), RULES),
    salary: null, settings: SETTINGS }, NOW);
  check('a posting dated in the future scores in range', s.score >= 0 && s.score <= 100, String(s.score));
}
{
  // A title that is also a formula, and one that could ping a chat server.
  const rec = buildRecord({ job: job({ title: '=HYPERLINK("evil")' }), company: COMPANY, settings: SETTINGS }, NOW);
  check('a formula title is carried as text', rec.title.startsWith('='));
  const { content, allowed_mentions } = discordPayload([
    { ...rec, company: '@everyone', score: 1 },
  ]);
  check('and a mention in a digest cannot ping anyone',
    JSON.stringify(allowed_mentions.parse) === '[]' && content.includes('@everyone'));
}

// ===========================================================================
console.log('\n=== files people import ===');

// ===========================================================================
console.log('\n=== settings people type ===');
// ===========================================================================
{
  const rows = [headers(TABS.settings),
    ['salary floor', '-50000', ''],
    ['close after days', '-3', ''],
    ['stale posting days', '0', ''],
    ['weight: title match', '-40', ''],
  ];
  const { settings } = parseSettings(rows);
  check('a negative floor is read as given, not crashed on', settings.salaryFloor === -50000);
  check('a negative close-after does not close everything',
    planSync([HEAD], [], { settings: { ...SETTINGS, closeAfterDays: -3 }, now: NOW }).closed === 0);
  check('a zero stale threshold does not divide by zero',
    Number.isFinite(scoreJob({ job: job(), verdict: matchJob(job(), RULES), salary: null,
      settings: { ...SETTINGS, stalePostingDays: 0 } }, NOW).score));
}
{
  const huge = parseSettings([headers(TABS.settings), ['salary floor', '999999999999', '']]);
  check('an absurd floor is survivable', Number.isFinite(huge.settings.salaryFloor));
  const r = evaluateSalary({ body: 'Base salary $150,000 - $180,000' },
    { salaryFloor: 999999999999 });
  check('and simply drops everything', r.verdict === 'below');
}
{
  let threw = null;
  try {
    parseRules(null); parseCompanies(null); parseSettings(null);
    parseRules(undefined); parseCompanies({}); parseSettings('nonsense');
    parseRules([[], []]); parseCompanies([['Active'], []]);
    planSync(null, null, {}); planSync(undefined, [], {});
  } catch (e) { threw = e.message; }
  check('malformed tabs are survivable', threw === null, threw || '');
}

// ===========================================================================
console.log('\n=== rules people write ===');
// ===========================================================================
{
  const rules = compileRules({ title: ['/(a+)+$/'], exclude: ['/[/'] });
  check('a broken regex is reported, not thrown', rules.problems.length > 0);
  check('and the rest of the set still compiles', Array.isArray(rules.title));
}
{
  // A rule matching everything, and one matching nothing.
  const all = compileRules({ title: ['/.*/'] });
  check('a catch-all rule matches', matchJob(job(), all).matched);
  const none = compileRules({ title: ['/(?!)/'] });
  check('an impossible rule matches nothing', !matchJob(job(), none).matched);
}
{
  const rules = compileRules({ title: ['staff engineer'], exclude: ['/.*/'] });
  check('an exclusion matching everything excludes everything',
    matchJob(job(), rules).stage === 'excluded');
  check('and reports what it cost',
    /matched "staff engineer"/.test(matchJob(job(), rules).reason),
    matchJob(job(), rules).reason);
}
{
  const long = 'x'.repeat(10000);
  let threw = null;
  const started = Date.now();
  try { matchJob(job({ title: long, body: long }), compileRules({ title: ['staff engineer'], body: ['kubernetes'] })); }
  catch (e) { threw = e.message; }
  check('a very long posting matches promptly', threw === null && Date.now() - started < 1000,
    threw || `${Date.now() - started}ms`);
}

// ===========================================================================
console.log('\n=== salary text in the wild ===');
// ===========================================================================
{
  const cases = [
    ['$0 - $0', null],
    ['Salary: $1', null],
    ['$100,000,000 valuation', null],
    ['between $150,000 and $200,000', 200000],
    ['$150K-$200K', 200000],
    ['150000-200000 USD per year', 200000],
  ];
  for (const [body, expected] of cases) {
    const s = extractSalary({ body });
    check(`"${body.slice(0, 34)}" → ${expected ?? 'nothing'}`,
      (s?.max ?? null) === expected, JSON.stringify(s));
  }
}
{
  let threw = null;
  try {
    extractSalary({ body: '$'.repeat(20000) });
    extractSalary({ body: '1,'.repeat(20000) });
    extractSalary({ body: Array(500).fill('$100,000 - $200,000').join(' and ') });
  } catch (e) { threw = e.message; }
  check('pathological salary text is survivable', threw === null, threw || '');
}

// ===========================================================================
console.log('\n=== discovery and imports at the edges ===');
// ===========================================================================
{
  check('a company with no name yields nothing to probe', probeOrder({ name: '' }).length === 0);
  check('and a symbols-only name too', slugVariants('!!!').length === 0);
  check('a very long name still yields candidates', slugVariants('A'.repeat(200)).length > 0);
}
{
  const writes = planDiscoveryWrites([{ row: 2, ats: 'lever', slug: 'x' }], '2026-08-29');
  check('discovery writes only script columns', /^companies!E2:G2$/.test(writes[0].range), writes[0].range);
}

// ===========================================================================
console.log('\n=== notifications ===');
// ===========================================================================
{
  const r = await notify([{ key: 'a', company: 'X', title: 'Y' }], {
    env: { DISCORD_WEBHOOK_URL: 'https://x' },
    fetchImpl: async () => { throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }); },
  });
  check('a timeout is survivable', r.sent.length === 0);
}
{
  const weird = [{ key: 'a', company: undefined, title: undefined, url: undefined, score: NaN }];
  const { content } = discordPayload(weird);
  check('missing fields never print undefined or NaN',
    !/undefined|NaN/.test(content), content);
}

// ===========================================================================
console.log('\n=== a full round trip on a lived-in sheet ===');
// ===========================================================================
{
  const sheet = memoryClient({
    rules: [headers(TABS.rules), ['TRUE', 'title', 'staff engineer', 'mine']],
    companies: [headers(TABS.companies), ['TRUE', 'ClickUp', '', '', 'ashby', 'clickup', '']],
    settings: [headers(TABS.settings), ['salary floor', '100k', ''], ['location mode', 'any', '']],
    matches: [HEAD],
  });
  const config = await readConfig(sheet);
  check('the configuration reads clean', config.problems.length === 0, config.problems.join('; '));

  const { matches } = triage([job({ body: 'Base salary $200,000 - $250,000' })],
    config.companies.ready[0], config, NOW);
  const plan = planSync(sheet._grid('matches'), matches, { settings: config.settings, now: NOW });
  await sheet.applyOps(plan.operations);

  // Someone triages it, then the posting disappears from the board.
  sheet._set('matches', 1, 0, 'Applied');
  const gone = planSync(sheet._grid('matches'), [], {
    settings: { ...config.settings, closeAfterDays: 0 }, now: NOW,
  });
  check('a triaged row is never closed, however long it is gone', gone.closed === 0);

  // And an untriaged one, long unseen, is.
  sheet._set('matches', 1, 0, UNTRIAGED);
  sheet._set('matches', 1, HEAD.indexOf('Last seen'), '2026-01-01');
  const closed = planSync(sheet._grid('matches'), [], { settings: config.settings, now: NOW });
  await sheet.applyOps(closed.operations);
  check('an untriaged one long gone is closed', sheet._grid('matches')[1][0] === CLOSED,
    sheet._grid('matches')[1][0]);
  check('and nothing else on the row moved',
    sheet._grid('matches')[1][HEAD.indexOf('Company')] === 'ClickUp');
}

// ===========================================================================
console.log('\n=== running out of room, and running twice ===');

// ===========================================================================
console.log('\n=== the repository contains what the code needs ===');

// ===========================================================================
console.log('\n=== the README describes the menu the sheet actually has ===');
// ===========================================================================
{
  // Against the built file, not the retired web-app script: Code.gs is
  // what people paste into a spreadsheet, so its menu is the one they see.
  const gs = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

  const items = [...gs.matchAll(/\.addItem\('([^']+)'/g)].map((m) => m[1]);
  check('the menu has items to document', items.length >= 10, `found ${items.length}`);

  for (const item of items) {
    // Google renders a trailing "..." as an ellipsis, and the README uses one.
    const shown = item.replace(/…$|\.\.\.$/, '').trim();
    check(`README mentions "${shown}"`, readme.includes(shown));
  }
}

// ===========================================================================
console.log('\n=== the docs agree with the code ===');
// ===========================================================================
{
  // Both of these were wrong at once: the README promised five tabs when there
  // were seven, and claimed 90 catalogue companies after it grew to 352. A
  // number in prose has no way to notice it has gone stale.
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const dir = JSON.parse(readFileSync(new URL('../data/directory.json', import.meta.url), 'utf8'));

  // The number, however it is phrased. A count written in prose has no way to
  // notice it has gone stale, and this one was wrong once already.
  check(`README states the catalogue size (${dir.entries.length})`,
    new RegExp(`${dir.entries.length}[^\\n]{0,40}companies`).test(readme),
    'the count in the prose has drifted from data/directory.json');

  for (const name of Object.keys(TABS)) {
    check(`README names the ${name} tab`, new RegExp(`\\b${name}\\b`).test(readme));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
