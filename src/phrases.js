// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// Counting what keeps turning up.
//
// Pure text analysis, separated from the command that fetches the postings to
// feed it. Both runtimes ask the same question of the same words; only the
// fetching differs.
// ---------------------------------------------------------------------------
import { fetchCompanyJobs } from './boards.js';
import { matchJob } from './match.js';
import { evaluateSalary } from './salary.js';
import { compileRules } from './rules.js';

const NOISE = new Set([
  'a', 'an', 'and', 'the', 'of', 'to', 'for', 'in', 'at', 'on', 'with', 'or',
  'our', 'new', 'we', 'you', 'your', 'is', 'are', 'be', 'as', 'by', 'from',
  'i', 'ii', 'iii', 'iv', 'v', 'jr', 'sr', 'level', 'full', 'part', 'time',
  'remote', 'hybrid', 'onsite', 'us', 'usa', 'uk', 'emea', 'apac', 'global',
]);

export const tokenise = (title) =>
  String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#/\s-]/g, ' ')
    .split(/[\s/]+/)
    .map((w) => w.replace(/^-+|-+$/g, ''))
    .filter(Boolean);

/** Every n-word run in a token list. */
export function phrases(tokens, n) {
  const out = [];
  for (let i = 0; i + n <= tokens.length; i++) out.push(tokens.slice(i, i + n).join(' '));
  return out;
}

/** Is this phrase something the rules already speak for? */
export function alreadyCovered(phrase, rules) {
  const lists = [rules.title, rules.body, rules.exclude, rules.bodyRequiresTitleHint];
  return lists.some((list) => (list || []).some((p) => p.re.test(phrase)));
}

/**
 * Counts recurring phrases in a set of titles, grouped by phrase length.
 *
 * Grouping by length rather than merging is deliberate. Overlapping n-grams
 * can't be ranked against each other honestly — "engineer" outnumbers
 * "backend engineer", which outnumbers "senior backend engineer", and every
 * scheme for collapsing them buries either the general phrase or the specific
 * one. Three short lists say more than one clever one.
 */
export function countPhrases(titles, { rules, maxN = 3, minCount = 2 } = {}) {
  const groups = [];

  for (let n = maxN; n >= 1; n--) {
    const counts = new Map();
    const examples = new Map();

    for (const title of titles) {
      const tokens = tokenise(title);
      // One posting can't count twice for the same phrase.
      for (const phrase of new Set(phrases(tokens, n))) {
        if (phrase.split(' ').every((w) => NOISE.has(w))) continue;
        if (/^[\d\s+-]+$/.test(phrase)) continue;
        if (rules && alreadyCovered(phrase, rules)) continue;
        counts.set(phrase, (counts.get(phrase) || 0) + 1);
        if (!examples.has(phrase)) examples.set(phrase, title);
      }
    }

    const ranked = [...counts.entries()]
      .filter(([, count]) => count >= minCount)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([phrase, count]) => ({ phrase, count, example: examples.get(phrase) }));

    groups.push({ n, ranked });
  }

  return groups;
}

/** Counts distinct values, most common first. */
export function tally(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// ---------------------------------------------------------------------------
