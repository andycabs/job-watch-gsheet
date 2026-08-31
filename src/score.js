// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// Scoring a match, 0–100.
//
// Arithmetic only. No model runs here and none ever will — a score you can't
// reproduce by hand is a score you can't argue with, and the weights are in
// the settings tab precisely so disagreeing with one is a spreadsheet edit
// rather than a code change.
//
// Four signals, each scored 0–1 and then weighted:
//
//   title match       did a title rule fire, or only a body one
//   salary headroom   how far above the floor the pay reaches
//   seniority         does the title hit the band being targeted
//   freshness         how recently it was posted
//
// A signal the user hasn't configured scores 0.5 — neither rewarded nor
// punished. Scoring it 0 would push every posting down for a setting nobody
// filled in; scoring it 1 would make the score meaningless.
// ---------------------------------------------------------------------------

const NEUTRAL = 0.5;
const clamp = (n) => Math.max(0, Math.min(1, n));

/** Did a title rule fire, or did the match rest on the description alone? */
export function titleComponent(verdict) {
  if (!verdict?.matched) return 0;
  const tiers = new Set((verdict.signals || []).map((s) => s.tier));
  if (tiers.has('title')) return 1;
  if (tiers.has('body')) return 0.45;
  return NEUTRAL;
}

/**
 * How far the pay reaches above the floor.
 *
 * Doubling the floor is the top of the scale — beyond that the difference
 * stops being informative, and a single outlier would otherwise flatten every
 * other posting's score.
 */
export function salaryComponent(salary, settings = {}) {
  const floor = settings.salaryFloor;
  if (!floor) return NEUTRAL;          // no floor set: nothing to have headroom over
  if (!salary) return NEUTRAL;         // unpriced: the filter decides, not the score
  return clamp((salary.max - floor) / floor);
}

/** Does the title land in the seniority band being targeted? */
export function seniorityComponent(title = '', settings = {}) {
  const targets = settings.seniorityTarget || [];
  if (!targets.length) return NEUTRAL;
  const haystack = String(title).toLowerCase();
  return targets.some((t) => haystack.includes(t)) ? 1 : 0;
}

/**
 * Recency, decaying to zero at the staleness threshold.
 *
 * A posting with no date scores neutral rather than zero: plenty of boards
 * don't publish one, and that's not the posting's fault.
 */
export function freshnessComponent(postedAt, settings = {}, now = new Date()) {
  const stale = settings.stalePostingDays || 60;
  const days = ageInDays(postedAt, now);
  if (days === null) return NEUTRAL;
  return clamp(1 - days / stale);
}

export function ageInDays(postedAt, now = new Date()) {
  if (!postedAt) return null;
  const then = new Date(postedAt);
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 86400000));
}

/**
 * @returns {{ score: number, parts: Array<{name, value, weight, contribution}> }}
 *   `parts` is what the debugger prints — a score nobody can decompose is a
 *   number people learn to ignore.
 */
export function scoreJob({ job = {}, verdict, salary, settings = {} }, now = new Date()) {
  const components = [
    ['title match', titleComponent(verdict), settings.weightTitle],
    ['salary headroom', salaryComponent(salary, settings), settings.weightSalary],
    ['seniority', seniorityComponent(job.title, settings), settings.weightSeniority],
    ['freshness', freshnessComponent(job.postedAt, settings, now), settings.weightFreshness],
  ];

  const total = components.reduce((n, [, , w]) => n + (Number(w) || 0), 0);
  if (!total) return { score: 0, parts: [] };

  const parts = components.map(([name, value, weight]) => ({
    name,
    value: Math.round(value * 100) / 100,
    weight: Number(weight) || 0,
    contribution: Math.round(((Number(weight) || 0) * value / total) * 100),
  }));

  return { score: Math.round(parts.reduce((n, p) => n + p.contribution, 0)), parts };
}

/**
 * Where a figure sits in a population, as "top 15%".
 *
 * Returns null below `minimum` samples: a percentile drawn from four postings
 * is a number pretending to be information, and the sheet is better off blank
 * than confidently wrong.
 */
export function payRank(value, population = [], minimum = 8) {
  const sample = population.filter((n) => Number.isFinite(n) && n > 0);
  if (!Number.isFinite(value) || sample.length < minimum) return null;

  const below = sample.filter((n) => n < value).length;
  const equal = sample.filter((n) => n === value).length;
  // Midpoint of the tied block, so identical figures do not get different ranks.
  const percentile = (below + equal / 2) / sample.length;
  const top = Math.max(1, Math.round((1 - percentile) * 100));

  if (percentile >= 0.995) return 'highest seen';
  if (top <= 50) return `top ${top}%`;
  return `bottom ${Math.max(1, 100 - top)}%`;
}

/** "62 — title match 40, freshness 14, seniority 8, salary headroom 0" */
export function explainScore({ score, parts }) {
  const ranked = [...parts].sort((a, b) => b.contribution - a.contribution);
  return `${score} — ${ranked.map((p) => `${p.name} ${p.contribution}`).join(', ')}`;
}
