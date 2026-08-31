// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// The matcher.
//
// A pure function: (job, rules) in, a verdict out. It imports no configuration
// and holds no state, so the same posting and the same rules always produce the
// same answer — which is what makes the debugger trustworthy and the tests
// meaningful.
//
// The verdict is deliberately verbose. It records every signal that fired and,
// on a rejection, which stage rejected it and why. That single shape serves
// three consumers: the sheet's Matched column, the scorer, and the "why didn't
// this match?" debugger.
// ---------------------------------------------------------------------------
import { locationAllows } from './rules.js';

/**
 * @returns {{
 *   matched: boolean,
 *   stage: 'excluded'|'location'|'no-signal'|'matched',
 *   reason: string|null,
 *   signals: Array<{tier: 'title'|'body', label: string}>,
 *   tier: 'title'|'body'|null,
 * }}
 */
export function matchJob(job, rules) {
  const title = String(job?.title || '');
  const body = String(job?.body || '');

  const verdict = {
    matched: false,
    stage: 'no-signal',
    reason: null,
    signals: [],
    tier: null,
  };

  // --- 1. signals ---------------------------------------------------------
  // Collected before anything is rejected, so a rejection can say what it
  // cost. "Excluded by 'intern'" and "would have matched 'staff engineer',
  // excluded by 'intern'" are different facts, and the second is the one that
  // reveals an exclusion broader than its author intended.
  const titleHits = rules.title.filter((p) => p.re.test(title));
  for (const p of titleHits) verdict.signals.push({ tier: 'title', label: p.label });

  // A body-only signal is noisy on its own — a posting mentioning a tool in
  // passing isn't necessarily the job you want. When `bodyRequiresTitleHint`
  // is configured, body signals only count if the title is at least adjacent.
  // Left empty, body signals stand alone.
  const hints = rules.bodyRequiresTitleHint || [];
  const titleIsAdjacent = hints.length === 0 || hints.some((p) => p.re.test(title));

  if (body && titleIsAdjacent) {
    const bodyHits = rules.body.filter((p) => p.re.test(body));
    for (const p of bodyHits) verdict.signals.push({ tier: 'body', label: p.label });
  }

  // --- 2. exclusions ------------------------------------------------------
  // Hard, and still checked before the signals are allowed to count: a user
  // who excludes "account executive" sees it gone, not demoted. Collecting the
  // signals first changes nothing about that — it only means the verdict can
  // report what the exclusion cost.
  const excluded = rules.exclude.find((p) => p.re.test(title));
  if (excluded) {
    verdict.stage = 'excluded';
    verdict.reason = verdict.signals.length
      ? `matched ${verdict.signals.map((s) => `"${s.label}"`).join(', ')}, ` +
        `then excluded by "${excluded.label}"`
      : `title matched exclusion "${excluded.label}"`;
    return verdict;
  }

  if (!verdict.signals.length) {
    verdict.stage = 'no-signal';
    verdict.reason = body || !rules.body.length
      ? 'no title or body rule matched'
      : 'no title rule matched, and this board returns no descriptions';
    return verdict;
  }

  // --- 3. location --------------------------------------------------------
  const location = locationAllows(job, rules);
  if (!location.allowed) {
    verdict.stage = 'location';
    verdict.reason = location.reason;
    return verdict;
  }

  verdict.matched = true;
  verdict.stage = 'matched';
  verdict.tier = verdict.signals.some((s) => s.tier === 'title') ? 'title' : 'body';
  return verdict;
}

/** Comma-joined signal labels, for the sheet's Matched column. */
export function signalSummary(verdict) {
  return verdict.signals.map((s) => s.label).join(', ');
}
