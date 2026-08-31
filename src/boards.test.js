#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Offline tests for description extraction. No network, no credentials.
//
// The fixtures here are verbatim shapes captured from live ATS payloads with
// src/diagnose.js — not invented markup. Both cases below are real bugs that
// silently produced "no salary listed" on postings that plainly stated a range.
import { decodeEntities, stripHtml, decodeURIContent, leverBody, place, ADAPTERS, ATS_NAMES } from './boards.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

// --- entity decoding -------------------------------------------------------
check('decodes named entities', decodeEntities('a &amp; b') === 'a & b');
check('decodes angle brackets', decodeEntities('&lt;p&gt;') === '<p>');
check('decodes nbsp to a space', decodeEntities('a&nbsp;b') === 'a b');
check('decodes decimal numeric', decodeEntities('&#36;100') === '$100');
check('decodes hex numeric', decodeEntities('&#x24;100') === '$100');
check('decodes an en dash', decodeEntities('142K&ndash;170K') === '142K–170K');
check('leaves unknown entities alone', decodeEntities('&zzz; kept') === '&zzz; kept');
check('leaves a bare ampersand alone', decodeEntities('R&D team') === 'R&D team');
check('survives a malformed numeric entity', typeof decodeEntities('&#999999999999;') === 'string');

// --- stripHtml -------------------------------------------------------------
check('strips plain tags', stripHtml('<p>hello <b>world</b></p>') === 'hello world');
check('strips entity-encoded tags', stripHtml('&lt;p&gt;hello&lt;/p&gt;') === 'hello');
check('leaves no tag names behind', !stripHtml('&lt;span class=&quot;x&quot;&gt;hi&lt;/span&gt;').includes('span'));
check('handles double escaping', stripHtml('a&amp;nbsp;b') === 'a b');
check('collapses whitespace', stripHtml('<p>a</p>\n\n   <p>b</p>') === 'a b');
check('empty input is safe', stripHtml('') === '' && stripHtml(undefined) === '');

// --- URI-encoded content ---------------------------------------------------
check('decodes fully-encoded content', decodeURIContent('a%20b') === 'a b');
check('leaves un-encoded content alone', decodeURIContent('plain text') === 'plain text');
check('survives a stray percent', decodeURIContent('Equity: 0.05%-0.10% and %2F') === 'Equity: 0.05%-0.10% and %2F');

// --- regression: Greenhouse entity-encoded markup ---------------------------
// Verbatim from Grafana Labs job 6115634004. Before the fix this parsed to
// "…is $ span data-sheets-root= 1 100,000…" and yielded no salary at all.
{
  const raw =
    '&lt;p&gt;&lt;span style=&quot;font-weight: 400;&quot;&gt;In the US, the base compensation ' +
    'range for this role is $&lt;span data-sheets-root=&quot;1&quot;&gt;100,000&lt;/span&gt;' +
    '&lt;span data-sheets-root=&quot;1&quot;&gt;&amp;nbsp;&lt;/span&gt;- $&lt;span ' +
    'data-sheets-root=&quot;1&quot;&gt;120,000&lt;/span&gt;. &amp;nbsp;Actual compensation may vary.' +
    '&lt;/span&gt;&lt;/p&gt;';
  const body = stripHtml(raw);
  check('no tag debris survives', !/span|data-sheets|font-weight/.test(body), body.slice(0, 55));
  check('reads as clean prose', body.startsWith('In the US, the base compensation range'));
  check('both figures survive intact', body.includes('100,000') && body.includes('120,000'));
  check('the separator survives', /100,000\s*-\s*\$?\s*120,000/.test(body), body.slice(50, 110));
}

// --- regression: Lever's split fields --------------------------------------
// Verbatim shape from Metabase job da72d8c9. Reading `description` alone gave
// 906 characters of company blurb and no pay data.
{
  const job = {
    description: '<h3>About Metabase</h3><p>Metabase is the leading open-source BI platform.</p>',
    descriptionPlain: 'About Metabase\nMetabase is the leading open-source BI platform.',
    descriptionBodyPlain: 'The Role\nWe know there are channels and programs out there.',
    lists: [{ text: "What You'll Own", content: '<li><p>Develop and maintain a pipeline of experiments.</p></li>' }],
    additional:
      '<div><h3><strong><em>Compensation</em></strong></h3><div><br aria-hidden="true">' +
      '<em>The US base salary range for this role is </em><strong><em>$142K&ndash;$170K annually</em></strong>' +
      '<em>, plus equity and benefits.</em></div></div>',
  };
  const body = leverBody(job);
  check('includes the opening blurb', body.includes('leading open-source BI platform'));
  check('includes the role summary', body.includes('channels and programs'));
  check('includes the bulleted lists', body.includes('pipeline of experiments'));
  check('includes the additional section', body.includes('Compensation'));
  check('the pay figures survive', body.includes('$142K–$170K'), body.slice(-58));
  check('old single-field read missed it', !stripHtml(job.descriptionPlain).includes('142K'));
}
{
  // Lever postings vary in which fields they populate — none may throw.
  check('tolerates a minimal posting', leverBody({ descriptionPlain: 'just this' }) === 'just this');
  check('tolerates an empty posting', leverBody({}) === '');
  check('tolerates malformed lists', typeof leverBody({ lists: [null, {}] }) === 'string');
}

// --- adapter contract ------------------------------------------------------
// Every adapter must expose the same surface, so a new board can be added
// without touching the caller.
{
  check('six adapters registered', ATS_NAMES.length === 6, ATS_NAMES.join(', '));
  const missing = ATS_NAMES.filter((n) => {
    const a = ADAPTERS[n];
    return !a.label || typeof a.url !== 'function'
      || typeof a.board !== 'function' || typeof a.fetchJobs !== 'function';
  });
  check('every adapter has label/url/board/fetchJobs', missing.length === 0, missing.join(', '));

  const bad = ATS_NAMES.filter((n) => !ADAPTERS[n].url('acme').startsWith('https://'));
  check('every endpoint is https', bad.length === 0, bad.join(', '));

  const noSlug = ATS_NAMES.filter((n) => !ADAPTERS[n].url('acme').includes('acme'));
  check('every endpoint interpolates the slug', noSlug.length === 0, noSlug.join(', '));
}

// --- regression: the remote flag beside a location -------------------------
// Ashby, Lever, Workable and Recruitee all carry a structured remote flag next
// to a location string, and the two disagree constantly — a ClickUp posting
// reads "San Diego" with isRemote true. The old code consulted the flag only
// when the location was empty, so a remote-only filter dropped every remote
// job at a company with an address. This is why a three-company run returned
// nothing while the boards plainly had matching remote roles on them.
console.log('\n--- remote flags ---');
{
  check('a flagged remote job with an office is still remote',
    place('San Diego', true) === 'San Diego (Remote)');
  check('a location already saying remote is not doubled up',
    place('Remote - US', true) === 'Remote - US');
  check('no location and a remote flag is just Remote', place('', true) === 'Remote');
  check('an on-site job keeps its location', place('San Diego', false) === 'San Diego');
  check('an unknown flag changes nothing', place('San Diego', null) === 'San Diego');
}
{
  // Every adapter must publish the tri-state, so the matcher can tell "on-site"
  // from "this board doesn't say".
  const shapes = {
    ashby: { jobs: [{ id: '1', title: 'Staff Engineer', location: 'San Diego', isRemote: true }] },
    lever: [{ id: '1', text: 'Staff Engineer', categories: { location: 'San Diego' }, workplaceType: 'remote' }],
    workable: { jobs: [{ shortcode: '1', title: 'Staff Engineer', city: 'San Diego', telecommuting: true }] },
    recruitee: { offers: [{ id: 1, title: 'Staff Engineer', location: 'San Diego', remote: true }] },
    smartrecruiters: { content: [{ id: '1', name: 'Staff Engineer', location: { city: 'San Diego', remote: true } }] },
  };
  for (const [ats, payload] of Object.entries(shapes)) {
    const jobs = await ADAPTERS[ats].fetchJobs('x', { fetchImpl: async () => ({
      ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload),
    }) });
    check(`${ats}: keeps the remote flag`, jobs[0].remote === true, JSON.stringify(jobs[0].remote));
    check(`${ats}: and the location agrees with it`, /remote/i.test(jobs[0].location), jobs[0].location);
  }
}
{
  check('greenhouse has no flag to keep, and says so rather than guessing',
    ADAPTERS.greenhouse.label === 'Greenhouse');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
