#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// Turning probe results into the shipped catalogue.
//
//   node src/catalogue.js            merge data/prospects/* into the directory
//   node src/catalogue.js --report   say what would change, write nothing
//
// The counterpart to prospect.js, and the point at which a probe result
// becomes something users see. Everything here is a rule about what is fit to
// ship rather than what resolved:
//
//   - A board that answered is kept; anything else is dropped entirely. No
//     "coming soon" rows, no names with nothing behind them.
//   - A company already in the catalogue whose board stopped answering is
//     reported, not silently deleted — a board can be down for a morning, and
//     losing a company to a blip is worse than carrying it a week longer.
//   - Descriptions say what a company does. They never say whether it is a
//     good place to work: that is a judgement this catalogue has no business
//     making on someone else's behalf.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** A Recruitee trial account nobody finished setting up still advertises this. */
const SAMPLE_POSTING = /\(sample\)/i;

/**
 * Probe results that must not ship, and why.
 *
 * Two kinds, and only one of them can be spotted mechanically.
 *
 * The mechanical kind: a board still showing the sample posting a Recruitee
 * trial creates, and a slug two different candidates both resolved to — one
 * of them is wrong and nothing here can say which.
 *
 * The other kind needs eyes. `greenhouse/carbon` returns sixteen real
 * postings for hardware engineers, which is a perfectly healthy board
 * belonging to Carbon, the 3D printing company, and not to Carbon Health. No
 * heuristic separates that from `lever/veeva`, where dropping "Systems" from
 * the name is exactly right. Those live in data/rejected.json, written down
 * with a reason so the same false positive is not rediscovered next time.
 */
export function screenRecords(records, rejected = []) {
  const byName = new Map(rejected.map((r) => [r.name.toLowerCase(), r.reason]));
  const dropped = [];
  const surviving = [];

  // First the two judgements that stand on their own: a name somebody already
  // ruled out, and a board still advertising a trial account's sample post.
  for (const r of records) {
    if (!r.resolved) { surviving.push(r); continue; }
    const reviewed = byName.get(r.name.toLowerCase());
    if (reviewed) { dropped.push({ ...r, why: reviewed }); continue; }
    if (r.titles?.some((t) => SAMPLE_POSTING.test(t))) {
      dropped.push({ ...r, why: 'Unclaimed board still showing its sample posting' });
      continue;
    }
    surviving.push(r);
  }

  // Only then count who claims each board — and only among what is left.
  //
  // Counting before the reviewed rejections took Stripe and Cloudflare out of
  // the catalogue: "Stripe Tax" is a product rather than an employer, and once
  // it is removed by review the parent is not in contention with anybody. A
  // collision is only a collision between candidates that are still standing.
  const claimed = new Map();
  for (const r of surviving) {
    if (!r.resolved) continue;
    const key = `${r.ats}/${r.slug}`;
    claimed.set(key, (claimed.get(key) || 0) + 1);
  }

  const kept = [];
  for (const r of surviving) {
    if (r.resolved && claimed.get(`${r.ats}/${r.slug}`) > 1) {
      dropped.push({ ...r, why: `Two companies resolved to ${r.ats}/${r.slug}; one of them is wrong` });
      continue;
    }
    kept.push(r);
  }
  return { kept, dropped };
}

/** Everything the shards found, in one list, newest answer winning. */
export function gatherRecords(shards) {
  const byName = new Map();
  for (const shard of shards) {
    for (const record of shard.records || []) byName.set(record.name.toLowerCase(), record);
  }
  return [...byName.values()];
}

/**
 * The catalogue that should ship, and what changed to get there.
 *
 * `existing` is the current directory, so a company that has been listed for
 * months and failed to answer once can be told apart from a name that never
 * resolved at all.
 */
export function buildCatalogue(records, existing = { entries: [], unlisted: [] }) {
  const resolved = records.filter((r) => r.resolved);
  const listed = new Map((existing.entries || []).map((e) => [e.name.toLowerCase(), e]));

  const entries = resolved
    .map((r) => ({
      name: r.name,
      description: r.description,
      category: r.category,
      ats: r.ats,
      slug: r.slug,
    }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  const found = new Set(resolved.map((r) => r.name.toLowerCase()));

  // Listed before, silent now. Kept, and reported for a person to look at.
  const stale = (existing.entries || []).filter((e) => {
    const probed = records.some((r) => r.name.toLowerCase() === e.name.toLowerCase());
    return probed && !found.has(e.name.toLowerCase());
  });
  for (const e of stale) entries.push(e);
  entries.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  // Probed, never answered, and not previously listed. Recorded so the next
  // person to wonder "why isn't Costco in here?" has the answer.
  //
  // A reason written by hand always wins. "Workday" or "acquired by IBM; jobs
  // now served internally" is worth keeping; a probe can only ever report that
  // it looked and found nothing, which is true but much less use to a reader.
  const priorReason = new Map((existing.unlisted || []).map((u) => [u.name.toLowerCase(), u.reason]));
  const unlisted = records
    .filter((r) => !r.resolved && !listed.has(r.name.toLowerCase()))
    .map((r) => ({
      name: r.name,
      reason: priorReason.get(r.name.toLowerCase()) || 'No board found on a supported ATS',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Anything hand-documented that this run never probed stays where it is.
  for (const u of existing.unlisted || []) {
    const name = u.name.toLowerCase();
    if (!records.some((r) => r.name.toLowerCase() === name) && !found.has(name)) unlisted.push(u);
  }
  unlisted.sort((a, b) => a.name.localeCompare(b.name));

  return {
    entries,
    unlisted,
    added: entries.filter((e) => !listed.has(e.name.toLowerCase())).length,
    carried: resolved.filter((r) => r.carried).length,
    stale: stale.map((e) => e.name),
  };
}

/** Counts by category, for judging whether the catalogue leans anywhere. */
export function balance(entries) {
  const counts = {};
  for (const e of entries) counts[e.category] = (counts[e.category] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

// --- command line -----------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const REPORT = process.argv.includes('--report');
  const dir = fileURLToPath(new URL('../data/prospects', import.meta.url));
  const target = fileURLToPath(new URL('../data/directory.json', import.meta.url));

  if (!existsSync(dir)) {
    console.error('No probe results. Run the prospect workflow first.');
    process.exit(1);
  }

  const shards = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')));
  const rejectedFile = fileURLToPath(new URL('../data/rejected.json', import.meta.url));
  const { rejected } = existsSync(rejectedFile)
    ? JSON.parse(readFileSync(rejectedFile, 'utf8'))
    : { rejected: [] };

  const { kept, dropped } = screenRecords(gatherRecords(shards), rejected);
  const existing = JSON.parse(readFileSync(target, 'utf8'));
  const built = buildCatalogue(kept, existing);

  console.log(`${shards.length} shards, ${kept.length + dropped.length} probed`);
  console.log(`${dropped.length} boards answered but were rejected on review`);
  console.log(`${built.entries.length} companies with a working board`);
  console.log(`  ${built.added} new, ${built.carried} re-validated`);
  console.log(`  ${built.unlisted.length} probed and dropped\n`);
  for (const [cat, n] of balance(built.entries)) {
    console.log(`  ${cat.padEnd(20)} ${String(n).padStart(3)}`);
  }
  if (built.stale.length) {
    console.log(`\nListed but silent this run — check before removing:\n  ${built.stale.join(', ')}`);
  }

  if (REPORT) { console.log('\nReport only — nothing written.'); process.exit(0); }

  writeFileSync(target, JSON.stringify({
    name: existing.name,
    description: existing.description,
    updated: new Date().toISOString().slice(0, 10),
    entries: built.entries,
    unlisted: built.unlisted,
  }, null, 1) + '\n');
  console.log(`\nWrote ${built.entries.length} entries to data/directory.json.`);
}
