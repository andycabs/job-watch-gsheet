// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// Reading CHANGELOG.md.
//
// Two callers, both wanting the same thing from different angles: the release
// workflow needs one version's section to use as the release notes, and the
// test suite needs the newest version to check that a tag, package.json and
// the changelog all agree before any of it is published.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HEADING = /^## +(\d+\.\d+\.\d+)/;

export function changelogPath() {
  return fileURLToPath(new URL('../CHANGELOG.md', import.meta.url));
}

/** Every version heading, newest first — file order, not sorted. */
export function versions(text) {
  return String(text).split('\n').map((l) => l.match(HEADING)?.[1]).filter(Boolean);
}

/** The most recent version the changelog documents. */
export function latestVersion(text) {
  return versions(text)[0] || null;
}

/**
 * One version's notes: everything under its heading, up to the next one.
 * Returns null when the version has no section, which is the case the release
 * workflow must fail on rather than publishing an empty release.
 */
export function notesFor(text, version) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((l) => l.match(HEADING)?.[1] === version);
  if (start === -1) return null;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => HEADING.test(l));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return body || null;
}
