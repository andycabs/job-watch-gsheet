// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// The run log.
//
// Every run appends a row: when it ran, what ran, how it went, and everything
// it printed. Two problems, one answer.
//
// A scheduled run that fails, or that succeeds and finds nothing, is otherwise
// invisible from the sheet — you would have to go to another website to learn
// that this morning's watch never happened.
//
// And the diagnostics — check, explain, suggest, learn — exist entirely for
// what they print. Starting one from the sheet's menu and having its answer go
// to a log on GitHub is a button that appears to do nothing.
//
// Logging never throws and never fails a run. A record of what happened is
// worth less than the thing that happened, and a broken log must not cost a
// morning's postings.
// ---------------------------------------------------------------------------
import { TABS, readRange, colLetter, rowInSheetOrder } from './sheet/schema.js';
import { VERSION } from './version.js';

/** Google's cell limit is 50,000 characters; leave room for the ellipsis. */
const MAX_DETAIL = 45000;

/**
 * Captures everything written to the console while still printing it.
 *
 * The alternative was rewriting eight command-line scripts to build strings
 * instead of printing, which would have made each of them worse to read for
 * the sake of a feature none of them is about.
 */
export function teeConsole() {
  const lines = [];
  const original = { log: console.log, error: console.error };

  const capture = (fn) => (...args) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    fn.apply(console, args);
  };
  console.log = capture(original.log);
  console.error = capture(original.error);

  return {
    stop() { console.log = original.log; console.error = original.error; },
    text() {
      const all = lines.join('\n').trim();
      return all.length > MAX_DETAIL
        ? `${all.slice(0, MAX_DETAIL)}\n\n[…truncated; the full output is in the Actions log]`
        : all;
    },
  };
}

/** One row, ready to append. */
export function buildEntry({ what, outcome, summary, detail }, now = new Date()) {
  return {
    // Local-ish and readable: a run log is read by a person, not parsed.
    when: now.toISOString().replace('T', ' ').slice(0, 19),
    // The version goes in beside the command: when someone asks why a run
    // behaved oddly, "which version is this copy?" is the first question, and
    // a template copy's git history cannot answer it.
    what: `${String(what || 'run')} ${VERSION}`,
    outcome: String(outcome || 'ok'),
    summary: String(summary || '').split('\n')[0].slice(0, 500),
    detail: String(detail || ''),
  };
}

/** Where the row goes, given what the tab already holds. */
export function planLogWrite(existing = [], entry) {
  const tab = TABS.log;
  const rows = Array.isArray(existing) ? existing : [];
  const [header = [], ...body] = rows;
  const start = body.length + 2;
  const width = Math.max(header.length, tab.columns.length);

  return [{
    op: 'writeRange',
    range: `${tab.name}!A${start}:${colLetter(width - 1)}${start}`,
    values: [rowInSheetOrder(tab, header, entry)],
  }];
}

/**
 * Appends one row. Swallows everything: a log that cannot be written is a
 * smaller problem than a run that stopped because of it.
 */
export async function logRun(client, fields, now = new Date()) {
  if (!client) return { logged: false, reason: 'no sheet' };
  try {
    const existing = await client.getValues(readRange(TABS.log));
    await client.applyOps(planLogWrite(existing, buildEntry(fields, now)));
    return { logged: true };
  } catch (err) {
    console.error(`(run not logged — ${err.message})`);
    return { logged: false, reason: err.message };
  }
}

/**
 * Runs something, captures what it prints, and records how it went.
 * Re-throws, so a failing run still fails — it is just no longer silent.
 */
export async function recorded(client, what, fn) {
  const tee = teeConsole();
  try {
    const result = await fn();
    tee.stop();
    await logRun(client, {
      what,
      outcome: result?.outcome || 'ok',
      summary: result?.summary || '',
      detail: tee.text(),
    });

    // A command that could not do its job must exit non-zero, or its workflow
    // goes green while reporting a broken configuration. Setting exitCode
    // rather than calling exit() lets the log write finish first — which is
    // why these commands stopped calling exit() in the first place.
    // Only where there is a process to give an exit code to. Inside a
    // spreadsheet the caller reads the outcome off the returned object, and
    // the run log is what carries a failure to a person.
    if (result?.outcome === 'failed' && typeof process !== 'undefined') process.exitCode = 1;
    return result;
  } catch (err) {
    tee.stop();
    await logRun(client, { what, outcome: 'failed', summary: err.message, detail: tee.text() });
    throw err;
  }
}
