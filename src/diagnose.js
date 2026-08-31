#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// Board diagnostic — look at what an ATS actually returns.
//
// This exists because parsers fail silently. A description can arrive
// entity-encoded, truncated, split across fields, or behind a key the adapter
// doesn't read, and the result is always the same from the outside: a posting
// that quietly has no salary. Reading a real payload takes a minute and settles
// in fact what would otherwise be a guess.
//
// Run this against a board BEFORE trusting new extraction code.
//
//   node src/diagnose.js greenhouse grafanalabs 6115634004
//   node src/diagnose.js lever metabase          # first few postings
//   RAW=1 node src/diagnose.js lever metabase    # untouched API object
//
// Note: ATS hosts are unreachable from many sandboxed environments. If every
// request fails, run this on CI rather than assuming the board is down.
// ---------------------------------------------------------------------------
import { ADAPTERS, ATS_NAMES } from './boards.js';
import { extractSalary, formatSalary, rangesInText, clauseAt } from './salary.js';

const RAW = process.env.RAW === '1';
const [ats, slug, rawJobId] = process.argv.slice(2);
const jobId = rawJobId && rawJobId.trim() ? rawJobId.trim() : null;

if (!ats || !slug || !ADAPTERS[ats]) {
  console.error('usage: node src/diagnose.js <ats> <slug> [jobId]');
  console.error(`       ats: ${ATS_NAMES.join(' | ')}`);
  process.exit(1);
}

const MONEY = /(?:\$|USD|&#3[46];|&#x24;)\s?[\d,]{3,}/i;

/** Dumps the untouched API object, to find which field holds what. */
async function dumpRaw() {
  const res = await fetch(ADAPTERS[ats].url(slug), {
    headers: { 'User-Agent': 'job-watch diagnostic', Accept: 'application/json' },
  });
  const data = await res.json();
  const list = data.jobs || data.content || data.offers || data;
  if (!Array.isArray(list) || !list.length) {
    console.log(`${ats}/${slug} returned no postings. Top-level keys: ${Object.keys(data).join(', ')}`);
    return console.log(`Open ${ADAPTERS[ats].board(slug)} to check whether the slug exists.`);
  }
  const job = jobId ? list.find((j) => String(j.id ?? j.shortcode) === String(jobId)) : list[0];
  if (!job) return console.log(`job ${jobId} not found among ${list.length} postings`);

  console.log(`top-level keys: ${Object.keys(job).join(', ')}\n`);
  for (const [k, v] of Object.entries(job)) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s && s.length > 400) {
      // Long HTML blobs: show only the money-bearing regions, which is what
      // we're almost always here to find.
      const hits = (s.match(/.{0,90}(?:\$|&#3[46];|USD|compensation range|salary range).{0,110}/gi) || []).slice(0, 4);
      console.log(`${k}: ${s.length} chars, ${hits.length} money-ish region(s)`);
      hits.forEach((h) => console.log(`   … ${h.replace(/\s+/g, ' ')}`));
    } else {
      console.log(`${k}: ${String(s).slice(0, 260)}`);
    }
  }
}

/** Shows what the adapter produces, and whether pay data survived it. */
async function dumpParsed() {
  const jobs = await ADAPTERS[ats].fetchJobs(slug);
  console.log(`${ats}/${slug}: ${jobs.length} postings`);
  console.log(`board:       ${ADAPTERS[ats].board(slug)}`);
  console.log(`api:         ${ADAPTERS[ats].url(slug)}\n`);

  // An empty board is the most common outcome of a wrong slug, and it looks
  // identical to a company that has simply stopped hiring. Saying which is
  // impossible from here, so say that, rather than printing "0 postings" and
  // letting it read as a parser failure.
  if (!jobs.length) {
    console.log('The board responded, but with no postings. That means one of:');
    console.log('  · the slug is wrong — open the board URL above and see if it exists');
    console.log('  · the company has moved to a different ATS');
    console.log('  · the company genuinely has nothing posted right now');
    console.log('\nAdd the company name to the companies tab and run discovery — it probes');
    console.log('every supported board and will find the right one if there is one.');
    return;
  }

  const targets = jobId ? jobs.filter((j) => String(j.id) === String(jobId)) : jobs.slice(0, 3);
  if (!targets.length) {
    console.log(`job ${jobId} not found among ${jobs.length} postings. ` +
      `First ids: ${jobs.slice(0, 5).map((j) => j.id).join(', ')}`);
    return;
  }

  for (const job of targets) {
    const body = job.body || '';
    console.log('='.repeat(72));
    console.log(`${job.id} — ${job.title}`);
    console.log(`location:    ${job.location}`);
    console.log(`posted:      ${job.postedAt || 'unknown'}`);
    console.log(`body chars:  ${body.length}${body.length < 1200 ? '   ← suspiciously short; fields may be missing' : ''}`);
    console.log(`structured:  ${job.compensation ? JSON.stringify(job.compensation).slice(0, 180) : 'none'}`);

    const money = body.match(new RegExp(`.{0,60}${MONEY.source}.{0,60}`, 'gi')) || [];
    console.log(`money-ish:   ${money.length} snippet(s)`);
    money.slice(0, 4).forEach((m) => console.log(`   … ${m.replace(/\s+/g, ' ').trim()}`));

    // What the parser makes of it, beside what's actually in the text. A
    // money-ish snippet the parser missed, or a base range it read as OTE, is
    // visible here and nowhere else — reading these against a real posting is
    // the only way the base/OTE split gets verified rather than assumed.
    const salary = extractSalary(job);
    console.log(`salary read: ${salary ? formatSalary(salary) : 'nothing'}`);
    if (salary) console.log(`  basis:     ${salary.basis}  (${salary.source})`);
    const ranges = rangesInText(body);
    if (ranges.length) {
      console.log(`  ranges:    ${ranges.length} found in the text`);
      for (const r of ranges.slice(0, 5)) {
        console.log(`    ${String(r.min).padStart(7)}–${String(r.max).padEnd(7)} ${r.kind || 'unlabelled'}` +
          `   « ${clauseAt(body, r.at).replace(/\s+/g, ' ').trim().slice(0, 90)} »`);
      }
    }
    if (money.length && !salary) console.log('  ← money in the text but nothing parsed: the parser is missing a form');

    const entities = [...new Set(body.match(/&#?[a-z0-9]{1,7};/gi) || [])];
    if (entities.length) console.log(`leftover entities: ${entities.slice(0, 10).join(' ')}   ← extraction is incomplete`);

    const tagDebris = body.match(/\b(?:div|span|href|aria-hidden|data-[a-z-]+)\b/gi) || [];
    if (tagDebris.length) console.log(`tag debris: ${[...new Set(tagDebris)].slice(0, 8).join(' ')}   ← markup leaked into text`);

    console.log(`head:        ${body.slice(0, 200).replace(/\s+/g, ' ')}`);
  }
}

await (RAW ? dumpRaw() : dumpParsed());
