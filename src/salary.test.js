#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Offline tests for pay extraction.
//
// The first block is the one that counts: real markup from a live board, run
// through the real extraction path. In v1 this parser passed every test it had
// while returning nothing on actual postings, because every one of those tests
// used text someone had typed into a test file.
//
// The OTE cases below are NOT of that kind — they are constructed from how
// postings are written, not captured from a payload. Until a real posting
// quoting both base and OTE has been through `npm run diagnose`, treat the
// base path as verified and OTE labelling as plausible.
import {
  extractSalary, evaluateSalary, formatSalary, fromStructured, fromText,
  rangesInText, classify, clauseAt, toNumber, ASSUMED_HOURS_PER_YEAR,
} from './salary.js';
import { stripHtml } from './boards.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

// --- real markup, real path ------------------------------------------------
console.log('--- a live Greenhouse posting ---');
{
  // Verbatim from Grafana Labs job 6115634004 — the posting whose salary v1
  // silently failed to read for months.
  const raw =
    '&lt;p&gt;&lt;span style=&quot;font-weight: 400;&quot;&gt;In the US, the base compensation ' +
    'range for this role is $&lt;span data-sheets-root=&quot;1&quot;&gt;100,000&lt;/span&gt;' +
    '&lt;span data-sheets-root=&quot;1&quot;&gt;&amp;nbsp;&lt;/span&gt;- $&lt;span ' +
    'data-sheets-root=&quot;1&quot;&gt;120,000&lt;/span&gt;. &amp;nbsp;Actual compensation may vary.' +
    '&lt;/span&gt;&lt;/p&gt;';

  const salary = extractSalary({ body: stripHtml(raw) });
  check('reads the range', salary?.min === 100000 && salary?.max === 120000,
    JSON.stringify(salary));
  check('as base, because the posting says "base compensation"',
    salary.kind === 'base' && salary.basis.startsWith('base, stated'), salary.basis);
  check('formats for the sheet', formatSalary(salary) === '$100k–120k', formatSalary(salary));
}

// --- numbers ---------------------------------------------------------------
console.log('\n--- reading a figure ---');
check('185k', toNumber('185k') === 185000);
check('$185,000', toNumber('$185,000') === 185000);
check('185000', toNumber('185000') === 185000);
check('142.5k', toNumber('142.5k') === 142500);
check('nonsense is null', toNumber('about two hundred') === null);
check('nothing is null', toNumber(null) === null && toNumber(undefined) === null);

// --- what counts as base, what counts as OTE -------------------------------
console.log('\n--- labelling ---');
check('"base salary" is base', classify('the base salary range for this role') === 'base');
check('OTE is OTE', classify('$300,000 OTE for this role') === 'ote');
check('on-target earnings is OTE', classify('on-target earnings of $300,000') === 'ote');
check('total compensation is OTE', classify('total compensation of $300,000') === 'ote');
check('an unqualified sentence is neither', classify('this role pays $200,000') === null);
{
  // Both markers present: the nearer one to the figure wins.
  const line = 'The base salary is $140,000–$160,000, with OTE reaching $280,000.';
  const ranges = rangesInText(line);
  check('the first range reads as base', ranges[0]?.kind === 'base', JSON.stringify(ranges[0]));
}

// --- clauses, and why they matter ------------------------------------------
console.log('\n--- clause boundaries ---');
{
  const t = 'The range is $120,000–$150,000, and with commission $200,000–$240,000.';
  check('a clause stops at ", and"', clauseAt(t, t.indexOf('$120')) === 'The range is $120,000–$150,000');
  check('the next clause carries its own marker and not the earlier figure',
    clauseAt(t, t.indexOf('$200')).includes('with commission') &&
    !clauseAt(t, t.indexOf('$200')).includes('120,000'), clauseAt(t, t.indexOf('$200')));

  // The regression: a fixed window around the first figure swallowed "with
  // commission" and labelled the base range as OTE.
  const ranges = rangesInText(t);
  check('the first range is not labelled by the second clause', ranges[0].kind === null,
    String(ranges[0].kind));
  check('and the second is', ranges[1].kind === 'ote');

  check('sentences split too',
    clauseAt('Base is $100,000. OTE is $200,000.', 0) === 'Base is $100,000');
  check('a decimal does not split a clause',
    clauseAt('The rate is 142.5k here', 0) === 'The rate is 142.5k here');
}

// --- ranges in prose -------------------------------------------------------
console.log('\n--- ranges in text ---');
{
  const s = fromText('The salary range for this position is $150,000 - $200,000 per year.');
  check('a plain range is read', s.min === 150000 && s.max === 200000);
  const k = fromText('Compensation: $150k–$200k');
  check('k notation works', k.min === 150000 && k.max === 200000);
  const to = fromText('We pay 150,000 to 200,000 USD');
  check('"to" works as a separator', to.min === 150000 && to.max === 200000);
}
{
  // Both stated: the band that survives is the OTE, because that is the number
  // worth comparing offers on.
  const s = fromText('Base salary $140,000–$160,000. OTE $280,000–$320,000.');
  check('OTE wins when the posting states both', s.min === 280000 && s.max === 320000,
    JSON.stringify(s));
  check('and the basis says so', s.kind === 'ote' && /OTE, stated/.test(s.basis), s.basis);
  check('the label reaches the sheet', formatSalary(s) === '$280k–320k OTE', formatSalary(s));
}
{
  // The conservative default: an unqualified range is base, not OTE.
  const s = fromText('This role pays $180,000 - $220,000.');
  check('an unqualified range is treated as base', s.max === 220000 && s.kind === 'base');
  check('and the basis admits the assumption', /assumed/.test(s.basis), s.basis);
  check('an unlabelled band carries no OTE suffix', formatSalary(s) === '$180k–220k', formatSalary(s));
}
{
  const s = fromText('The range is $120,000–$150,000, and with commission $200,000–$240,000.');
  check('a labelled OTE beats an unlabelled range', s.max === 240000 && s.kind === 'ote',
    JSON.stringify(s));
}
{
  // Two unqualified ranges and nothing to tell them apart: take the lower.
  // Guessing that the higher one is OTE is the kind of inference that reads
  // well in a test and inflates every posting in production.
  const s = fromText('One team pays $120,000 - $150,000. Another pays $200,000 - $240,000.');
  check('the lower unqualified range wins', s.max === 150000, JSON.stringify(s));
  check('and it is not claimed to be OTE', s.kind === 'base');
}
{
  // Figures that are money but not pay.
  check('equity percentages are ignored', fromText('Equity of 0.05% - 0.10% is offered') === null);
  check('ARR is not a salary', fromText('We passed $100,000,000 to $150,000,000 in ARR') === null);
  check('headcount is not a salary', fromText('We grew from 10,000 to 50,000 customers') === null);
  check('a 401k match is not a salary', fromText('401k with a match') === null);
}
{
  check('a bare number is not a salary',
    fromText('We serve 200,000 users and are growing fast.') === null);
  check('a labelled single figure is', fromText('The base salary is $185,000.')?.min === 185000);
  const hourly = fromText('This role pays $75/hour.');
  check('hourly is annualised',
    hourly.min === 75 * ASSUMED_HOURS_PER_YEAR, JSON.stringify(hourly));
  check('and says how', hourly.basis.includes('2080'), hourly.basis);
}

// --- structured compensation -----------------------------------------------
console.log('\n--- structured data ---');
{
  // Ashby's shape.
  const job = { compensation: { compensationTiers: [{ components: [
    { compensationType: 'Salary', interval: 'YEAR', minValue: 140000, maxValue: 160000 },
    { compensationType: 'Equity', interval: 'ONE_TIME', minValue: 0.05, maxValue: 0.1 },
  ] }] } };
  const s = fromStructured(job);
  check('reads the salary component', s.min === 140000 && s.max === 160000);
  check('ignores equity', s.kind === 'base', s.basis);
  check('says where it came from', s.basis === 'base, from the board', s.basis);
}
{
  const job = { compensation: { compensationTiers: [{ components: [
    { compensationType: 'Salary', interval: 'YEAR', minValue: 140000, maxValue: 160000 },
    { compensationType: 'Commission', interval: 'YEAR', minValue: 140000, maxValue: 160000 },
  ] }] } };
  const s = fromStructured(job);
  check('base plus commission is the band', s.min === 280000 && s.max === 320000, JSON.stringify(s));
  check('labelled as OTE', s.kind === 'ote');
  check('and the basis says where it came from',
    s.basis === 'base + commission, from the board', s.basis);
}
{
  const job = { compensation: { compensationTiers: [{ components: [
    { compensationType: 'Salary', interval: 'HOUR', minValue: 75, maxValue: 90 },
  ] }] } };
  const s = fromStructured(job);
  check('hourly structured pay is annualised', s.min === 75 * ASSUMED_HOURS_PER_YEAR);
}
{
  check('structured data wins over text',
    extractSalary({
      compensation: { compensationTiers: [{ components: [
        { compensationType: 'Salary', minValue: 200000, maxValue: 250000 }] }] },
      body: 'Elsewhere the post mentions $50,000 - $60,000.',
    }).min === 200000);
  check('an empty compensation object falls through to text',
    extractSalary({ compensation: {}, body: 'Base salary $150,000 - $180,000' })?.min === 150000);
}

// --- the floor -------------------------------------------------------------
console.log('\n--- applying the floor ---');
{
  const job = { body: 'Base salary $140,000–$160,000. OTE $280,000–$320,000.' };
  check('no floor set means everything passes', evaluateSalary(job, {}).verdict === 'pass');
  check('the OTE band clears a floor the base would not',
    evaluateSalary(job, { salaryFloor: 200000 }).verdict === 'pass');
  check('the reason names the figure',
    /\$320k clears \$200k/.test(evaluateSalary(job, { salaryFloor: 200000 }).reason),
    evaluateSalary(job, { salaryFloor: 200000 }).reason);
}
{
  const baseOnly = { body: 'The base salary range is $140,000 - $160,000.' };
  const r = evaluateSalary(baseOnly, { salaryFloor: 200000 });
  check('a band under the floor is dropped', r.verdict === 'below');
  check('and says how far short it fell', /tops out at \$160k, under \$200k/.test(r.reason), r.reason);
}
{
  const r = evaluateSalary({ body: 'A great opportunity.' }, { salaryFloor: 200000 });
  check('an unpriced posting is unknown, not below', r.verdict === 'unknown');
  check('and says so plainly', r.reason === 'no salary stated');
}

// --- robustness ------------------------------------------------------------
console.log('\n--- robustness ---');
{
  const nasty = [
    {}, { body: null }, { body: '' }, { compensation: null }, { compensation: [] },
    { compensation: { compensationTiers: [null, { components: [null] }] } },
    { body: '$'.repeat(500) }, { body: '1,2,3,4,5,6,7,8,9' },
  ];
  let threw = null;
  for (const job of nasty) {
    try { extractSalary(job); evaluateSalary(job, { salaryFloor: 1 }); }
    catch (e) { threw = `${JSON.stringify(job).slice(0, 40)}: ${e.message}`; }
  }
  check('malformed input is survivable', threw === null, threw || '');
  check('nothing found is null, not a zero', extractSalary({ body: 'no pay here' }) === null);
  check('a band always has both ends',
    ['min', 'max', 'kind', 'basis'].every((k) => k in extractSalary({ body: 'Base salary $150,000 - $180,000' })));
  check('formatting nothing is empty', formatSalary(null) === '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
