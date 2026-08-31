// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// Working out where a company posts its jobs — the deciding part.
//
// Which candidates to try and in what order, and what to write back. The
// probing itself belongs to whichever runtime is doing the fetching.
// ---------------------------------------------------------------------------
import { ADAPTERS, ATS_NAMES } from './boards.js';
import { TABS, columnIndex, colLetter } from './sheet/schema.js';

export const REQUEST_DELAY_MS = 1200;


/**
 * Slug candidates for a company name, most likely first.
 *
 * Real examples this is shaped by: "Hims & Hers" is `himshers`, "Apollo.io" is
 * `apollo`, "1Password" is `1password`. Anything already in the row is tried
 * first — a slug someone typed by hand beats anything guessed from a name.
 */
export function slugVariants(name, existing = '') {
  const base = String(name || '').toLowerCase().trim();
  const stripped = base.replace(/[^a-z0-9]/g, '');

  const candidates = [
    existing,
    stripped,                                     // hims & hers -> himshers
    base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),  // -> hims-hers
    base.replace(/\.(io|com|ai|co|dev|app|xyz)$/i, '').replace(/[^a-z0-9]/g, ''),
    base.split(/\s+/)[0].replace(/[^a-z0-9]/g, ''),          // first word alone
    // Drop a trailing legal suffix: "Acme Labs Inc" -> "acmelabs"
    base.replace(/\s+(inc|llc|ltd|corp|co|gmbh|limited)\.?$/i, '').replace(/[^a-z0-9]/g, ''),
  ];

  return [...new Set(candidates.map((c) => String(c || '').trim()).filter(Boolean))];
}

/**
 * Every (ats, slug) pair to try, in order.
 *
 * Two orderings, because which one converges faster depends on what's known:
 *
 *   ATS stated — exhaust that board first. It's usually right and only the
 *   slug is missing, which turns six boards of probing into a handful of
 *   requests.
 *
 *   ATS unknown — sweep the best slug across every board before trying the
 *   second slug anywhere. The first slug candidate is right far more often
 *   than any particular board is, so this finds the answer sooner than
 *   working through one board's variants at a time.
 */
export function probeOrder(company, atsNames = ATS_NAMES) {
  const known = atsNames.includes(company.ats) ? company.ats : null;
  const slugs = slugVariants(company.name, company.slug);
  const rest = atsNames.filter((a) => a !== known);

  const bySlug = slugs.flatMap((slug) => rest.map((ats) => ({ ats, slug })));
  if (!known) return bySlug;
  return [...slugs.map((slug) => ({ ats: known, slug })), ...bySlug];
}


/**
 * The writes that record a result.
 *
 * Every one targets `scriptRange` on the companies tab — the contiguous block
 * to the right of everything a person types. The name, category and note in
 * that row cannot be reached from here, which is the whole point of ordering
 * the columns that way.
 */
export function planDiscoveryWrites(results, today = new Date().toISOString().slice(0, 10)) {
  const tab = TABS.companies;
  const first = columnIndex(tab, 'ats');
  const last = tab.columns.length - 1;

  return results
    .filter((r) => r.ats && r.slug)
    .map((r) => ({
      op: 'writeRange',
      range: `${tab.name}!${colLetter(first)}${r.row}:${colLetter(last)}${r.row}`,
      values: [[r.ats, r.slug, today]],
    }));
}
