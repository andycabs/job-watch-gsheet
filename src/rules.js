// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// Rule compilation.
//
// Everything the matcher knows arrives here as user input — from the sheet, or
// from a starter template. This module owns the one job of turning that input
// into regexes, so a spreadsheet row and a template file take the same path.
//
// Two accepted forms:
//
//   staff engineer      a phrase. Whole words, case-insensitive, flexible
//                       whitespace. "staff engineer" will not match "staffing".
//
//   /\b(back|front)[\s-]?end\b/   a regex, for alternation a plain phrase can't
//                       express — one rule covering backend / back-end /
//                       back end. Templates use this; users needn't know it
//                       exists.
//
// There are no built-in patterns. Blank config matches nothing, by design —
// `src/rules.test.js` asserts it, and that assertion is what proves no domain
// assumptions have crept back into the engine.
// ---------------------------------------------------------------------------

/** Escapes a plain phrase into a whole-word, whitespace-tolerant regex source. */
function phraseSource(text) {
  return text
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  // literal metacharacters
    .replace(/\s+/g, '\\s+');                // "staff  engineer" still matches
}

/**
 * Compiles one entry into { label, re, source }, or null if unusable.
 * `label` is what the user typed — it's what shows up in the sheet's Matched
 * column and in the debugger, so it stays human-readable.
 */
export function compilePattern(entry) {
  if (entry == null) return null;

  // Two input shapes. A template file lists bare strings; a sheet row arrives
  // as an object carrying the note and the row number alongside the pattern,
  // and those travel with the compiled rule so the debugger can say which row
  // fired rather than only what it matched.
  const object = typeof entry === 'object' && entry !== null && 'pattern' in entry;
  const extras = object
    ? { ...(entry.note ? { note: entry.note } : {}), ...(entry.row ? { row: entry.row } : {}) }
    : {};

  const raw = String(object ? entry.pattern ?? '' : entry).trim();
  if (!raw) return null;

  // /pattern/flags — power-user and template form.
  const asRegex = raw.match(/^\/(.+)\/([a-z]*)$/is);
  if (asRegex) {
    const [, source, flags] = asRegex;
    try {
      return {
        label: raw,
        re: new RegExp(source, flags.includes('i') ? flags : `${flags}i`),
        source,
        kind: 'regex',
        ...extras,
      };
    } catch (err) {
      return { label: raw, error: `invalid regex: ${err.message}`, kind: 'regex', ...extras };
    }
  }

  // Plain phrase. Word boundaries only where the text actually starts or ends
  // on a word character, so an entry like "c++" still compiles to something
  // that can match.
  const lead = /^\w/.test(raw) ? '\\b' : '';
  const tail = /\w$/.test(raw) ? '\\b' : '';
  const source = `${lead}${phraseSource(raw)}${tail}`;
  return { label: raw, re: new RegExp(source, 'i'), source, kind: 'phrase', ...extras };
}

/** Compiles a list, separating usable patterns from reportable problems. */
export function compileList(entries = []) {
  const patterns = [];
  const problems = [];
  for (const entry of entries) {
    const compiled = compilePattern(entry);
    if (!compiled) continue;                       // blank — silently skipped
    if (compiled.error) problems.push(`"${compiled.label}" — ${compiled.error}`);
    else patterns.push(compiled);
  }
  return { patterns, problems };
}

/** A rule set that matches nothing. The starting point for every run. */
export function emptyRules() {
  return {
    title: [],
    body: [],
    exclude: [],
    // Optional gate: when non-empty, a body signal only counts if the title
    // matches one of these too. Guards against flagging every backend role
    // that mentions a tool in passing. Empty = body signals stand alone.
    bodyRequiresTitleHint: [],
    location: { mode: 'any', allowlist: [] },
    problems: [],
  };
}

/**
 * Builds a rule set from raw config.
 *
 * Accepts the shape a template file uses and the shape assembled from sheet
 * rows — they're the same object. Anything absent falls back to "no rule",
 * never to a default pattern.
 */
export function compileRules(input = {}) {
  const rules = emptyRules();
  const problems = [];

  for (const key of ['title', 'body', 'exclude', 'bodyRequiresTitleHint']) {
    const { patterns, problems: p } = compileList(input[key]);
    rules[key] = patterns;
    problems.push(...p.map((msg) => `${key}: ${msg}`));
  }

  const loc = input.location || {};
  const mode = String(loc.mode || 'any').toLowerCase();
  // The allowlist goes through the same compiler as every other rule, so
  // "united states" matches whole words and /us|usa/ works. Plain substrings
  // were quietly wrong: "us" is inside Australia and Austria.
  const { patterns: allowlist, problems: allowProblems } = compileList(loc.allowlist);
  rules.location = {
    mode: mode === 'remote-only' ? 'remote-only' : 'any',
    allowlist,
  };
  problems.push(...allowProblems.map((msg) => `location allowlist: ${msg}`));
  if (loc.mode && rules.location.mode !== mode) {
    problems.push(`location: unknown mode "${loc.mode}" — using "any"`);
  }

  rules.problems = problems;
  return rules;
}

// ---------------------------------------------------------------------------
// Work-arrangement detection
//
// Not domain knowledge — this is about where a job is done, which means the
// same thing for every job family. Kept in code rather than config so users
// aren't asked to enumerate synonyms for "remote".
//
// The two lists differ deliberately. "Distributed" and "global" mean remote in
// a location field but are ordinary words in a title: matching them there let
// "Engineer, Distributed Systems" in Dublin pass a remote-only filter.
// ---------------------------------------------------------------------------
export const REMOTE_LOCATION = [
  /\bremote\b/i, /\banywhere\b/i, /\bdistributed\b/i,
  /\bwork from home\b/i, /\bglobal\b/i, /\bwfh\b/i,
];

export const REMOTE_TITLE = [
  /\bremote\b/i, /\banywhere\b/i, /\bwork from home\b/i,
];

export function locationAllows(job, rules) {
  const { mode, allowlist } = rules.location;
  const location = String(job.location || '');

  if (mode === 'remote-only') {
    // The board's own flag first, where it has one. Text matching is the
    // fallback for boards that don't (Greenhouse), and an additional way in
    // for a posting whose flag is unset but whose location says "Remote".
    const remote = job.remote === true
      || REMOTE_LOCATION.some((re) => re.test(location))
      || REMOTE_TITLE.some((re) => re.test(String(job.title || '')));
    if (!remote) {
      return {
        allowed: false,
        reason: job.remote === false
          ? `the board marks this on-site (${location || 'no location given'})`
          : `not remote (${location || 'no location given'})`,
      };
    }
  }

  if (allowlist.length) {
    // A location naming no geography — "Remote", "Anywhere", or nothing at all
    // — has nothing for an allowlist to reject. Dropping those loses the
    // genuinely unrestricted roles, which are the ones most worth seeing.
    if (!statesAPlace(location)) return { allowed: true, reason: null };

    if (!allowlist.some((p) => p.re.test(location))) {
      return {
        allowed: false,
        reason: `${location} is outside the allowlist (${allowlist.map((p) => p.label).join(', ')})`,
      };
    }
  }

  return { allowed: true, reason: null };
}

/**
 * Is there any geography here, or is this just "Remote"?
 *
 * Strips the remote vocabulary and punctuation; whatever survives is a place.
 * "United States (Remote)" leaves "United States"; "Remote — Anywhere" leaves
 * nothing.
 */
export function statesAPlace(location = '') {
  const rest = String(location)
    .replace(/\b(remote|anywhere|distributed|global|worldwide|work from home|wfh|hybrid|on[\s-]?site|flexible|any location)\b/gi, ' ')
    .replace(/[()\[\]{}\-–—,;/|·•+]/g, ' ')
    .trim();
  return rest.length > 1;
}
