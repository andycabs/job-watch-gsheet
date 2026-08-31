// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// Which version this copy is running.
//
// A copy made from the template starts its own history, so `git log` says
// nothing about how far behind upstream it is. The version in package.json is
// the only honest answer, and it needs to reach the places where the question
// gets asked: a diagnostic's output, and the run log in the sheet.
//
// Reading the file rather than importing it keeps this working on Node 18,
// where JSON import assertions are still behind a flag.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function read() {
  try {
    const path = fileURLToPath(new URL('../package.json', import.meta.url));
    const { version } = JSON.parse(readFileSync(path, 'utf8'));
    return typeof version === 'string' && version.trim() ? version.trim() : 'unknown';
  } catch {
    // Never worth failing a run over. An unknown version is a worse answer
    // than a real one, but it is not an error.
    return 'unknown';
  }
}

export const VERSION = read();
