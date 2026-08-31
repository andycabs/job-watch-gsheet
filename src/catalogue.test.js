#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Tests for what is fit to ship in the catalogue.
//
// The rule these protect: a row in the catalogue is a promise that ticking it
// will produce postings. A name with nothing behind it breaks that promise
// silently — the user ticks it, nothing arrives, and there is no way to tell
// that from "they aren't hiring".
import { readFileSync } from 'node:fs';
import { gatherRecords, buildCatalogue, balance, screenRecords } from './catalogue.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
};

const hit = (name, category = 'saas', extra = {}) => ({
  name, category, description: `${name} does things`,
  resolved: true, ats: 'greenhouse', slug: name.toLowerCase(), count: 5, titles: [], ...extra,
});
const miss = (name) => ({ name, resolved: false, tried: 24 });

console.log('--- gathering shards ---');
{
  const records = gatherRecords([
    { records: [hit('Alpha'), miss('Beta')] },
    { records: [hit('Gamma')] },
  ]);
  check('every shard contributes', records.length === 3);
}
{
  const records = gatherRecords([
    { records: [miss('Alpha')] },
    { records: [hit('Alpha')] },
  ]);
  check('a re-probe replaces an earlier answer', records.length === 1 && records[0].resolved);
}

console.log('\n--- boards that answer but are not the company we meant ---');
{
  // Every one of these returned real postings. A slug answering is not proof.
  const records = [
    hit('Carbon Health'),
    hit('Veeva Systems', 'saas', { slug: 'veeva' }),
    hit('EY', 'saas', { ats: 'recruitee', titles: ['Senior Marketer (Sample)'] }),
  ];
  const rejected = [{ name: 'Carbon Health', reason: 'This board is Carbon, the 3D printing company' }];
  const { kept, dropped } = screenRecords(records, rejected);
  check('a reviewed rejection is dropped', dropped.some((d) => d.name === 'Carbon Health'));
  check('with the reason a person wrote',
    dropped.find((d) => d.name === 'Carbon Health').why.includes('3D printing'));
  check('an unclaimed board showing its sample posting is dropped',
    dropped.some((d) => d.name === 'EY'));
  check('a healthy board is kept', kept.some((k) => k.name === 'Veeva Systems'));
}
{
  const { kept, dropped } = screenRecords([
    hit('General Motors', 'fortune', { slug: 'general' }),
    hit('General Electric', 'fortune', { slug: 'general' }),
    hit('Alpha'),
  ]);
  check('two companies on one slug means neither ships', dropped.length === 2,
    'one of them is wrong and nothing here can say which');
  check('and the rest is untouched', kept.length === 1 && kept[0].name === 'Alpha');
}
{
  // The bug this catches: counting claims before applying the reviewed
  // rejections took Stripe and Cloudflare out of the catalogue, because a
  // product listed alongside its parent looked like a rival claim to the
  // same board. A collision is only between candidates still standing.
  const records = [
    hit('Stripe', 'fintech', { slug: 'stripe' }),
    hit('Stripe Tax', 'fintech', { slug: 'stripe' }),
  ];
  const rejected = [{ name: 'Stripe Tax', reason: 'A product, not a separate employer' }];
  const { kept, dropped } = screenRecords(records, rejected);
  check('a product rejected on review does not take its parent with it',
    kept.some((k) => k.name === 'Stripe') && dropped.length === 1,
    kept.map((k) => k.name).join(', '));
}
{
  const { kept } = screenRecords([miss('Costco')], []);
  check('a miss passes through the screen', kept.length === 1,
    'it is buildCatalogue that decides what a miss becomes');
}

console.log('\n--- a reason somebody wrote by hand ---');
{
  const existing = { entries: [], unlisted: [{ name: 'Workiva', reason: 'Workday' }] };
  const built = buildCatalogue([miss('Workiva'), miss('Costco')], existing);
  const workiva = built.unlisted.find((u) => u.name === 'Workiva');
  check('a hand-written reason survives a re-probe', workiva.reason === 'Workday',
    'naming the actual ATS beats "we looked and found nothing"');
  check('and a new miss gets the generic one',
    built.unlisted.find((u) => u.name === 'Costco').reason.includes('No board found'));
}
{
  const existing = { entries: [], unlisted: [{ name: 'Fly.io', reason: 'custom site, no public API' }] };
  const built = buildCatalogue([miss('Costco')], existing);
  check('an entry this run never probed stays documented',
    built.unlisted.some((u) => u.name === 'Fly.io'));
}
{
  const existing = { entries: [], unlisted: [{ name: 'Snyk', reason: 'the board 404ed' }] };
  const built = buildCatalogue([hit('Snyk', 'security')], existing);
  check('a company that starts answering leaves unlisted',
    !built.unlisted.some((u) => u.name === 'Snyk') && built.entries.some((e) => e.name === 'Snyk'));
}

console.log('\n--- what ships ---');
{
  const built = buildCatalogue([hit('Alpha'), miss('Costco'), hit('Gamma', 'devtools')]);
  check('only companies with a working board are listed', built.entries.length === 2);
  check('a miss never becomes an entry', !built.entries.some((e) => e.name === 'Costco'));
  check('a miss is recorded so the question has an answer',
    built.unlisted.length === 1 && built.unlisted[0].name === 'Costco');
  check('entries carry what the sheet needs',
    built.entries.every((e) => e.name && e.description && e.category && e.ats && e.slug));
  check('probe bookkeeping does not leak into the catalogue',
    built.entries.every((e) => !('count' in e) && !('titles' in e) && !('resolved' in e)),
    'titles and counts are for review, not for shipping');
  check('entries are ordered by category then name',
    built.entries[0].category === 'devtools' && built.entries[1].category === 'saas');
}

console.log('\n--- a company that went quiet ---');
{
  const existing = { entries: [
    { name: 'Alpha', description: 'd', category: 'saas', ats: 'lever', slug: 'alpha' },
  ], unlisted: [] };
  const built = buildCatalogue([miss('Alpha')], existing);
  check('a listed company that failed once is kept', built.entries.length === 1);
  check('and is reported for a person to check', built.stale.join() === 'Alpha',
    'a board can be down for a morning; losing a company to a blip is worse');
  check('it is not moved to unlisted', built.unlisted.length === 0);
  check('its known board is preserved', built.entries[0].slug === 'alpha');
}
{
  const existing = { entries: [{ name: 'Alpha', description: 'd', category: 'saas', ats: 'lever', slug: 'alpha' }], unlisted: [] };
  const built = buildCatalogue([hit('Beta')], existing);
  check('a company nobody probed this run is left alone', built.stale.length === 0,
    'absent from the run is not the same as failed in the run');
}

console.log('\n--- counting ---');
{
  const built = buildCatalogue([hit('Alpha'), hit('Beta'), hit('Gamma', 'devtools')],
    { entries: [{ name: 'Alpha', description: 'd', category: 'saas', ats: 'greenhouse', slug: 'alpha' }], unlisted: [] });
  check('new companies are counted as new', built.added === 2);
  check('and balance reports the spread', balance(built.entries)[0][0] === 'saas');
}
{
  const built = buildCatalogue([hit('Alpha', 'saas', { carried: true }), hit('Beta')]);
  check('re-validated companies are counted separately', built.carried === 1);
}

console.log('\n--- the shipped catalogue ---');
{
  const dir = JSON.parse(readFileSync(new URL('../data/directory.json', import.meta.url), 'utf8'));
  check('every entry has a board', dir.entries.every((e) => e.ats && e.slug),
    'a row without a board is a promise the tool cannot keep');
  const names = dir.entries.map((e) => e.name.toLowerCase());
  check('no company is listed twice', new Set(names).size === names.length);
  check('nothing is listed and unlisted at once',
    !dir.unlisted.some((u) => names.includes(u.name.toLowerCase())));

  // Descriptions describe. They do not rate: whether somewhere is a good place
  // to work is the reader's call, and a catalogue that answers it for them is
  // making a claim it cannot support about hundreds of employers.
  const judgy = /\b(best|great|amazing|toxic|avoid|terrible|excellent|worst|top|award[- ]winning)\b/i;
  const rated = dir.entries.filter((e) => judgy.test(e.description));
  check('no description rates the employer', rated.length === 0,
    rated.map((e) => e.name).join(', '));

  check('the catalogue is worth scrolling', dir.entries.length >= 250, `${dir.entries.length}`);

  // The old catalogue was a quarter one segment. A list for everybody should
  // not lean that hard on the interests of whoever assembled it.
  const spread = balance(dir.entries);
  check('no category is more than a fifth of it',
    spread[0][1] / dir.entries.length <= 0.2, `${spread[0][0]} is ${spread[0][1]}`);
  check('the spread is wide', spread.length >= 12, `${spread.length} categories`);

  // Everything rejected on review must stay rejected.
  const rejected = JSON.parse(readFileSync(new URL('../data/rejected.json', import.meta.url), 'utf8'));
  const shipped = new Set(dir.entries.map((e) => e.name.toLowerCase()));
  const leaked = rejected.rejected.filter((r) => shipped.has(r.name.toLowerCase()));
  check('nothing rejected on review is shipped', leaked.length === 0, leaked.map((r) => r.name).join(', '));
  check('every rejection says why', rejected.rejected.every((r) => r.reason && r.reason.length > 15));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
