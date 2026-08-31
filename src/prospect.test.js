#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Tests for the catalogue builder.
//
// The thing worth protecting here is that a shard split loses nobody: a
// candidate silently dropped between shards is a company missing from the
// shipped catalogue with nothing to show it was ever considered.
import { readFileSync } from 'node:fs';
import { shardOf, recordFor } from './prospect.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
};

const items = Array.from({ length: 653 }, (_, i) => i);

console.log('--- sharding ---');
for (const total of [1, 2, 3, 6, 7, 16]) {
  const shards = Array.from({ length: total }, (_, i) => shardOf(items, i + 1, total));
  const flat = shards.flat();
  check(`${total} shards cover everything exactly once`,
    flat.length === items.length && new Set(flat).size === items.length,
    `${flat.length} items`);
  check(`${total} shards stay in order`, flat.every((v, i) => v === items[i]));
  const sizes = shards.map((s) => s.length);
  check(`${total} shards are balanced`, Math.max(...sizes) - Math.min(...sizes) <= 1, sizes.join(','));
}

check('more shards than items still loses nobody', shardOf([1, 2], 1, 4).length + shardOf([1, 2], 2, 4).length
  + shardOf([1, 2], 3, 4).length + shardOf([1, 2], 4, 4).length === 2);

for (const [i, n] of [[0, 3], [4, 3], [1, 0]]) {
  let threw = false;
  try { shardOf(items, i, n); } catch { threw = true; }
  check(`shard ${i}/${n} is refused`, threw);
}

console.log('\n--- what a probe records ---');
{
  const candidate = { name: 'Acme', category: 'saas', description: 'Widgets' };
  const r = recordFor(candidate, {
    ats: 'greenhouse', slug: 'acme', count: 12, titles: ['Staff Engineer'], attempts: [1, 2],
  });
  check('a hit keeps what the catalogue needs',
    r.resolved && r.ats === 'greenhouse' && r.slug === 'acme' && r.category === 'saas');
  check('and the sample titles', r.titles[0] === 'Staff Engineer',
    'a slug can belong to a different company with the same name');
  check('and a link to check by eye', typeof r.board === 'string' && r.board.includes('acme'));
  check('a newly found company is not marked carried', r.carried === false);
}
{
  const known = { name: 'Acme', category: 'saas', description: 'W', ats: 'greenhouse', slug: 'acme' };
  const r = recordFor(known, { ats: 'greenhouse', slug: 'acme', count: 3, titles: [], attempts: [1] });
  check('re-validating a known board is marked carried', r.carried === true);
}
{
  const r = recordFor({ name: 'Nowhere' }, { ats: null, slug: null, attempts: [1, 2, 3] });
  check('a miss records how hard it looked', r.resolved === false && r.tried === 3);
  check('and carries no board fields', r.ats === undefined && r.slug === undefined);
}

console.log('\n--- the candidate list ---');
{
  const { candidates } = JSON.parse(readFileSync(new URL('../data/candidates.json', import.meta.url), 'utf8'));
  check('there are candidates to probe', candidates.length > 300, `${candidates.length}`);
  const names = candidates.map((c) => c.name.toLowerCase());
  check('no duplicate names', new Set(names).size === names.length);
  check('every candidate has a category and a description',
    candidates.every((c) => c.category && c.description));

  // The old catalogue was a quarter GTM tooling — one person's segment. A
  // catalogue meant for everyone should not lean that hard on any one.
  const counts = {};
  for (const c of candidates) counts[c.category] = (counts[c.category] || 0) + 1;
  const biggest = Math.max(...Object.values(counts));
  check('no category is more than a fifth of the list',
    biggest / candidates.length <= 0.2,
    `largest is ${biggest}/${candidates.length}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
