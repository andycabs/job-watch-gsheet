#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Tests for change detection, pay ranking, and learning from triage.
//
// The through-line: every one of these reports rather than decides, and every
// one refuses to speak when the evidence is too thin. A number drawn from
// three samples is superstition with a percentage on it, and a sheet is better
// off blank than confidently wrong.
import { describeChange, planSync, buildRecord } from './sync.js';
import { payRank } from './score.js';
import { splitByVerdict, leaningPhrases, companyLeanings, salaryLeaning, MINIMUM } from './leanings.js';
import { TABS, headers, columnIndex } from './sheet/schema.js';
import { indexColumns } from './sheet/read.js';
import { discordPayload, notify } from './notify.js';
import { memoryClient } from './sheet/memory.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
};

const HEAD = headers(TABS.matches);
const NOW = new Date('2026-08-29T09:00:00Z');
const SETTINGS = { closeAfterDays: 7, stalePostingDays: 60 };

// ===========================================================================
console.log('=== what changed ===');
// ===========================================================================
{
  const before = { title: 'Staff Frontend Engineer', salary: '$200k-250k', location: 'United States (Remote)', posted: '2026-04-02' };
  check('a salary going up is reported',
    describeChange(before, { ...before, salary: '$220k-270k' }) === 'salary $200k-250k -> $220k-270k'
      .replace('->', '→'),
    describeChange(before, { ...before, salary: '$220k-270k' }));
  check('a retitle is reported',
    /title .* Principal/.test(describeChange(before, { ...before, title: 'Principal Frontend Engineer' })));
  check('a move is reported',
    /location .* Canada/.test(describeChange(before, { ...before, location: 'Canada (Remote)' })));
  check('a repost is reported, with the old date',
    describeChange(before, { ...before, posted: '2026-08-20' }) === 'reposted (was 2026-04-02)');
  check('several at once are all reported',
    describeChange(before, { ...before, salary: '$1-$2', posted: '2026-08-20' }).includes('·'));
}
{
  check('nothing moving reports nothing',
    describeChange({ title: 'A', salary: 'x' }, { title: 'A', salary: 'x' }) === '');
  // The first time a posting is priced, that is not a "change" from blank.
  check('a field appearing for the first time is not a change',
    describeChange({ salary: '' }, { salary: '$200k-250k' }) === '');
  check('nor is one disappearing',
    describeChange({ salary: '$200k-250k' }, { salary: '' }) === '');
  check('the fields that move every run are ignored',
    describeChange({ lastSeen: '2026-08-28', age: '5d' }, { lastSeen: '2026-08-29', age: '6d' }) === '');
  check('rubbish is survivable', describeChange(null, undefined) === '' && describeChange() === '');
}
{
  // End to end: the change lands in the row and in the run's report.
  const job = (over = {}) => ({ id: '1', title: 'Staff Engineer', location: 'Remote', url: 'u', postedAt: '2026-08-28', body: '', ...over });
  const company = { name: 'ClickUp', slug: 'clickup' };
  const first = buildRecord({ job: job(), company, salary: { min: 200000, max: 250000, kind: 'base' }, settings: SETTINGS }, NOW);

  const sheet = memoryClient({ matches: [HEAD] });
  await sheet.applyOps(planSync(sheet._grid('matches'), [first], { settings: SETTINGS, now: NOW }).operations);
  check('a brand-new posting reports no change',
    sheet._grid('matches')[1][columnIndex(TABS.matches, 'changed')] === '');

  const raised = buildRecord({ job: job(), company, salary: { min: 220000, max: 270000, kind: 'base' }, settings: SETTINGS }, NOW);
  const plan = planSync(sheet._grid('matches'), [raised], { settings: SETTINGS, now: NOW });
  check('the second run notices the raise', plan.changes.length === 1, JSON.stringify(plan.changes.map((c) => c.change)));
  check('and says so in the summary', /1 changed/.test(plan.summary), plan.summary);

  await sheet.applyOps(plan.operations);
  const cell = sheet._grid('matches')[1][columnIndex(TABS.matches, 'changed')];
  check('and writes it to the row', /salary/.test(cell), cell);
  check('while the row itself updates',
    sheet._grid('matches')[1][columnIndex(TABS.matches, 'salaryMax')] === '270000');
}
{
  // A change is worth a notification even though the posting is not new.
  const changed = { key: 'a', company: 'ClickUp', title: 'Staff Engineer', salary: '$220k-270k', changed: 'salary $200k-250k -> $220k-270k' };
  const posts = [];
  const r = await notify([], {
    env: { DISCORD_WEBHOOK_URL: 'https://x' },
    fetchImpl: async (url, opts) => { posts.push(JSON.parse(opts.body)); return { ok: true, status: 200, text: async () => '' }; },
    changed: [changed],
  });
  check('a change alone is enough to send a digest', r.sent.join(',') === 'discord', r.skipped || '');
  check('and the digest says what moved', /salary/.test(posts[0].content), posts[0].content);
  check('a posting that is both new and changed is listed once',
    discordPayload([changed]).content.split('ClickUp').length - 1 === 1);
}

// ===========================================================================
console.log('\n=== where the pay sits ===');
// ===========================================================================
{
  const pop = [90, 120, 150, 160, 175, 180, 200, 210, 250, 300].map((n) => n * 1000);
  check('the top figure ranks top', /top \d+%|highest seen/.test(payRank(300000, pop)), payRank(300000, pop));
  check('the bottom figure ranks bottom', /bottom/.test(payRank(90000, pop)), payRank(90000, pop));
  check('the middle is neither extreme', payRank(175000, pop) !== null);
  check('identical figures rank identically', payRank(200000, pop) === payRank(200000, pop));
}
{
  // A percentile drawn from four postings is a number pretending to be
  // information. Better blank.
  check('too few samples means no claim', payRank(200000, [100000, 200000, 300000]) === null);
  check('exactly at the minimum it speaks', payRank(200000, Array(8).fill(150000)) !== null);
  check('an unpriced posting gets no rank', payRank(null, Array(20).fill(150000)) === null);
  check('zeroes and rubbish are excluded from the population',
    payRank(200000, [0, -5, NaN, null, undefined, ...Array(8).fill(150000)]) !== null);
  check('an empty population says nothing', payRank(200000, []) === null);
}

// ===========================================================================
console.log('\n=== learning from triage ===');
// ===========================================================================
const row = (over = {}) => TABS.matches.columns.map((c) => String(over[c.key] ?? ''));
const idx = indexColumns(TABS.matches, HEAD).index;
{
  const rows = [
    row({ status: 'Interested', title: 'Staff Frontend Engineer', company: 'ClickUp', salaryMax: '250000' }),
    row({ status: 'Applied', title: 'Principal Frontend Engineer', company: 'ClickUp', salaryMax: '300000' }),
    row({ status: 'Passed', title: 'Engineering Manager', company: 'Acme', salaryMax: '200000' }),
    row({ status: 'Not reviewed', title: 'Staff Backend Engineer', company: 'Acme' }),
    row({ status: '', title: 'nothing typed here' }),
  ];
  const { kept, passed } = splitByVerdict(rows, idx);
  check('Interested and Applied both count as kept', kept.length === 2);
  check('Passed counts as passed', passed.length === 1);
  check('untriaged rows count as neither', kept.length + passed.length === 3);
  check('the salary comes through as a number', kept[0].salaryMax === 250000);
}
{
  const kept = ['Staff Frontend Engineer', 'Senior Frontend Engineer', 'Principal Frontend Engineer',
    'Staff AI Engineer', 'Senior AI Engineer'].map((title) => ({ title, company: 'ClickUp' }));
  const passed = ['Engineering Manager', 'Engineering Manager, Platform', 'Senior Engineering Manager',
    'Director of Engineering', 'Group Engineering Manager'].map((title) => ({ title, company: 'Acme' }));

  const { towards, away } = leaningPhrases(kept, passed);
  check('a phrase only in what you passed on is surfaced',
    away.some((a) => a.phrase === 'manager'), away.map((a) => a.phrase).join(', '));
  check('and one only in what you kept',
    towards.some((t) => t.phrase === 'engineer'), towards.map((t) => t.phrase).join(', '));
  check('a phrase on both sides is not surfaced',
    ![...towards, ...away].some((x) => x.phrase === 'senior'),
    [...towards, ...away].map((x) => x.phrase).join(', '));
  check('the counts are reported, not a score',
    away[0].passed > 0 && 'kept' in away[0]);
}
{
  const kept = [{ title: 'A', company: 'Good Co' }, { title: 'B', company: 'Good Co' }, { title: 'C', company: 'Good Co' }];
  const passed = [{ title: 'D', company: 'Bad Co' }, { title: 'E', company: 'Bad Co' }, { title: 'F', company: 'Bad Co' },
    { title: 'G', company: 'Mixed' }];
  const leanings = companyLeanings(kept, passed);
  check('a company you always pass on is surfaced',
    leanings.some((c) => c.name === 'Bad Co' && c.passed === 3));
  check('so is one you always keep', leanings.some((c) => c.name === 'Good Co'));
  check('a company judged once is not', !leanings.some((c) => c.name === 'Mixed'));
}
{
  const kept = [220, 250, 300, 260].map((n) => ({ title: 'x', salaryMax: n * 1000 }));
  const passed = [90, 110, 120, 250].map((n) => ({ title: 'y', salaryMax: n * 1000 }));
  const s = salaryLeaning(kept, passed);
  check('the medians are computed', s.keptMedian === 255000, String(s.keptMedian));
  check('the lowest you kept is the candidate floor', s.lowestKept === 220000);
  check('and it counts what that floor would have cut', s.wouldHaveCut === 3, String(s.wouldHaveCut));
  check('too few priced postings means no claim',
    salaryLeaning([{ salaryMax: 1 }], [{ salaryMax: 2 }]) === null);
}
{
  // The refusal is the feature.
  check('the minimum is a real threshold, not one', MINIMUM >= 5, String(MINIMUM));
  const thin = leaningPhrases([{ title: 'Staff Engineer' }], [{ title: 'Engineering Manager' }]);
  check('one judgement each side surfaces nothing',
    thin.towards.length === 0 && thin.away.length === 0);
}
{
  let threw = null;
  try {
    splitByVerdict(null, {}); splitByVerdict([null, undefined], idx);
    leaningPhrases([], []); companyLeanings([], []); salaryLeaning([], []);
    leaningPhrases([{ title: null }], [{ title: undefined }]);
  } catch (e) { threw = e.message; }
  check('rubbish input is survivable', threw === null, threw || '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
