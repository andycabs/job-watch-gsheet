// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// What a pile of your own decisions has in common.
//
// Pure: rows in, leanings out. Separated from the command that reads those
// rows off a sheet, because the reading differs by runtime and the comparing
// does not.
// ---------------------------------------------------------------------------
import { TABS, readRange } from './sheet/schema.js';
import { tokenise, phrases, tally } from './phrases.js';
import { money } from './salary.js';

export const KEPT = ['interested', 'applied', 'interviewing'];
export const PASSED = ['passed', 'closed'];

/** Below this many judgements on each side, nothing here is worth saying. */
export const MINIMUM = 5;

export function splitByVerdict(rows, index = {}) {
  const kept = [];
  const passed = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const status = String(row[index.status] ?? '').trim().toLowerCase();
    const record = {
      title: String(row[index.title] ?? ''),
      company: String(row[index.company] ?? ''),
      salaryMax: Number(row[index.salaryMax]) || null,
      score: Number(row[index.score]) || null,
    };
    if (!record.title) continue;
    if (KEPT.includes(status)) kept.push(record);
    else if (PASSED.includes(status)) passed.push(record);
  }
  return { kept, passed };
}

/**
 * Phrases that lean one way or the other.
 *
 * Reported as "in 6 of 8 you passed on, 0 of 9 you kept" rather than as a
 * score, because the counts are the evidence and a single number would hide
 * how thin it might be.
 */
export function leaningPhrases(kept = [], passed = [], { maxN = 2, minCount = 2 } = {}) {
  kept = (kept || []).filter(Boolean);
  passed = (passed || []).filter(Boolean);
  const count = (records) => {
    const seen = new Map();
    for (const r of (records || []).filter(Boolean)) {
      const tokens = tokenise(r.title);
      const all = new Set();
      for (let n = 1; n <= maxN; n++) for (const p of phrases(tokens, n)) all.add(p);
      for (const p of all) seen.set(p, (seen.get(p) || 0) + 1);
    }
    return seen;
  };

  const inKept = count(kept);
  const inPassed = count(passed);
  const every = new Set([...inKept.keys(), ...inPassed.keys()]);

  const towards = [];
  const away = [];

  for (const phrase of every) {
    const k = inKept.get(phrase) || 0;
    const p = inPassed.get(phrase) || 0;
    if (k + p < minCount) continue;

    // A phrase in both piles says nothing; one that only ever appears on one
    // side is the whole signal.
    const keptShare = kept.length ? k / kept.length : 0;
    const passedShare = passed.length ? p / passed.length : 0;

    if (p >= minCount && k === 0 && passedShare >= 0.4) {
      away.push({ phrase, kept: k, passed: p, share: passedShare });
    } else if (k >= minCount && p === 0 && keptShare >= 0.4) {
      towards.push({ phrase, kept: k, passed: p, share: keptShare });
    }
  }

  const rank = (a, b) => b.share - a.share || (b.passed + b.kept) - (a.passed + a.kept);
  return { towards: towards.sort(rank), away: away.sort(rank) };
}

/** Companies you have judged enough times to have an opinion about. */
export function companyLeanings(kept, passed, minimum = 3) {
  const counts = new Map();
  const bump = (name, field) => {
    const key = String(name || '').trim();
    if (!key) return;
    if (!counts.has(key)) counts.set(key, { name: key, kept: 0, passed: 0 });
    counts.get(key)[field]++;
  };
  for (const r of (kept || []).filter(Boolean)) bump(r.company, 'kept');
  for (const r of (passed || []).filter(Boolean)) bump(r.company, 'passed');

  return [...counts.values()]
    .filter((c) => c.kept + c.passed >= minimum && (c.kept === 0 || c.passed === 0))
    .sort((a, b) => (b.kept + b.passed) - (a.kept + a.passed));
}

/** What the pay looked like on each side. */
export function salaryLeaning(kept = [], passed = []) {
  const figures = (rs) => (rs || []).filter(Boolean)
    .map((r) => r.salaryMax).filter((n) => Number.isFinite(n) && n > 0);
  const median = (ns) => {
    if (!ns.length) return null;
    const sorted = [...ns].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  };

  const k = figures(kept);
  const p = figures(passed);
  if (k.length < 3 || p.length < 3) return null;

  const lowestKept = Math.min(...k);
  return {
    keptMedian: median(k),
    passedMedian: median(p),
    lowestKept,
    // Only worth suggesting a floor if it would actually have cut something.
    wouldHaveCut: p.filter((n) => n < lowestKept).length,
    passedCount: p.length,
  };
}
