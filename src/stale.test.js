#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Tests for dropping long-open postings.
//
// A req that has been open for months is often a pipeline posting rather than
// a real opening. But not always — a small team can leave a good role up for a
// long time — so this is off unless asked for, and when it does fire the
// posting lands in `dropped` saying exactly why rather than disappearing.
import { triage } from './triage.js';
import { compileRules } from './rules.js';
import { SETTINGS } from './sheet/schema.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
};

const NOW = new Date('2026-08-30T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

const rules = compileRules({ title: [{ pattern: 'engineer', note: '', row: 2 }] });
const company = { name: 'Acme', slug: 'acme' };
const base = {
  salaryFloor: '', unpriced: 'keep', locationMode: 'any',
  stalePostingDays: 60, stale: 'keep',
  weightTitle: 40, weightSalary: 25, weightSeniority: 20, weightFreshness: 15,
  seniorityTarget: [],
};
const job = (id, days) => ({ id, title: 'Staff Engineer', location: 'Remote', url: 'u', postedAt: daysAgo(days) });
const run = (settings, jobs) => triage(jobs, company, { rules, settings }, NOW);

console.log('--- the setting exists and is off ---');
check('the sheet ships the setting', Boolean(SETTINGS['stale postings']));
check('it offers keep and drop',
  String(SETTINGS['stale postings']?.options) === 'keep,drop');
check('and defaults to keep', SETTINGS['stale postings']?.value === 'keep',
  'hiding postings by default would be the tool deciding something it should not');

console.log('\n--- keep ---');
{
  const r = run(base, [job('1', 400), job('2', 3)]);
  check('an ancient posting is kept when set to keep', r.matches.length === 2);
  check('and nothing is dropped', r.dropped.length === 0);
}

console.log('\n--- drop ---');
{
  const r = run({ ...base, stale: 'drop' }, [job('1', 400), job('2', 3)]);
  check('the old one goes', r.matches.length === 1 && r.matches[0].key === 'acme:2');
  check('into dropped, not nowhere', r.dropped.length === 1);
  check('saying how old and what the limit was',
    /400 days ago/.test(r.dropped[0].reason) && /60 days/.test(r.dropped[0].reason),
    r.dropped[0].reason);
}
{
  const r = run({ ...base, stale: 'drop' }, [job('1', 60), job('2', 59)]);
  check('the threshold is inclusive', r.dropped.length === 1 && r.matches.length === 1,
    'a posting exactly at the limit counts as stale');
}
{
  const r = run({ ...base, stale: 'drop' }, [{ ...job('1', 5), postedAt: null }]);
  check('a posting with no date is never dropped as stale', r.matches.length === 1,
    'not knowing the age is not evidence of age');
}
{
  const r = run({ ...base, stale: 'drop', stalePostingDays: 0 }, [job('1', 400)]);
  check('a zero day count disables it rather than dropping everything',
    r.matches.length === 1, 'otherwise a blank cell empties the sheet');
}
{
  const r = run({ ...base, stale: 'drop', stalePostingDays: '' }, [job('1', 400)]);
  check('so does a blank one', r.matches.length === 1);
}

console.log('\n--- it runs last ---');
{
  // A posting that is both old and underpaid should be reported as underpaid:
  // the salary floor is the filter the user set deliberately, and knowing a
  // rejected posting was also old helps nobody.
  const settings = { ...base, stale: 'drop', salaryFloor: 200000 };
  const underpaid = { ...job('1', 400), body: 'The salary for this role is $90,000 - $100,000 per year.' };
  const r = run(settings, [underpaid]);
  check('an old, underpaid posting is reported as underpaid',
    r.dropped.length === 1 && !/days ago/.test(r.dropped[0].reason), r.dropped[0]?.reason);
}
{
  // And one that no rule matched is not "stale" — nothing filtered it out.
  const r = run({ ...base, stale: 'drop' }, [{ ...job('1', 400), title: 'Chef' }]);
  check('a posting no rule wanted is not dropped as stale', r.dropped.length === 0,
    'that is what suggest is for');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
