#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Offline tests for scoring, the upsert, and the whole triage path.
//
// The property under test throughout is that a person's work survives. Triage
// typed into the sheet must outlive any number of runs, and the one place the
// script writes a user column must be provably narrow.
import { planSync, planDropped, buildRecord, jobKey, UNTRIAGED, CLOSED } from './sync.js';
import { scoreJob, explainScore, titleComponent, salaryComponent, seniorityComponent, freshnessComponent, ageInDays } from './score.js';
import { triage } from './triage.js';
import { compileRules } from './rules.js';
import { matchJob } from './match.js';
import { extractSalary } from './salary.js';
import { TABS, headers, columnIndex } from './sheet/schema.js';
import { memoryClient } from './sheet/memory.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const NOW = new Date('2026-08-29T09:00:00Z');
const COMPANY = { name: 'ClickUp', slug: 'clickup', ats: 'lever' };
const SETTINGS = {
  salaryFloor: null, unpriced: 'keep',
  closeAfterDays: 7, stalePostingDays: 60, seniorityTarget: [],
  weightTitle: 40, weightSalary: 25, weightSeniority: 20, weightFreshness: 15,
};
const RULES = compileRules({ title: ['staff engineer', 'head of revenue'] });
const job = (over = {}) => ({
  id: '1', title: 'Staff Engineer', location: 'Remote',
  url: 'https://x/1', postedAt: '2026-08-28', body: '', ...over,
});

// --- scoring ---------------------------------------------------------------
console.log('--- scoring ---');
{
  const verdict = matchJob(job(), RULES);
  const { score, parts } = scoreJob({ job: job(), verdict, salary: null, settings: SETTINGS }, NOW);
  check('a fresh title match scores well', score >= 70, String(score));
  check('the parts add up to the score',
    parts.reduce((n, p) => n + p.contribution, 0) === score);
  check('every weight is represented', parts.length === 4);
  check('the explanation is decomposable', /title match \d+/.test(explainScore({ score, parts })),
    explainScore({ score, parts }));
}
{
  check('no match scores zero on title', titleComponent({ matched: false }) === 0);
  check('a title signal beats a body one',
    titleComponent({ matched: true, signals: [{ tier: 'title' }] }) >
    titleComponent({ matched: true, signals: [{ tier: 'body' }] }));
}
{
  // An unconfigured signal must not drag every posting down.
  check('no floor set is neutral, not zero', salaryComponent(null, {}) === 0.5);
  check('unpriced is neutral, not zero', salaryComponent(null, { salaryFloor: 200000 }) === 0.5);
  check('no seniority target is neutral', seniorityComponent('Staff Engineer', {}) === 0.5);
  check('no posting date is neutral', freshnessComponent(null, SETTINGS, NOW) === 0.5);
}
{
  check('pay at the floor has no headroom',
    salaryComponent({ min: 200000, max: 200000 }, { salaryFloor: 200000 }) === 0);
  check('pay half again over the floor scores half',
    salaryComponent({ min: 300000, max: 300000 }, { salaryFloor: 200000 }) === 0.5);
  check('double the floor is the top of the scale',
    salaryComponent({ min: 200000, max: 300000 }, { salaryFloor: 150000 }) === 1);
  check('and beyond it does not run away',
    salaryComponent({ min: 9e5, max: 9e5 }, { salaryFloor: 100000 }) === 1);
}
{
  check('a targeted seniority scores full',
    seniorityComponent('VP of Revenue Operations', { seniorityTarget: ['vp', 'head of'] }) === 1);
  check('an untargeted one scores zero',
    seniorityComponent('Senior Analyst', { seniorityTarget: ['vp', 'head of'] }) === 0);
}
{
  check('posted today is fresh', freshnessComponent('2026-08-29', SETTINGS, NOW) === 1);
  check('freshness decays', freshnessComponent('2026-07-30', SETTINGS, NOW) < 1);
  check('and bottoms out at the stale threshold',
    freshnessComponent('2026-01-01', SETTINGS, NOW) === 0);
  check('a future date does not score over 1', freshnessComponent('2027-01-01', SETTINGS, NOW) === 1);
  check('age in days is right', ageInDays('2026-08-22', NOW) === 7);
}
{
  const zeroed = { ...SETTINGS, weightTitle: 0, weightSalary: 0, weightSeniority: 0, weightFreshness: 0 };
  const r = scoreJob({ job: job(), verdict: matchJob(job(), RULES), salary: null, settings: zeroed }, NOW);
  check('all-zero weights score zero rather than dividing by zero', r.score === 0);
}

// --- building a row --------------------------------------------------------
console.log('\n--- a row ---');
{
  const verdict = matchJob(job(), RULES);
  const salary = extractSalary({ body: 'The base salary range is $200,000 - $240,000.' });
  const score = scoreJob({ job: job(), verdict, salary, settings: SETTINGS }, NOW);
  const record = buildRecord({ job: job(), company: COMPANY, salary, verdict, score, settings: SETTINGS }, NOW);

  check('the key is company and posting', record.key === 'clickup:1');
  check('the band is recorded as numbers', record.salaryMin === 200000 && record.salaryMax === 240000);
  check('the salary reads for a human', record.salary === '$200k–240k', record.salary);
  check('the basis says what the figure is', /base/.test(record.salaryBasis), record.salaryBasis);
  check('which rules fired is recorded', record.matched.includes('staff engineer'), record.matched);
  check('age is in days', record.age === '1d', record.age);
  check('an old posting is flagged stale',
    buildRecord({ job: job({ postedAt: '2026-01-01' }), company: COMPANY, settings: SETTINGS }, NOW)
      .age.endsWith('— stale'));
}

// --- the upsert ------------------------------------------------------------
console.log('\n--- upsert ---');
const HEAD = headers(TABS.matches);
const rowFor = (over = {}) => {
  const r = TABS.matches.columns.map((c) => String(over[c.key] ?? ''));
  return r;
};
{
  const records = [buildRecord({ job: job(), company: COMPANY, settings: SETTINGS }, NOW)];
  const plan = planSync([HEAD], records, { settings: SETTINGS, now: NOW });
  check('a new posting is added', plan.added === 1 && plan.updated === 0);
  const write = plan.operations[0];
  check('starting at row 2', write.range.includes('A2:'), write.range);
  check('with Status seeded untriaged', write.values[0][0] === UNTRIAGED, write.values[0][0]);
  check('and an empty note', write.values[0][1] === '');
}
{
  // The row already exists and has been triaged.
  const existing = [HEAD, rowFor({
    status: 'Interested', note: 'spoke to the recruiter',
    key: 'clickup:1', firstSeen: '2026-08-01', lastSeen: '2026-08-28', score: '61',
  })];
  const records = [buildRecord({ job: job(), company: COMPANY, settings: SETTINGS }, NOW)];
  const plan = planSync(existing, records, { settings: SETTINGS, now: NOW });

  check('it is updated, not duplicated', plan.updated === 1 && plan.added === 0);
  const range = plan.operations[0].range;
  check('the write starts at the first script column', range.startsWith('matches!C2:'), range);
  check('so Status and Note are outside it', !/![AB]/.test(range));
  check('first seen is preserved from the row',
    plan.operations[0].values[0][columnIndex(TABS.matches, 'firstSeen') - 2] === '2026-08-01',
    JSON.stringify(plan.operations[0].values[0].slice(-5)));
}
{
  // Two runs, one sheet: the second must not re-add what the first added.
  const first = planSync([HEAD], [buildRecord({ job: job(), company: COMPANY, settings: SETTINGS }, NOW)],
    { settings: SETTINGS, now: NOW });
  const sheet = memoryClient({ matches: [HEAD] });
  await sheet.applyOps(first.operations);
  const after = sheet._grid('matches');
  const second = planSync(after, [buildRecord({ job: job(), company: COMPANY, settings: SETTINGS }, NOW)],
    { settings: SETTINGS, now: NOW });
  check('the second run updates rather than appends', second.added === 0 && second.updated === 1,
    second.summary);
}

// --- closing stale rows: the one user-column write -------------------------
console.log('\n--- closing rows that have gone ---');
{
  const gone = [HEAD,
    rowFor({ status: UNTRIAGED, key: 'clickup:99', lastSeen: '2026-08-01' }),   // 28 days, untouched
    rowFor({ status: 'Interested', key: 'clickup:98', lastSeen: '2026-08-01' }),// 28 days, triaged
    rowFor({ status: UNTRIAGED, key: 'clickup:97', lastSeen: '2026-08-27' }),   // 2 days, untouched
  ];
  const plan = planSync(gone, [], { settings: SETTINGS, now: NOW });

  check('an untouched, long-gone row is closed', plan.closed === 1, String(plan.closed));
  check('the triaged row is left alone', !plan.closedRows.some((r) => r.key === 'clickup:98'));
  check('the recently seen row is left alone', !plan.closedRows.some((r) => r.key === 'clickup:97'));

  const write = plan.operations.find((o) => o.values?.[0]?.[0] === CLOSED);
  check('the closing write is a single cell', write.range === 'matches!A2:A2', write.range);
  check('and writes nothing else', write.values.length === 1 && write.values[0].length === 1);
}
{
  // The guard is on what the sheet says now, not on what we last wrote.
  const triagedSinceLastRun = [HEAD, rowFor({ status: 'Applied', key: 'k', lastSeen: '2026-01-01' })];
  const plan = planSync(triagedSinceLastRun, [], { settings: SETTINGS, now: NOW });
  check('a row triaged between runs is never closed', plan.closed === 0);

  const typed = [HEAD, rowFor({ status: 'maybe later?', key: 'k', lastSeen: '2026-01-01' })];
  check('nor is one with a value someone typed themselves',
    planSync(typed, [], { settings: SETTINGS, now: NOW }).closed === 0);

  const off = [HEAD, rowFor({ status: UNTRIAGED, key: 'k', lastSeen: '2026-01-01' })];
  check('closing can be switched off entirely',
    planSync(off, [], { settings: { ...SETTINGS, closeAfterDays: null }, now: NOW }).closed === 0);
}
{
  // Nothing anywhere in a plan may write to a user column except that one cell.
  const mixed = [HEAD,
    rowFor({ status: UNTRIAGED, note: 'mine', key: 'clickup:1', firstSeen: '2026-08-01', lastSeen: '2026-08-01' }),
    rowFor({ status: UNTRIAGED, note: 'also mine', key: 'clickup:99', lastSeen: '2026-08-01' }),
  ];
  const plan = planSync(mixed, [buildRecord({ job: job(), company: COMPANY, settings: SETTINGS }, NOW)],
    { settings: SETTINGS, now: NOW });
  const touchesUserColumns = plan.operations.filter((o) => /![AB]/.test(o.range));
  check('exactly one operation touches a user column', touchesUserColumns.length === 1,
    touchesUserColumns.map((o) => o.range).join(', '));
  check('it is the closure, and it is one cell',
    touchesUserColumns[0].range === 'matches!A3:A3', touchesUserColumns[0].range);

  const sheet = memoryClient({ matches: mixed });
  await sheet.applyOps(plan.operations);
  check('the note on the updated row survives', sheet._grid('matches')[1][1] === 'mine');
  check('the note on the closed row survives too', sheet._grid('matches')[2][1] === 'also mine');
  check('and the closed row now reads Closed', sheet._grid('matches')[2][0] === CLOSED);
}

// --- the dropped tab -------------------------------------------------------
console.log('\n--- dropped ---');
{
  const ops = planDropped(5, [{ company: 'A', title: 'T', reason: 'below floor' }]);
  check('one write replaces the tab', ops.length === 1);
  check('padded out over what was there before', ops[0].values.length === 5,
    String(ops[0].values.length));
  check('the stale rows are blanked', ops[0].values[1].every((c) => c === ''));
  check('no clear operation is used', !JSON.stringify(ops).includes('clear'));
  check('an empty run with an empty tab writes nothing', planDropped(0, []).length === 0);
}

// --- triage ----------------------------------------------------------------
console.log('\n--- triage ---');
{
  const jobs = [
    job({ id: '1', title: 'Staff Engineer', body: 'Base salary $220,000 - $260,000.' }),
    job({ id: '2', title: 'Staff Engineer', body: 'Base salary $90,000 - $110,000.' }),
    job({ id: '3', title: 'Staff Engineer', body: 'A great place to work.' }),
    job({ id: '4', title: 'Office Manager', body: 'Base salary $300,000 - $400,000.' }),
  ];
  const settings = { ...SETTINGS, salaryFloor: 200000 };
  const { matches, dropped } = triage(jobs, COMPANY, { rules: RULES, settings }, NOW);

  check('a match over the floor is kept', matches.some((m) => m.key === 'clickup:1'));
  check('a match under the floor is dropped', dropped.some((d) => d.title === 'Staff Engineer'));
  check('the drop says why', /tops out at \$110k, under \$200k/.test(dropped[0].reason),
    dropped[0].reason);
  check('an unpriced match is kept by default', matches.some((m) => m.key === 'clickup:3'));
  check('a non-match is neither matched nor dropped',
    !matches.some((m) => m.key === 'clickup:4') && !dropped.some((d) => d.title === 'Office Manager'));
  check('the dropped tab is for filtered matches, not everything seen', dropped.length === 1);
}
{
  const jobs = [job({ id: '3', body: 'A great place to work.' })];
  const settings = { ...SETTINGS, salaryFloor: 200000, unpriced: 'drop' };
  const { matches, dropped } = triage(jobs, COMPANY, { rules: RULES, settings }, NOW);
  check('unpriced postings can be dropped instead', matches.length === 0 && dropped.length === 1);
  check('and the reason names the setting', /unpriced/.test(dropped[0].reason), dropped[0].reason);
}
{
  const empty = compileRules({});
  const { matches, dropped } = triage([job(), job({ id: '2', title: 'VP Sales' })],
    COMPANY, { rules: empty, settings: SETTINGS }, NOW);
  check('an empty rule set matches nothing and drops nothing',
    matches.length === 0 && dropped.length === 0);
}

// --- everything a filter cost reaches the dropped tab ----------------------
// The tab exists to answer "are my filters too tight", so a posting rejected
// for its location belongs there as much as one under the salary floor. It
// used to be discarded without trace, which is why a run that rejected five
// postings on location left the tab empty.
console.log('\n--- what lands in dropped ---');
{
  const remoteOnly = compileRules({
    title: ['staff engineer'],
    location: { mode: 'any', allowlist: ['united states'] },
  });
  const jobs = [
    job({ id: '1', title: 'Staff Engineer', location: 'United States (Remote)' }),
    job({ id: '2', title: 'Staff Engineer', location: 'Poland (Remote)' }),
    job({ id: '3', title: 'Office Manager', location: 'Poland (Remote)' }),
  ];
  const { matches, dropped } = triage(jobs, COMPANY, { rules: remoteOnly, settings: SETTINGS }, NOW);

  check('the allowed one matches', matches.length === 1);
  check('the one rejected on location is dropped', dropped.length === 1, String(dropped.length));
  check('and says why', /Poland.*outside the allowlist/.test(dropped[0].reason), dropped[0].reason);
  check('and keeps the location for context', dropped[0].location === 'Poland (Remote)');
  check('a posting no rule matched is not "dropped" — nothing filtered it out',
    !dropped.some((d) => d.title === 'Office Manager'));
}
{
  // An exclusion broader than its author intended is the other way filters go
  // wrong, and it only shows up if the verdict says what the exclusion cost.
  const rules = compileRules({ title: ['staff engineer'], exclude: ['contract'] });
  const jobs = [
    job({ id: '1', title: 'Staff Engineer, Contract Management' }),
    job({ id: '2', title: 'Contract Administrator' }),
  ];
  const { matches, dropped } = triage(jobs, COMPANY, { rules, settings: SETTINGS }, NOW);

  check('the exclusion still wins', matches.length === 0);
  check('an exclusion that killed a match is reported', dropped.length === 1, String(dropped.length));
  check('and names both rules',
    /matched "staff engineer".*excluded by "contract"/.test(dropped[0].reason), dropped[0].reason);
  check('an exclusion that cost nothing is not reported',
    !dropped.some((d) => d.title === 'Contract Administrator'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
