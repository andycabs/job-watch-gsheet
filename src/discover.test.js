#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Offline tests for discovery. The probe is injected, so none of this touches
// a job board — which matters here more than anywhere else in the codebase,
// since a real run is rate-limited into the minutes and finding a logic bug
// that way costs one of those minutes per attempt.
import { slugVariants, probeOrder, planDiscoveryWrites, REQUEST_DELAY_MS } from './probe.js';

// resolveCompany's fetch-and-wait loop lives with whichever runtime is doing
// the fetching; the spreadsheet's is exercised against a fake board in
// src/gas/gas.test.js. What is here is the deciding part: which candidates to
// try, in what order, and what to write back.
import { ATS_NAMES } from './boards.js';
import { TABS, columnIndex, scriptRange, USER } from './sheet/schema.js';
import { memoryClient } from './sheet/memory.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

// --- slug guessing ---------------------------------------------------------
console.log('--- slug candidates ---');
{
  // Shapes taken from companies that really do post on these boards.
  const cases = [
    ['Hims & Hers', 'himshers'],
    ['Apollo.io', 'apollo'],
    ['1Password', '1password'],
    ['ClickUp', 'clickup'],
    ['Grafana Labs', 'grafanalabs'],
    ['Acme Labs Inc', 'acmelabs'],
  ];
  for (const [name, expected] of cases) {
    check(`${name} → ${expected}`, slugVariants(name).includes(expected),
      slugVariants(name).join(', '));
  }
  check('hyphenation is offered too', slugVariants('Hims & Hers').includes('hims-hers'));
  check('the first word alone is offered', slugVariants('Grafana Labs').includes('grafana'));
}
{
  check('a hand-typed slug is tried first',
    slugVariants('ClickUp', 'clickup-careers')[0] === 'clickup-careers');
  check('and is not duplicated if it matches a guess',
    slugVariants('ClickUp', 'clickup').filter((s) => s === 'clickup').length === 1);
  check('no blanks in the list', slugVariants('  ', '').length === 0);
  check('a nameless company yields nothing to try', slugVariants(undefined).length === 0);
}

// --- probe ordering --------------------------------------------------------
console.log('\n--- probe order ---');
{
  const order = probeOrder({ name: 'Hims & Hers' });
  check('covers every board', new Set(order.map((o) => o.ats)).size === ATS_NAMES.length);
  check('covers every slug', new Set(order.map((o) => o.slug)).size === slugVariants('Hims & Hers').length);
  // With no ATS to go on, the best slug is worth trying everywhere before the
  // second slug is tried anywhere: the first candidate is right more often
  // than any one board is.
  check('sweeps the best slug across the boards first',
    order.slice(0, ATS_NAMES.length).every((o) => o.slug === order[0].slug),
    order.slice(0, 3).map((o) => `${o.ats}/${o.slug}`).join(' '));
  check('and the first slug tried is the canonical one', order[0].slug === 'himshers');

  const known = probeOrder({ name: 'Hims & Hers', ats: 'ashby' });
  check('a stated ATS is exhausted first', known.slice(0, 3).every((o) => o.ats === 'ashby'),
    known.slice(0, 4).map((o) => `${o.ats}/${o.slug}`).join(' '));
  check('but the others still follow, in case it is wrong',
    new Set(known.map((o) => o.ats)).size === ATS_NAMES.length);
  check('with no pair tried twice',
    new Set(known.map((o) => `${o.ats}/${o.slug}`)).size === known.length);
  const bogus = probeOrder({ name: 'ClickUp', ats: 'greenhosue' });
  check('a misspelled ATS is ignored rather than probed',
    !bogus.some((o) => o.ats === 'greenhosue'));
}

// --- resolving -------------------------------------------------------------
console.log('\n--- resolving ---');
{
  check('the delay between requests is not something to tune down',
    REQUEST_DELAY_MS >= 1000, `${REQUEST_DELAY_MS}ms`);
}

// --- writing back ----------------------------------------------------------
console.log('\n--- writing results back ---');
{
  const results = [
    { row: 2, name: 'ClickUp', ats: 'lever', slug: 'clickup', count: 42 },
    { row: 5, name: 'Nobody', ats: null, slug: null, count: 0 },
  ];
  const writes = planDiscoveryWrites(results, '2026-08-29');
  check('writes only the rows it resolved', writes.length === 1);
  check('into the right row', writes[0].range.includes('2:'), writes[0].range);
  check('with ats, slug and the date', JSON.stringify(writes[0].values) === '[["lever","clickup","2026-08-29"]]');

  // The invariant doing its job: the range cannot reach a typed column.
  const tab = TABS.companies;
  const userCols = tab.columns.filter((c) => c.owner === USER).map((c) => c.header);
  check('the range starts at the first script column',
    writes[0].range === scriptRange(tab, 2), `${writes[0].range} vs ${scriptRange(tab, 2)}`);
  check('so Name, Category and Note are unreachable',
    userCols.join(',') === 'Active,Name,Category,Note' &&
    columnIndex(tab, 'ats') === userCols.length);
}
{
  // End to end against a simulated sheet: the typed columns survive.
  const sheet = memoryClient({
    companies: [
      TABS.companies.columns.map((c) => c.header),
      ['TRUE', 'ClickUp', 'tools', 'my note', '', '', ''],
    ],
  });
  await sheet.applyOps(planDiscoveryWrites(
    [{ row: 2, name: 'ClickUp', ats: 'lever', slug: 'clickup' }], '2026-08-29'
  ));
  const row = sheet._grid('companies')[1];
  check('the slug lands in the sheet', row[5] === 'clickup' && row[4] === 'lever');
  check('the verified date is recorded', row[6] === '2026-08-29');
  check('and nothing the user typed moved',
    row.slice(0, 4).join('|') === 'TRUE|ClickUp|tools|my note', row.slice(0, 4).join('|'));
}
{
  check('an empty result set writes nothing', planDiscoveryWrites([]).length === 0);
  check('a row with an ats but no slug is not written back',
    planDiscoveryWrites([{ row: 2, ats: 'lever', slug: '' }]).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
