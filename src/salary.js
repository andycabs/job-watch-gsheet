// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// Reading pay out of a posting.
//
// One band per posting. A posting quoting "base $140k–160k, OTE $280k–320k"
// states two facts, and this keeps the one worth comparing: OTE when it is
// stated, base otherwise. The `basis` field records which it was, so a number
// that looks wrong can be traced without re-running anything.
//
// Two sources, in priority order:
//
//   1. Structured compensation, when the ATS provides it. Ashby and some
//      Greenhouse boards do. Reliable, and it labels its own components.
//   2. Regex over the description text. Best-effort — postings write pay a
//      hundred different ways, and this will never get all of them.
//
// The rule for unlabelled figures: a range with no qualifier is read as base,
// and where two are given with nothing to tell them apart, the lower one wins.
// Postings that mean OTE nearly always say so, because the number flatters
// them; a bare range is the conservative reading, and under-promising is the
// right failure direction for a filter.
//
// Everything here returns a `basis` string describing what it read and where
// from. It lands in the sheet's "Salary basis" column, so a wrong number can
// be traced without re-running anything.
// ---------------------------------------------------------------------------

export const ASSUMED_HOURS_PER_YEAR = 2080;

/** Below or above these, a figure is not an annual salary. */
const FLOOR = 25000;
const CEILING = 2000000;

const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+|\d{2,4}(?:\.\d)?\s*[kK]\b|\d{5,7})`;
const CURRENCY = String.raw`(?:\$|USD\s*|US\$\s*)?`;

const RANGE_RE = new RegExp(
  `${CURRENCY}\\s*${AMOUNT}\\s*(?:-|–|—|to|and|up to)\\s*${CURRENCY}\\s*${AMOUNT}`, 'g'
);
const SINGLE_RE = new RegExp(`${CURRENCY}\\s*${AMOUNT}`, 'g');
const HOURLY_RE = /(?:\$|USD\s*)\s*(\d{2,3}(?:\.\d{1,2})?)\s*(?:\/|\s+per\s+)\s*(?:hr|hour)/gi;

// What marks a figure as on-target rather than base. "Total compensation" is
// included: when a posting quotes one it means salary plus variable, which is
// the same thing a filter on OTE is asking about.
const OTE_MARKERS = /\b(ote|on[-\s]?target earnings|on[-\s]?target compensation|total (?:target )?(?:comp|compensation|cash)|ttc|base \+|plus commission|(?:with|including|inclusive of|uncapped) commission)\b/i;
const BASE_MARKERS = /\b(base salary|base pay|base compensation|annual base|salary range|base range|starting salary)\b/i;
// Figures that are money but not pay.
const NOT_PAY = /\b(equity|401|revenue|arr|funding|raised|valuation|customers|employees|budget|quota|bonus target|signing bonus|relocation)\b/i;

/** "185k" / "$185,000" / "185000" → 185000 */
export function toNumber(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  const k = s.match(/^(\d{1,4}(?:\.\d)?)\s*[kK]$/);
  if (k) return Math.round(parseFloat(k[1]) * 1000);
  const digits = s.replace(/[^0-9.]/g, '');
  if (!/\d/.test(digits)) return null;   // "about two hundred" is not zero
  const n = Number(digits);
  return Number.isFinite(n) ? Math.round(n) : null;
}

const plausible = (n) => n != null && n >= FLOOR && n <= CEILING;

// A fixed window either side of a figure reads markers that belong to the
// next one: in "$120k–150k, and with commission $200k–240k" a 90-character
// window around the first range swallows "with commission" and labels the
// base as OTE. Clauses are the unit a posting actually states pay in, so a
// figure is labelled by the clause it sits in and nothing else.
const CLAUSE_BREAK = /(?:[.;:!?]\s+)|(?:,\s+(?=and\b|with\b|plus\b|or\b|but\b))|\n+/g;

/** The clause containing `index`. */
export function clauseAt(text, index) {
  let start = 0;
  let end = text.length;
  for (const m of String(text).matchAll(CLAUSE_BREAK)) {
    const after = m.index + m[0].length;
    if (after <= index) start = after;
    else { end = m.index; break; }
  }
  return text.slice(start, end);
}

/**
 * base | ote | null, from the wording around a figure.
 *
 * OTE wins a tie: a sentence saying "base salary $140k, with OTE of $260k"
 * puts both markers near both figures, and the one that follows the figure
 * more closely decides it.
 */
export function classify(surrounding, matchText = '') {
  const ote = OTE_MARKERS.test(surrounding);
  const base = BASE_MARKERS.test(surrounding);
  if (ote && base) {
    // Whichever marker sits closer to the figure itself.
    const at = surrounding.indexOf(matchText);
    if (at === -1) return 'ote';
    const nearest = (re) => {
      const positions = [...surrounding.matchAll(new RegExp(re.source, 'gi'))]
        .map((m) => Math.abs(m.index - at));
      return positions.length ? Math.min(...positions) : Infinity;
    };
    return nearest(OTE_MARKERS) <= nearest(BASE_MARKERS) ? 'ote' : 'base';
  }
  if (ote) return 'ote';
  if (base) return 'base';
  return null;
}

// ---------------------------------------------------------------------------
// Structured
// ---------------------------------------------------------------------------

/**
 * Reads an ATS's own compensation object.
 *
 * Salary components are base. Commission and bonus are variable, so base plus
 * variable is the OTE — which is how a posting quoting both would describe it.
 * Equity is skipped: it isn't cash and its units aren't comparable.
 */
export function fromStructured(job) {
  const c = job?.compensation;
  if (!c || typeof c !== 'object') return null;

  const tiers = c.compensationTiers || c.summaryComponents || (Array.isArray(c) ? c : []);
  const salary = [];
  const variable = [];

  for (const tier of tiers) {
    for (const comp of tier?.components || [tier]) {
      if (!comp || typeof comp !== 'object') continue;
      const type = String(comp.compensationType || comp.type || comp.summary || '').toLowerCase();
      if (/equity|option|percent|share/.test(type)) continue;

      const hourly = /hour/i.test(String(comp.interval || ''));
      const values = ['minValue', 'maxValue', 'value']
        .map((k) => comp[k])
        .filter((v) => typeof v === 'number')
        .map((v) => Math.round(hourly ? v * ASSUMED_HOURS_PER_YEAR : v));

      const bucket = /commission|variable|bonus|incentive/.test(type) ? variable : salary;
      for (const v of values) {
        // A commission component can legitimately be small, so only the base
        // bucket gets the plausibility floor.
        if (bucket === salary ? plausible(v) : v > 0 && v <= CEILING) bucket.push(v);
      }
    }
  }

  if (!salary.length) return null;
  const base = { min: Math.min(...salary), max: Math.max(...salary) };

  if (variable.length) {
    const ote = { min: base.min + Math.min(...variable), max: base.max + Math.max(...variable) };
    if (plausible(ote.max)) {
      return { ...ote, kind: 'ote', source: 'structured', basis: 'base + commission, from the board' };
    }
  }
  return { ...base, kind: 'base', source: 'structured', basis: 'base, from the board' };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Every plausible pay range in the text, labelled base or ote where stated. */
export function rangesInText(text = '') {
  const found = [];
  if (!text) return found;

  for (const m of String(text).matchAll(RANGE_RE)) {
    const min = toNumber(m[1]);
    const max = toNumber(m[2]);
    if (!plausible(min) || !plausible(max) || max < min) continue;
    const around = clauseAt(text, m.index);
    if (NOT_PAY.test(around) && !BASE_MARKERS.test(around) && !OTE_MARKERS.test(around)) continue;
    found.push({ min, max, kind: classify(around, m[0]), width: max - min, at: m.index });
  }
  return found;
}

export function fromText(text = '') {
  if (!text) return null;
  const ranges = rangesInText(text);

  // The widest range of a kind is the band; a narrower figure nearby is
  // usually a midpoint or a single-number restatement of it.
  const widest = (kind) => {
    const hits = ranges.filter((r) => r.kind === kind);
    return hits.length ? hits.sort((a, b) => b.width - a.width)[0] : null;
  };

  // OTE when the posting says so, base when it says that, and otherwise the
  // lowest unqualified range — see the note at the top of the file.
  const unlabelled = ranges.filter((r) => r.kind === null).sort((a, b) => a.max - b.max);
  const pick = widest('ote') || widest('base') || unlabelled[0] || null;

  if (pick) {
    const kind = pick.kind || 'base';
    const stated = pick.kind !== null;
    return {
      min: pick.min,
      max: pick.max,
      kind,
      source: 'text-range',
      basis: `${kind === 'ote' ? 'OTE' : 'base'}, ${stated ? 'stated' : 'assumed from an unqualified range'}` +
        (ranges.length > 1 ? ` (${ranges.length} ranges in the text)` : ''),
    };
  }

  // A single figure, only when the sentence says what it is — a bare number in
  // a job description is far more often a headcount or an ARR figure.
  const singles = [];
  for (const m of String(text).matchAll(SINGLE_RE)) {
    const value = toNumber(m[1]);
    if (!plausible(value)) continue;
    const around = clauseAt(text, m.index);
    const kind = classify(around, m[0]);
    if (!kind || NOT_PAY.test(around)) continue;
    singles.push({ value, kind });
  }
  if (singles.length) {
    const p = singles.find((x) => x.kind === 'ote') || singles[0];
    return {
      min: p.value,
      max: p.value,
      kind: p.kind,
      source: 'text-single',
      basis: `a single ${p.kind === 'ote' ? 'OTE' : 'base'} figure in the description`,
    };
  }

  for (const m of String(text).matchAll(HOURLY_RE)) {
    const annual = Math.round(parseFloat(m[1]) * ASSUMED_HOURS_PER_YEAR);
    if (!plausible(annual)) continue;
    return {
      min: annual,
      max: annual,
      kind: 'base',
      source: 'text-hourly',
      basis: `$${m[1]}/hour × ${ASSUMED_HOURS_PER_YEAR} hours`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------

/**
 * @returns {{ min, max, kind, source, basis } | null}
 */
export function extractSalary(job = {}) {
  return fromStructured(job) || fromText(job.body) || null;
}

/**
 * Applies the sheet's salary floor to the top of the band.
 *
 * @returns {{ verdict: 'pass'|'below'|'unknown', salary, reason }}
 *   'unknown' is a distinct verdict rather than a failure, because whether an
 *   unpriced posting is worth seeing is the user's call, not this function's.
 */
export function evaluateSalary(job, settings = {}) {
  const salary = extractSalary(job);
  const floor = settings.salaryFloor;

  if (!salary) return { verdict: 'unknown', salary: null, reason: 'no salary stated' };
  if (!floor) return { verdict: 'pass', salary, reason: 'no floor set' };

  return salary.max >= floor
    ? { verdict: 'pass', salary, reason: `${money(salary.max)} clears ${money(floor)}` }
    : { verdict: 'below', salary, reason: `tops out at ${money(salary.max)}, under ${money(floor)}` };
}

// Shared: the leanings report prints the same shape, and two copies of it
// collide when the build flattens every file into one scope.
export const money = (n) => `$${Math.round(n / 1000)}k`;

/** "$280k–320k OTE" — what goes in the Salary column. */
export function formatSalary(salary) {
  if (!salary) return '';
  const band = salary.min === salary.max
    ? money(salary.min)
    : `${money(salary.min)}–${Math.round(salary.max / 1000)}k`;
  return salary.kind === 'ote' ? `${band} OTE` : band;
}
