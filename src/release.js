#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// Checks a release before it is published, and prints its notes.
//
//   node src/release.js v1.0.0 [--notes]
//
// Three things have to agree: the tag being pushed, the version in
// package.json, and the newest heading in CHANGELOG.md. When they don't, the
// mistake is always the same — a tag pushed without bumping the version — and
// the cost is a published release whose number means nothing. Better to fail
// the workflow than to fix a release after people have taken it.
//
// With --notes it prints the section body for the release description.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { VERSION } from './version.js';
import { changelogPath, latestVersion, notesFor } from './changelog.js';

/** Pure, so the tests can drive it without a tag or a file. */
export function checkRelease({ tag, version, latest, notes }) {
  const problems = [];
  const wanted = String(tag || '').replace(/^v/, '');

  if (!/^\d+\.\d+\.\d+$/.test(wanted)) {
    problems.push(`Tag "${tag}" is not a version — expected something like v1.2.3.`);
    return { ok: false, problems, version: wanted };
  }
  if (wanted !== version) {
    problems.push(
      `Tag ${tag} does not match package.json (${version}). ` +
      `Bump the version, commit, then move the tag.`,
    );
  }
  if (wanted !== latest) {
    problems.push(
      `Tag ${tag} is not the newest entry in CHANGELOG.md (${latest || 'none'}). ` +
      `Add a "## ${wanted}" section above the others.`,
    );
  }
  if (!notes) problems.push(`CHANGELOG.md has nothing under "## ${wanted}".`);

  return { ok: problems.length === 0, problems, version: wanted };
}

// --- command line -----------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const tag = process.argv[2];
  const text = readFileSync(changelogPath(), 'utf8');
  const wanted = String(tag || '').replace(/^v/, '');
  const result = checkRelease({
    tag,
    version: VERSION,
    latest: latestVersion(text),
    notes: notesFor(text, wanted),
  });

  if (!result.ok) {
    for (const p of result.problems) console.error(`  ${p}`);
    process.exit(1);
  }
  if (process.argv.includes('--notes')) console.log(notesFor(text, wanted));
  else console.log(`${tag} checks out.`);
}
