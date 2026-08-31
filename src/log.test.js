#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Tests for the run log.
//
// The problem it exists for: a scheduled run that fails is invisible from the
// sheet, and a diagnostic whose whole worth is its output was printing that
// output to a log on another website.
import { teeConsole, buildEntry, planLogWrite, logRun, recorded } from './log.js';
import { TABS, headers, columnIndex } from './sheet/schema.js';
import { memoryClient } from './sheet/memory.js';
import { readFileSync } from 'node:fs';
import { VERSION } from './version.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
};
const HEAD = headers(TABS.log);
const NOW = new Date('2026-08-29T11:32:04Z');

// --- capturing output ------------------------------------------------------
console.log('--- capturing what a run prints ---');
{
  const tee = teeConsole();
  console.log('first line');
  console.log('second', 'line');
  tee.stop();
  check('it captures what was printed', tee.text() === 'first line\nsecond line', JSON.stringify(tee.text()));
}
{
  // Printing must still happen — capturing output by swallowing it would make
  // the Actions log useless, which is where you go when the sheet is broken.
  const seen = [];
  const real = console.log;
  console.log = (...a) => seen.push(a.join(' '));
  const tee = teeConsole();
  console.log('still printed');
  tee.stop();
  console.log = real;
  check('and still prints it', seen.includes('still printed'));
}
{
  const tee = teeConsole();
  console.error('an error line');
  tee.stop();
  check('stderr is captured too', tee.text() === 'an error line');
}
{
  const tee = teeConsole();
  console.log('x'.repeat(60000));
  tee.stop();
  // A cell holds 50,000 characters and rejects more.
  check('a huge run is truncated to fit a cell', tee.text().length < 50000, String(tee.text().length));
  check('and says it was truncated', /truncated/.test(tee.text()));
  check('and points at where the rest is', /Actions log/.test(tee.text()));
}
{
  const tee = teeConsole();
  tee.stop();
  check('a silent run captures nothing, not undefined', tee.text() === '');
  // Restoring must be complete, or every later test logs into a dead buffer.
  const before = console.log;
  const t2 = teeConsole();
  t2.stop();
  check('the console is properly restored', console.log === before);
}

// --- the row ---------------------------------------------------------------
console.log('\n--- the row ---');
{
  const e = buildEntry({ what: 'watch', outcome: 'ok', summary: 'ten matched', detail: 'a\nb' }, NOW);
  check('the time is readable, not an ISO string', e.when === '2026-08-29 11:32:04', e.when);
  // The version rides along in this column, so the log tab can answer
  // "which version is this copy?" without a git history to consult.
  check('what ran is recorded, with the version', e.what === `watch ${VERSION}`, e.what);
  check('so is the outcome', e.outcome === 'ok');
  check('the detail keeps its line breaks', e.detail === 'a\nb');
}
{
  const e = buildEntry({ what: 'watch', summary: 'line one\nline two' }, NOW);
  check('the summary is one line', e.summary === 'line one');
  check('and defaults to ok', e.outcome === 'ok');
  const bare = buildEntry({}, NOW);
  check('a bare entry is still a valid row', bare.what === `run ${VERSION}` && bare.summary === '');
}

// --- writing it ------------------------------------------------------------
console.log('\n--- appending ---');
{
  const sheet = memoryClient({ log: [HEAD] });
  await logRun(sheet, { what: 'watch', outcome: 'ok', summary: 'first' }, NOW);
  await logRun(sheet, { what: 'check', outcome: 'failed', summary: 'second' }, NOW);
  const grid = sheet._grid('log');
  check('rows are appended in order', grid.length === 3 && grid[1][3] === 'first' && grid[2][3] === 'second',
    JSON.stringify(grid.map((r) => r[3])));
  check('the header survives', grid[0][0] === 'When');
  check('a failure is recorded as one', grid[2][2] === 'failed');
}
{
  const ops = planLogWrite([HEAD], buildEntry({ what: 'x' }, NOW));
  check('one row per run', ops.length === 1 && ops[0].values.length === 1);
  check('written at the first free row', ops[0].range === 'log!A2:E2', ops[0].range);
}

// --- it must never cost a run ----------------------------------------------
console.log('\n--- failing safely ---');
{
  const broken = {
    getValues: async () => { throw new Error('sheet on fire'); },
    applyOps: async () => {},
  };
  const r = await logRun(broken, { what: 'watch' }, NOW);
  check('a broken sheet does not throw', r.logged === false);
  check('and says why', /on fire/.test(r.reason), r.reason);
  check('no sheet at all is fine', (await logRun(null, { what: 'x' })).logged === false);
}
{
  // The record of what happened is worth less than the thing that happened.
  const sheet = memoryClient({ log: [HEAD] });
  let ran = false;
  const result = await recorded(sheet, 'watch', async () => {
    ran = true;
    console.log('did the work');
    return { summary: 'ten matched' };
  });
  check('the work still runs', ran && result.summary === 'ten matched');
  const row = sheet._grid('log')[1];
  check('and is recorded', row[1] === `watch ${VERSION}` && row[2] === 'ok', row[1]);
  check('with its summary', row[3] === 'ten matched');
  check('and everything it printed', row[4] === 'did the work');
}
{
  const sheet = memoryClient({ log: [HEAD] });
  let threw = null;
  try {
    await recorded(sheet, 'watch', async () => {
      console.log('got this far');
      throw new Error('the board went down');
    });
  } catch (e) { threw = e.message; }

  check('a failing run still fails', threw === 'the board went down');
  const row = sheet._grid('log')[1];
  check('and is recorded as failed', row[2] === 'failed');
  check('with the reason', row[3] === 'the board went down');
  check('and what it managed to print first', row[4] === 'got this far');
}

// --- every menu action is recorded -----------------------------------------
console.log('\n--- coverage ---');
{
  // An action that runs unrecorded is exactly the silence the log tab exists
  // for. Here every one of them goes through recordRun, and a menu item that
  // skipped it would leave nothing behind on a morning nobody was watching.
  const menu = readFileSync(new URL('./gas/menu.js', import.meta.url), 'utf8');
  const handlers = [...menu.matchAll(/\.addItem\('[^']+', '(\w+)'\)/g)].map((m) => m[1]);
  check('the menu has handlers', handlers.length >= 10, `${handlers.length}`);

  // Prompts and schedule changes are not runs; the rest are.
  const notRuns = ['menuSchedule', 'menuUnschedule', 'menuNotifications'];
  const runs = handlers.filter((h) => !notRuns.includes(h));
  const unrecorded = runs.filter((h) => {
    // The whole function, not a fixed window: menuFirstRun opens with a long
    // prompt and its recordRun call sits well past any guess at a length.
    const at = menu.indexOf(`function ${h}(`);
    let body = menu;
    if (at !== -1) {
      let depth = 0;
      let end = at;
      for (let i = menu.indexOf('{', at); i < menu.length; i++) {
        if (menu[i] === '{') depth++;
        if (menu[i] === '}') { depth--; if (!depth) { end = i; break; } }
      }
      body = menu.slice(at, end + 1);
    }
    return !/recordRun\(/.test(body) && !new RegExp(`${h} = diagnostic\\(`).test(menu);
  });
  check('every action that runs is recorded', unrecorded.length === 0, unrecorded.join(', '));

  const scheduled = /recordRun\(client, 'watch \(scheduled\)'/.test(
    readFileSync(new URL('./gas/menu.js', import.meta.url), 'utf8'));
  check('including the one nobody is watching', scheduled);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
