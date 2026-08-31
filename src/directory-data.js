// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// The shipped catalogue.
//
// On Node this reads data/directory.json. The spreadsheet build replaces this
// file with the same companies written out as literals, because a tool that
// calls itself self-contained should not need a working network connection to
// a particular repository before its first run can do anything.
//
// That is not a hypothetical. The first real run of the spreadsheet build came
// back with an empty directory tab, because the catalogue was being fetched
// from a repository that is still private and answers 404 to anyone who is not
// signed in. Carrying the list is the fix; fetching is now only a refresh.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'directory.json');

export const DIRECTORY = JSON.parse(fs.readFileSync(FILE, 'utf8'));
