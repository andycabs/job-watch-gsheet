// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// The starter templates, as data.
//
// On Node these are the files in templates/. The spreadsheet build replaces
// this file with the same objects written out as literals, because there is
// no file system there and they are small enough to carry. Whichever way they
// arrive, everything downstream sees one shape.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

export const TEMPLATES = fs.readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((file) => ({ id: file.replace(/\.json$/, ''), ...JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')) }));
