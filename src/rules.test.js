#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Offline tests for rule compilation and matching. No network.
//
// The first block is the one that matters most: an engine with no configuration
// must match nothing. If any of those assertions fail, domain knowledge has
// crept back into the code and the tool is no longer general.
import { compilePattern, compileRules, emptyRules, locationAllows, statesAPlace } from './rules.js';
import { matchJob, signalSummary } from './match.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const job = (title, over = {}) => ({
  id: 'x', title, location: 'Remote', url: '', postedAt: null, body: '', ...over,
});

// === THE GENERALISATION TEST =============================================
// Blank config, realistic postings from several job families, zero matches.
console.log('--- blank config matches nothing ---');
{
  const rules = emptyRules();
  const postings = [
    job('Staff Software Engineer'),
    job('Senior Marketing Operations Manager'),
    job('Director of Revenue Operations'),
    job('Product Designer'),
    job('Data Scientist, Growth'),
    job('Registered Nurse'),
    job('Account Executive', { body: 'We use Salesforce, Marketo and Snowflake.' }),
  ];
  const matched = postings.filter((p) => matchJob(p, rules).matched);
  check('no posting matches an empty rule set', matched.length === 0,
    matched.map((m) => m.title).join(', ') || '0 of ' + postings.length);
  check('the verdict says why', matchJob(postings[0], rules).stage === 'no-signal');

  const compiled = compileRules({});
  check('compileRules({}) is empty', compiled.title.length === 0 && compiled.body.length === 0);
  check('and reports no problems', compiled.problems.length === 0);
}

// --- phrase compilation ----------------------------------------------------
console.log('\n--- phrases ---');
{
  const p = compilePattern('staff engineer');
  check('matches the phrase', p.re.test('Staff Engineer, Platform'));
  check('is case-insensitive', p.re.test('STAFF ENGINEER'));
  check('tolerates extra whitespace', p.re.test('Staff   Engineer'));
  check('respects word boundaries', !p.re.test('Staffing Engineers United'));
  check('requires adjacency', !p.re.test('Engineer on staff'));
  check('keeps the label human-readable', p.label === 'staff engineer');
  check('reports its kind', p.kind === 'phrase');
}
{
  check('blank compiles to null', compilePattern('   ') === null);
  check('null compiles to null', compilePattern(null) === null);
  const dot = compilePattern('customer.io');
  check('a dot is literal', dot.re.test('customer.io') && !dot.re.test('customerXio'));
  const plus = compilePattern('c++');
  check('metacharacters do not throw', plus.re instanceof RegExp);
  check('and still match literally', plus.re.test('Senior c++ Engineer'));
}

// --- regex escape hatch ----------------------------------------------------
console.log('\n--- regex form ---');
{
  const p = compilePattern('/\\b(gtm|g2m|go[\\s-]?to[\\s-]?market)\\s+(ops|operations)\\b/');
  check('compiles a regex entry', p.kind === 'regex');
  check('matches one spelling', p.re.test('GTM Operations Lead'));
  check('matches another', p.re.test('Go-To-Market Ops Manager'));
  check('matches a third', p.re.test('G2M operations'));
  check('is forced case-insensitive', p.re.test('gtm ops'));
  check('does not over-match', !p.re.test('Marketing Manager'));
}
{
  const bad = compilePattern('/[unclosed/');
  check('an invalid regex is reported, not thrown', Boolean(bad.error), bad.error);
  const { patterns, problems } = compileRules({ title: ['/[bad/', 'good phrase'] });
  check('a bad entry does not discard the good ones', compileRules({ title: ['/[bad/', 'ok'] }).title.length === 1);
  check('and the problem is surfaced', compileRules({ title: ['/[bad/'] }).problems.length === 1);
}

// --- exclusions ------------------------------------------------------------
console.log('\n--- exclusions ---');
{
  const rules = compileRules({ title: ['engineer'], exclude: ['account executive', 'intern'] });
  check('an excluded title is dropped', !matchJob(job('Engineering Intern'), rules).matched);
  check('the stage is reported', matchJob(job('Engineering Intern'), rules).stage === 'excluded');
  check('the reason names the rule', matchJob(job('Engineering Intern'), rules).reason.includes('intern'));
  check('a phrase exclusion needs both words', matchJob(job('Engineer, Account Management'), rules).matched);
  check('and drops the real phrase', !matchJob(job('Account Executive Engineer'), rules).matched);
}

// --- body signals and the title gate ---------------------------------------
console.log('\n--- body signals ---');
{
  const rules = compileRules({ title: ['platform engineer'], body: ['kubernetes'] });
  const v = matchJob(job('Systems Analyst', { body: 'You will run our Kubernetes clusters.' }), rules);
  check('a body signal alone can match', v.matched && v.tier === 'body');
  check('the signal is recorded', signalSummary(v) === 'kubernetes');
}
{
  const rules = compileRules({
    title: ['platform engineer'],
    body: ['kubernetes'],
    bodyRequiresTitleHint: ['engineer', 'infrastructure'],
  });
  const unrelated = matchJob(job('Office Manager', { body: 'Our team uses Kubernetes.' }), rules);
  check('the hint gate blocks an unrelated title', !unrelated.matched);
  const adjacent = matchJob(job('Systems Engineer', { body: 'Our team uses Kubernetes.' }), rules);
  check('and allows an adjacent one', adjacent.matched && adjacent.tier === 'body');
}
{
  const rules = compileRules({ title: ['engineer'], body: ['kubernetes'] });
  const v = matchJob(job('Staff Engineer', { body: 'We run Kubernetes.' }), rules);
  check('a title hit outranks a body hit', v.tier === 'title');
  check('both signals are still recorded', v.signals.length === 2, signalSummary(v));
}

// --- location --------------------------------------------------------------
console.log('\n--- location ---');
{
  const rules = compileRules({ title: ['engineer'], location: { mode: 'remote-only' } });
  check('a remote posting passes', matchJob(job('Engineer', { location: 'Remote - US' }), rules).matched);
  check('an on-site posting is rejected', !matchJob(job('Engineer', { location: 'Dublin, IE' }), rules).matched);
  check('the stage is location', matchJob(job('Engineer', { location: 'Dublin, IE' }), rules).stage === 'location');

  // The bug this guards: "distributed" means remote in a location field but is
  // an ordinary word in a title.
  const distributed = job('Engineer, Distributed Systems', { location: 'Dublin, IE' });
  check('"Distributed Systems" in a title is not remote', !matchJob(distributed, rules).matched);
  check('but "Distributed team" in a location is',
    matchJob(job('Engineer', { location: 'Distributed team' }), rules).matched);
  check('a title saying Remote counts when location is blank',
    matchJob(job('Remote Engineer', { location: '' }), rules).matched);
}
{
  const rules = compileRules({
    title: ['engineer'],
    location: { mode: 'remote-only', allowlist: ['united states', 'americas'] },
  });
  check('an allowlisted region passes', matchJob(job('Engineer', { location: 'Remote - United States' }), rules).matched);
  check('another region is rejected', !matchJob(job('Engineer', { location: 'Remote - EMEA' }), rules).matched);
  check('the reason names the location',
    matchJob(job('Engineer', { location: 'Remote - EMEA' }), rules).reason.includes('EMEA'));
}
{
  const rules = compileRules({ title: ['engineer'], location: { mode: 'nonsense' } });
  check('an unknown location mode falls back to any', rules.location.mode === 'any');
  check('and is reported', rules.problems.some((p) => p.includes('nonsense')));
  check('so nothing is filtered', matchJob(job('Engineer', { location: 'Dublin, IE' }), rules).matched);
}

// --- rejection order -------------------------------------------------------
console.log('\n--- diagnosis quality ---');
{
  // A posting that fails several ways should report the most useful reason.
  const rules = compileRules({
    title: ['engineer'], exclude: ['intern'], location: { mode: 'remote-only' },
  });
  const v = matchJob(job('Engineering Intern', { location: 'Dublin, IE' }), rules);
  check('exclusion is reported ahead of location', v.stage === 'excluded');

  const v2 = matchJob(job('Chef'), rules);
  check('an irrelevant posting reports no-signal', v2.stage === 'no-signal');
  check('and records no signals', v2.signals.length === 0);
}
{
  const rules = compileRules({ title: ['engineer'], body: ['kubernetes'] });
  const v = matchJob({ title: 'Analyst', body: '', location: 'Remote' }, rules);
  check('a board with no descriptions says so', v.reason.includes('no descriptions'), v.reason);
}

// --- the shape a sheet row arrives in --------------------------------------
console.log('\n--- sheet rows ---');
{
  // Rows carry a note and a row number alongside the pattern. They compile
  // identically to a bare string, and the extras travel with the rule so a
  // debugger can point at the row that fired.
  const fromString = compilePattern('staff engineer');
  const fromRow = compilePattern({ pattern: 'staff engineer', note: 'why I added it', row: 5 });
  check('a row compiles like the string it contains',
    fromRow.source === fromString.source && fromRow.label === fromString.label);
  check('the note travels with it', fromRow.note === 'why I added it');
  check('so does the row number', fromRow.row === 5);
  check('a row with a blank pattern is skipped', compilePattern({ pattern: '  ', row: 3 }) === null);
  check('a broken regex in a row is still reported, with its row',
    compilePattern({ pattern: '/unclosed(/', row: 9 })?.error?.includes('invalid regex') === true);
  check('and keeps the row number for the report',
    compilePattern({ pattern: '/unclosed(/', row: 9 }).row === 9);
}

// --- the location allowlist ------------------------------------------------
console.log('\n--- location allowlist ---');
{
  const rules = compileRules({
    title: ['engineer'],
    location: { mode: 'remote-only', allowlist: ['united states', 'usa', 'north america'] },
  });
  const at = (location) => locationAllows({ location, title: 'Engineer', remote: true }, rules);

  check('a listed country is kept', at('United States (Remote)').allowed);
  check('an unlisted one is dropped', !at('Poland (Remote)').allowed);
  check('and the reason names both sides',
    /Poland.*outside the allowlist.*united states/.test(at('Poland (Remote)').reason),
    at('Poland (Remote)').reason);

  // The regression: a plain substring test let these through, because "us" is
  // inside both of them.
  check('Australia is not the US', !at('Australia (Remote)').allowed);
  check('nor is Austria', !at('Austria (Remote)').allowed);

  // A posting naming no geography has nothing for an allowlist to reject, and
  // an unrestricted remote role is the one most worth seeing.
  check('a bare Remote passes', at('Remote').allowed);
  check('so does Remote — Anywhere', at('Remote - Anywhere').allowed);
  check('and an empty location', at('').allowed);

  // A US city is still outside a "united states" allowlist. That is inherent
  // to matching free text, and the fix is the user's list, not a gazetteer.
  check('a US city is not matched by the country name', !at('San Diego (Remote)').allowed);
}
{
  const rules = compileRules({
    location: { mode: 'any', allowlist: ['/united states|usa|u\\.s\\./'] },
  });
  const at = (location) => locationAllows({ location, title: '' }, rules);
  check('a regex allowlist entry works', at('United States (Remote)').allowed);
  check('with alternation', at('USA (Remote)').allowed);
  check('and still rejects', !at('Poland (Remote)').allowed);
}
{
  const rules = compileRules({ location: { mode: 'any', allowlist: ['/unclosed(/'] } });
  check('a broken allowlist regex is reported, not thrown',
    rules.problems.some((p) => /location allowlist.*invalid regex/.test(p)),
    rules.problems.join(' | '));
}
{
  check('a location that is only remote words names no place',
    !statesAPlace('Remote') && !statesAPlace('Remote — Anywhere') && !statesAPlace(''));
  check('a country survives the strip', statesAPlace('United States (Remote)'));
  check('so does a city', statesAPlace('San Diego (Remote)'));
  check('hybrid alone is not a place', !statesAPlace('Hybrid'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
