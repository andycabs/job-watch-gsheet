// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// ATS adapters. Every adapter returns the same posting shape:
//
//   { id, title, location, url, postedAt, compensation, body }
//
// `body` is plain text with markup removed; `compensation` is the board's own
// structured pay data when it offers any, else null. `body` may be '' when a
// board doesn't return descriptions without a second request per posting.
//
// This module has no configuration dependency — it is a pure fetch/normalise
// library. Anything tunable arrives as an argument.
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 20000;

const UA = 'job-watch (job board monitor; +https://github.com/andycabs/job-watch)';

// `fetchImpl` is injectable so an adapter can be run against a captured
// payload. Without it the mapping from a board's JSON to our shape was the
// only layer in the codebase with no offline test — which is exactly where the
// remote-flag bug lived, in v1 and here.
async function getJSON(url, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  // Inside Apps Script there is no AbortController and no setTimeout, and
  // UrlFetchApp has its own fixed deadline that cannot be shortened anyway. So
  // the timeout is applied where one can be, and skipped where the runtime
  // already imposes one — rather than forking this file, which holds every
  // hard-won detail of how six boards actually shape their payloads.
  const canAbort = typeof AbortController === 'function';
  const ctrl = canAbort ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, {
      signal: ctrl ? ctrl.signal : undefined,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Text extraction
//
// Both of the routines below exist because of bugs found by dumping real ATS
// payloads — not from reading API docs. Job boards serve markup in shapes their
// documentation doesn't mention, and a plausible-looking parser can silently
// drop salary data for months. See src/diagnose.js before trusting any of this
// against a new board.
// ---------------------------------------------------------------------------

// Entities that actually turn up in job descriptions. Anything unrecognised is
// left as-is rather than blanked, so unknown markup can't silently eat text.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', times: '×', deg: '°',
};

export function decodeEntities(s) {
  return String(s).replace(/&(#[Xx]?[0-9A-Fa-f]+|[A-Za-z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try { return String.fromCodePoint(code); } catch { return match; }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

// Greenhouse serves descriptions with the markup itself entity-encoded — a
// paragraph arrives as "&lt;p&gt;", not "<p>" — and some fields are escaped
// twice ("&amp;nbsp;"). Decoding and stripping in alternating passes handles
// both. Doing either alone leaves tag names stranded as words and shreds a
// figure like "$<span>100,000</span>" into "$ span data-sheets-root= 1 100,000",
// which no salary parser can read.
export function stripHtml(s = '') {
  let text = String(s);
  for (let pass = 0; pass < 3; pass++) {
    const before = text;
    text = decodeEntities(text).replace(/<[^>]+>/g, ' ');
    if (text === before) break;
  }
  return text.replace(/\s+/g, ' ').trim();
}

// Some Greenhouse boards URI-encode their content and some don't. A %XX-looking
// substring anywhere (an encoded URL inside an href, say) isn't proof the whole
// string is encoded — plain HTML often carries an unrelated bare '%' elsewhere,
// which makes decodeURIComponent throw and take the entire description with it.
// Only decode when the string as a whole is valid; otherwise keep it raw.
export function decodeURIContent(s) {
  if (!/%[0-9A-Fa-f]{2}/.test(s)) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Lever splits a posting across several fields rather than returning one blob:
// `description` is the opening blurb, `descriptionBody` the role summary,
// `lists` the bulleted sections, and `additional` the closing section — which
// is where the compensation range and EEO boilerplate live. Reading only
// `description` captures a few hundred characters of company marketing and no
// pay data at all, making every Lever posting look unpriced.
export function leverBody(j = {}) {
  const lists = Array.isArray(j.lists)
    ? j.lists.map((l) => `${l?.text || ''}\n${l?.content || ''}`)
    : [];
  return stripHtml(
    [
      j.descriptionPlain || j.description,
      j.descriptionBodyPlain || j.descriptionBody,
      ...lists,
      j.additionalPlain || j.additional,
    ].filter(Boolean).join('\n')
  );
}

// ---------------------------------------------------------------------------
// Where a job is done
//
// Most boards carry a structured remote flag beside a location string, and the
// two disagree constantly: an Ashby posting can say "San Diego" and isRemote
// true, meaning a remote role owned by that office. Reading the flag only when
// the location string is empty — which is what this code used to do, and v1
// still does — throws away the authoritative answer exactly when it matters,
// and a remote-only filter then drops every remote job at a company with an
// address.
//
// So the flag is kept, as a tri-state: true, false, or null where the board
// doesn't say. And the location text is made to agree with it, so the sheet
// doesn't show "San Diego" for a job you can do from anywhere.
// ---------------------------------------------------------------------------

/** A board's own boolean, or null where it doesn't have one. */
const flag = (v) => (typeof v === 'boolean' ? v : null);

/** Location text that agrees with the remote flag. */
export function place(text, remote) {
  const location = String(text || '').trim();
  if (remote !== true) return location;
  if (/\bremote\b/i.test(location)) return location;
  return location ? `${location} (Remote)` : 'Remote';
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/** Lever states this as a word rather than a boolean. */
function leverRemote(j) {
  const type = String(j.workplaceType || '').toLowerCase();
  if (!type) return null;
  return type === 'remote';
}

export const ADAPTERS = {
  greenhouse: {
    label: 'Greenhouse',
    board: (slug) => `https://boards.greenhouse.io/${slug}`,
    url: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
    async fetchJobs(slug, opts) {
      const data = await getJSON(this.url(slug), opts);
      if (!Array.isArray(data.jobs)) throw new Error('unexpected shape');
      return data.jobs.map((j) => ({
        id: String(j.id),
        title: j.title || '',
        location: j.location?.name || '',
        // Greenhouse has no remote field; the location text is all there is.
        remote: null,
        url: j.absolute_url || '',
        postedAt: j.updated_at || j.first_published || null,
        compensation: j.pay_input_ranges?.length
          ? {
              compensationTiers: [{
                components: j.pay_input_ranges.map((r) => ({
                  compensationType: r.currency_type || 'salary',
                  minValue: r.min_cents != null ? r.min_cents / 100 : undefined,
                  maxValue: r.max_cents != null ? r.max_cents / 100 : undefined,
                })),
              }],
            }
          : null,
        body: stripHtml(decodeURIContent(j.content || '')),
      }));
    },
  },

  lever: {
    label: 'Lever',
    board: (slug) => `https://jobs.lever.co/${slug}`,
    url: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json`,
    async fetchJobs(slug, opts) {
      const data = await getJSON(this.url(slug), opts);
      if (!Array.isArray(data)) throw new Error('unexpected shape');
      return data.map((j) => ({
        id: String(j.id),
        title: j.text || '',
        location: place(j.categories?.location || '', leverRemote(j)),
        remote: leverRemote(j),
        url: j.hostedUrl || j.applyUrl || '',
        postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
        compensation: null,
        body: leverBody(j),
      }));
    },
  },

  ashby: {
    label: 'Ashby',
    board: (slug) => `https://jobs.ashbyhq.com/${slug}`,
    url: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`,
    async fetchJobs(slug, opts) {
      const data = await getJSON(this.url(slug), opts);
      if (!Array.isArray(data.jobs)) throw new Error('unexpected shape');
      return data.jobs.map((j) => ({
        id: String(j.id),
        title: j.title || '',
        location: place(j.location, flag(j.isRemote)),
        remote: flag(j.isRemote),
        url: j.jobUrl || j.applyUrl || '',
        postedAt: j.publishedAt || null,
        compensation: j.compensation || null,
        body: stripHtml(j.descriptionHtml || j.descriptionPlain || ''),
      }));
    },
  },

  workable: {
    label: 'Workable',
    board: (slug) => `https://apply.workable.com/${slug}`,
    url: (slug) => `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`,
    async fetchJobs(slug, opts) {
      const data = await getJSON(this.url(slug), opts);
      if (!Array.isArray(data.jobs)) throw new Error('unexpected shape');
      return data.jobs.map((j) => ({
        id: String(j.shortcode || j.id),
        title: j.title || '',
        location: place([j.city, j.state, j.country].filter(Boolean).join(', '), flag(j.telecommuting)),
        remote: flag(j.telecommuting),
        url: j.url || j.application_url || '',
        postedAt: j.published_on || null,
        compensation: null,
        body: stripHtml(j.description || ''),
      }));
    },
  },

  smartrecruiters: {
    label: 'SmartRecruiters',
    board: (slug) => `https://jobs.smartrecruiters.com/${slug}`,
    url: (slug) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`,
    async fetchJobs(slug, opts) {
      const data = await getJSON(this.url(slug), opts);
      if (!Array.isArray(data.content)) throw new Error('unexpected shape');
      return data.content.map((j) => ({
        id: String(j.id),
        title: j.name || '',
        location: place([j.location?.city, j.location?.region, j.location?.country]
          .filter(Boolean).join(', '), flag(j.location?.remote)),
        remote: flag(j.location?.remote),
        url: j.ref || `https://jobs.smartrecruiters.com/${slug}/${j.id}`,
        postedAt: j.releasedDate || null,
        compensation: null,
        // The list endpoint omits descriptions; fetching them costs one request
        // per posting, so body-based rules can't apply to this board.
        body: '',
      }));
    },
  },

  recruitee: {
    label: 'Recruitee',
    board: (slug) => `https://${slug}.recruitee.com`,
    url: (slug) => `https://${slug}.recruitee.com/api/offers/`,
    async fetchJobs(slug, opts) {
      const data = await getJSON(this.url(slug), opts);
      if (!Array.isArray(data.offers)) throw new Error('unexpected shape');
      return data.offers.map((j) => ({
        id: String(j.id),
        title: j.title || '',
        location: place(j.location, flag(j.remote)),
        remote: flag(j.remote),
        url: j.careers_url || j.url || '',
        postedAt: j.published_at || null,
        compensation: null,
        body: stripHtml(j.description || ''),
      }));
    },
  },
};

export const ATS_NAMES = Object.keys(ADAPTERS);

export async function fetchCompanyJobs(company, opts = {}) {
  const adapter = ADAPTERS[company.ats];
  if (!adapter) {
    throw new Error(`no adapter for ats "${company.ats}" — expected one of: ${ATS_NAMES.join(', ')}`);
  }
  return adapter.fetchJobs(company.slug, opts);
}
