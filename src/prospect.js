#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// Building the catalogue: probe a list of company names, keep what resolves.
//
//   node src/prospect.js --shard 1/6            probe a sixth of the list
//   node src/prospect.js --limit 20 --dry-run   show the plan, contact nothing
//
// This is a maintenance tool, not something a user runs. It reads
// data/candidates.json, works out where each company posts its jobs, and
// writes the answers to data/prospects/shard-N.json for `npm run catalogue`
// to merge into data/directory.json.
//
// It exists because a catalogue of companies is only worth shipping if every
// row has been checked against a live board. A name somebody remembers is a
// guess; a name that returned twelve postings this morning is a fact.
//
// Sharded because the arithmetic is unforgiving: a company that is not on any
// supported board costs one request per slug per board before it can be ruled
// out. Six shards keeps a full pass inside a normal Actions run without
// raising the request rate any single board sees to something rude.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, ATS_NAMES } from './boards.js';
import { probeOrder, REQUEST_DELAY_MS } from './probe.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Tries candidates until one returns postings.
 *
 * `probe` is injected so tests can drive this without a network: it takes
 * (ats, slug) and returns { count, titles }, or null when the board doesn't
 * exist.
 *
 * A board that exists but is empty counts as a miss — an empty response is
 * indistinguishable from a wrong slug, and recording it would silently retire
 * a company that simply isn't hiring this week.
 *
 * A board that exists and belongs to someone else cannot be detected from
 * here. Slugs are first-come-first-served, so "gong" on one ATS is a
 * revenue-intelligence company and on another a media startup in New York,
 * and both return a healthy list of jobs. The sample titles come back with
 * the result for exactly that reason: it is a judgement only a person can
 * make, so give them what they need to make it in one glance.
 */
async function resolveCompany(company, { probe, delayMs = REQUEST_DELAY_MS, onAttempt } = {}) {
  const attempts = [];
  for (const candidate of probeOrder(company)) {
    const result = await probe(candidate.ats, candidate.slug);
    const count = result?.count ?? 0;
    attempts.push({ ...candidate, count });
    onAttempt?.({ ...candidate, count });
    if (count) return { ...candidate, count, titles: result.titles || [], attempts };
    if (delayMs) await sleep(delayMs);
  }
  return { ats: null, slug: null, count: 0, titles: [], attempts };
}

/**
 * Deterministic, contiguous shards.
 *
 * Contiguous rather than round-robin so a shard's log reads as a run through
 * one part of the list, which makes a failure easy to place by eye.
 */
export function shardOf(items, index, total) {
  if (total < 1 || index < 1 || index > total) {
    throw new Error(`bad shard ${index}/${total}`);
  }
  // Spread the remainder across the leading shards rather than dumping it on
  // the last one. Wall-clock time is the slowest shard, so a split that is
  // even to within one item is the difference between six equal runs and five
  // fast ones waiting on a straggler.
  const base = Math.floor(items.length / total);
  const extra = items.length % total;
  const start = (index - 1) * base + Math.min(index - 1, extra);
  return items.slice(start, start + base + (index <= extra ? 1 : 0));
}

/**
 * What to keep from a resolution.
 *
 * A board that answers is not proof the slug is the company we meant — slugs
 * are first-come-first-served, so sample titles ride along for a human to
 * check before any of this is published.
 */
export function recordFor(candidate, result) {
  if (!result?.ats || !result?.slug) {
    return { name: candidate.name, resolved: false, tried: result?.attempts?.length ?? 0 };
  }
  return {
    name: candidate.name,
    category: candidate.category,
    description: candidate.description,
    resolved: true,
    ats: result.ats,
    slug: result.slug,
    count: result.count,
    titles: result.titles || [],
    board: ADAPTERS[result.ats].board(result.slug),
    // A slug that was already known and still answers is a re-validation, not
    // a discovery. Worth distinguishing when reading the merge report.
    carried: Boolean(candidate.slug) && candidate.slug === result.slug,
  };
}

async function probeBoard(ats, slug) {
  try {
    const jobs = await ADAPTERS[ats].fetchJobs(slug);
    if (!Array.isArray(jobs) || !jobs.length) return null;
    return { count: jobs.length, titles: jobs.slice(0, 3).map((j) => j.title).filter(Boolean) };
  } catch {
    return null;
  }
}

// --- command line -----------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1];
  };
  const DRY = argv.includes('--dry-run');
  const [index, total] = String(arg('--shard', '1/1')).split('/').map(Number);
  const limit = Number(arg('--limit', '0'));

  const file = fileURLToPath(new URL('../data/candidates.json', import.meta.url));
  let { candidates } = JSON.parse(readFileSync(file, 'utf8'));
  if (limit > 0) candidates = candidates.slice(0, limit);

  const mine = shardOf(candidates, index, total);
  console.log(`shard ${index}/${total}: ${mine.length} of ${candidates.length} candidates`);
  console.log(`up to ~${Math.ceil(mine.length * 4 * ATS_NAMES.length * REQUEST_DELAY_MS / 60000)} min worst case\n`);

  if (DRY) {
    for (const c of mine) console.log(`  ${c.name}${c.ats ? `  (hint: ${c.ats}/${c.slug})` : ''}`);
    process.exit(0);
  }

  const records = [];
  for (const candidate of mine) {
    const result = await resolveCompany(candidate, { probe: probeBoard });
    const record = recordFor(candidate, result);
    records.push(record);
    console.log(record.resolved
      ? `${candidate.name.padEnd(32)} ${record.ats}/${record.slug}  ${record.count} jobs${record.carried ? '  (carried)' : ''}`
      : `${candidate.name.padEnd(32)} —  (${record.tried} tried)`);
  }

  const dir = fileURLToPath(new URL('../data/prospects', import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/shard-${index}.json`, JSON.stringify({ index, total, records }, null, 1) + '\n');

  const found = records.filter((r) => r.resolved).length;
  console.log(`\n${found} of ${records.length} resolved.`);
}
