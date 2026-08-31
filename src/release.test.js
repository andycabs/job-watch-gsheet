#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Tests for versioning and releases.
//
// The problem these exist for: a copy made from the template has its own git
// history, so the version in package.json is the only answer to "how far
// behind am I?". That answer is worth nothing if a tag can be published
// without the version and the changelog agreeing with it.
import { readFileSync } from 'node:fs';
import { VERSION } from './version.js';
import { changelogPath, versions, latestVersion, notesFor } from './changelog.js';
import { checkRelease } from './release.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
};

const CHANGELOG = readFileSync(changelogPath(), 'utf8');

// --- the real files --------------------------------------------------------
// These run on every push, so a version bump that forgets the changelog fails
// long before anyone pushes a tag.
console.log('--- this repository ---');
check('package.json carries a real version', /^\d+\.\d+\.\d+$/.test(VERSION), VERSION);
check('the changelog documents the current version', latestVersion(CHANGELOG) === VERSION,
  `package.json ${VERSION}, changelog ${latestVersion(CHANGELOG)}`);
{
  const notes = notesFor(CHANGELOG, VERSION);
  check('the current version has notes to release', Boolean(notes) && notes.length > 40);
}
{
  const all = versions(CHANGELOG);
  check('changelog versions are unique', new Set(all).size === all.length, all.join(', '));
}

// --- reading the changelog -------------------------------------------------
console.log('\n--- reading the changelog ---');
const SAMPLE = [
  '# Changelog', '', 'Preamble, which is not a version.', '',
  '## 2.0.0 - 2026-09-01', '', 'Second thing.', '',
  '## 1.0.0 - 2026-08-29', '', 'First thing.', '',
].join('\n');

check('headings are read in file order', String(versions(SAMPLE)) === '2.0.0,1.0.0');
check('notes stop at the next version', notesFor(SAMPLE, '2.0.0') === 'Second thing.');
check('the last section runs to the end of the file', notesFor(SAMPLE, '1.0.0') === 'First thing.');
check('a version that is not there has no notes', notesFor(SAMPLE, '3.0.0') === null);
check('a heading with no body is not notes', notesFor('## 1.0.0\n\n## 0.9.0\n\nold\n', '1.0.0') === null);
check('the preamble is not mistaken for a version', versions('# Changelog\n\nWords.\n').length === 0);

// --- the guard -------------------------------------------------------------
console.log('\n--- refusing a release that does not line up ---');
const good = { tag: 'v1.2.3', version: '1.2.3', latest: '1.2.3', notes: 'Things.' };

check('an aligned release passes', checkRelease(good).ok === true);
{
  const r = checkRelease({ ...good, version: '1.2.2' });
  check('a tag ahead of package.json is refused',
    !r.ok && /does not match package\.json \(1\.2\.2\)/.test(r.problems[0]), r.problems[0]);
}
{
  const r = checkRelease({ ...good, latest: '1.2.2' });
  check('a tag the changelog has not caught up with is refused',
    !r.ok && /newest entry in CHANGELOG\.md \(1\.2\.2\)/.test(r.problems.join(' ')));
}
check('a version with no notes is refused',
  /nothing under/.test(checkRelease({ ...good, notes: null }).problems.join(' ')));
{
  const r = checkRelease({ ...good, tag: 'nightly' });
  check('a tag that is not a version is refused on its own',
    !r.ok && r.problems.length === 1 && /not a version/.test(r.problems[0]),
    'one clear problem beats three confusing ones');
}
check('the v prefix is optional', checkRelease({ ...good, tag: '1.2.3' }).ok === true);

// --- the version reaches the places people look ----------------------------
console.log('\n--- where the version shows up ---');
{
  const entry = readFileSync(new URL('./log.js', import.meta.url), 'utf8');
  check('the run log records which version ran', /VERSION/.test(entry),
    'otherwise the log tab cannot answer "which version is this copy?"');
}
{
  const { buildEntry } = await import('./log.js');
  const row = buildEntry({ what: 'watch', outcome: 'ok', summary: 's', detail: 'd' });
  check('the logged row carries the version', row.what === `watch ${VERSION}`, row.what);
}
{
  // The built file has to carry a real version, not the placeholder the
  // sources use. A copy that cannot say which version it is cannot be told it
  // is out of date.
  const built = readFileSync(new URL('../dist/Code.gs', import.meta.url), 'utf8');
  check('the built file states its version',
    new RegExp(`// version ${VERSION.replace(/\./g, '\\.')}`).test(built),
    built.split('\n').slice(0, 3).join(' '));
  check('and carries it into every logged row',
    /const VERSION = '\d+\.\d+\.\d+'/.test(built));
}

// --- the release workflow --------------------------------------------------
console.log('\n--- the release workflow ---');
{
  const wf = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  check('it fires on version tags', /tags: \['v\*'\]/.test(wf));
  check('it runs the tests before publishing', /npm test/.test(wf));
  check('it checks the tag before publishing', /release\.js "\$\{GITHUB_REF_NAME\}"/.test(wf));
  check('it takes the notes from the changelog', /--notes/.test(wf) && /--notes-file/.test(wf));
  check('it can write releases', /contents: write/.test(wf));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
