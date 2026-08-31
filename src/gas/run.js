// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// The watch, run from inside the spreadsheet.
//
// The same sequence the command line runs — read the sheet, fetch each board,
// triage, plan, write — with the two ends swapped: SpreadsheetApp instead of a
// web app, UrlFetchApp instead of Node's fetch. Everything between those two
// ends is the engine, unchanged and shared.
//
// Synchronous throughout, because Apps Script is. The build removes async and
// await from the engine on the way in; nothing here ever had any.
// ---------------------------------------------------------------------------
import { ADAPTERS } from '../boards.js';
import { REQUEST_DELAY_MS } from '../probe.js';
import { readConfig } from '../sheet/read.js';
import { indexColumns } from '../sheet/read.js';
import { TABS, readRange } from '../sheet/schema.js';
import { triage } from '../triage.js';
import { planSync, planDropped } from '../sync.js';
import { payRank } from '../score.js';
import { buildEntry, planLogWrite } from '../log.js';
import { sendDigest } from './notify.js';
import { readProperty } from './props.js';
import { cleanDirectory, planDirectorySync, planEnable } from '../directory-plan.js';
import { DIRECTORY } from '../directory-data.js';
import { planTemplateRows, planTemplateWrite } from '../template-plan.js';
import { TEMPLATES } from '../templates-data.js';
import { planBootstrap, auditSheet } from '../sheet/bootstrap.js';
import { readSheetState } from '../sheet/apply.js';
import { sheetClient } from './sheet.js';
import { gasFetch, gasSleep } from './fetch.js';

// One delay, shared. It protects somebody else's API, and two copies of a
// number like this drift apart the first time one of them is tuned.
export { REQUEST_DELAY_MS };

/**
 * Everything a run says, collected rather than printed.
 *
 * There is no console to watch here — a run started from a menu finishes while
 * you are looking at the sheet — so the transcript is the product, and it goes
 * to the log tab where it can be read afterwards.
 */
export function transcript() {
  const lines = [];
  return {
    say: (text = '') => { lines.push(String(text)); },
    text: () => lines.join('\n').slice(0, 45000),
  };
}

export function runWatch({ client, now = new Date(), fetchImpl = gasFetch, sleep = gasSleep } = {}) {
  const sheet = client || sheetClient();
  const out = transcript();
  const config = readConfig(sheet);

  for (const problem of config.problems || []) out.say(`  ${problem}`);
  if (!config.rules.title.length && !config.rules.body.length) {
    out.say('No active rules — nothing can match. Add a row to the rules tab.');
    return { outcome: 'failed', summary: 'no rules', detail: out.text() };
  }

  const ready = config.companies.ready;
  if (!ready.length) {
    out.say('No companies with a resolved board yet.');
    return { outcome: 'failed', summary: 'no companies', detail: out.text() };
  }

  const matches = [];
  const dropped = [];
  const failures = [];

  ready.forEach((company, i) => {
    try {
      const adapter = ADAPTERS[company.ats];
      if (!adapter) throw new Error(`unknown ATS "${company.ats}"`);
      const jobs = adapter.fetchJobs(company.slug, { fetchImpl });
      const result = triage(jobs, company, config, now);
      matches.push(...result.matches);
      dropped.push(...result.dropped);
      out.say(`${company.name} — ${jobs.length} postings, ${result.matches.length} matched`
        + (result.dropped.length ? `, ${result.dropped.length} filtered out` : ''));
    } catch (err) {
      // One unreachable board must not cost the morning's other thirty.
      failures.push({ company: company.name, error: String(err && err.message || err) });
      out.say(`${company.name} — failed: ${String(err && err.message || err)}`);
    }
    if (i < ready.length - 1) sleep(REQUEST_DELAY_MS);
  });

  // Two companies on one slug, or a board listing a posting twice, would
  // otherwise append the same key twice and only ever refresh the first.
  const byKey = new Map();
  for (const m of matches) byKey.set(m.key, m);
  const unique = [...byKey.values()].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));

  const existing = sheet.getValues(readRange(TABS.matches));

  // Pay is ranked against everything the sheet has ever held, not today's
  // haul — one morning's postings are far too few to say anything.
  const { index } = indexColumns(TABS.matches, existing[0] || []);
  const population = [
    ...existing.slice(1).map((row) => Number(row && row[index.salaryMax])),
    ...unique.map((m) => Number(m.salaryMax)),
  ].filter((n) => Number.isFinite(n) && n > 0);
  for (const m of unique) {
    const rank = payRank(Number(m.salaryMax), population);
    if (rank) m.payRank = rank;
  }

  const plan = planSync(existing, unique, { settings: config.settings, now });
  const droppedOps = planDropped(sheet.getValues(readRange(TABS.dropped, 2)).length, dropped);

  out.say('');
  out.say(`${unique.length} matched, ${dropped.length} filtered out`
    + (failures.length ? `, ${failures.length} board(s) unreachable` : ''));
  out.say(plan.summary);
  for (const problem of plan.problems || []) out.say(`  ${problem}`);

  if (plan.changes.length) {
    out.say('');
    out.say('Changed since the last run:');
    for (const c of plan.changes.slice(0, 10)) out.say(`  ${c.record.company} — ${c.record.title}: ${c.change}`);
  }

  const operations = [...(plan.operations || []), ...droppedOps];
  if (operations.length) sheet.applyOps(operations);

  const digest = sendDigest(plan.addedRecords || [], { spreadsheetUrl: spreadsheetUrl() });
  if (digest.sent) out.say(`Digest emailed to ${digest.to}.`);
  else if (digest.reason && digest.reason !== 'EMAIL_TO not set' && digest.reason !== 'nothing new') {
    out.say(`Digest not sent: ${digest.reason}`);
  }

  return {
    outcome: plan.problems && plan.problems.length ? 'failed' : 'ok',
    summary: `${unique.length} matched from ${ready.length} companies · ${plan.summary}`,
    detail: out.text(),
    matched: unique.length,
    changes: plan.changes,
    added: plan.addedRecords || [],
  };
}

/**
 * Creates whatever the workbook is missing and leaves the rest alone.
 *
 * Safe on a sheet in daily use: it only ever adds. That is how a later
 * version's new tab, column or setting reaches a sheet somebody has already
 * filled in, and it is why this is worth running again after an update rather
 * than only once at the start.
 */
export function runSetup({ client, reformat = false } = {}) {
  const sheet = client || sheetClient();
  const out = transcript();

  const state = readSheetState(sheet);
  const plan = planBootstrap({ ...state, reformat });

  if (!plan.operations.length) {
    out.say('Nothing to do — the workbook already has everything.');
    return { outcome: 'ok', summary: 'nothing to do', detail: out.text() };
  }

  out.say(plan.summary);
  sheet.applyOps(plan.operations);

  // Audit the sheet as it now is rather than as it was: a setup that reported
  // success while leaving the workbook wrong would be worse than one that
  // failed outright.
  const audit = auditSheet(readSheetState(sheet));
  if (!audit.ok) {
    for (const problem of audit.problems) out.say(`  ${problem}`);
    return { outcome: 'failed', summary: 'the workbook is still missing things', detail: out.text() };
  }

  const added = [
    plan.created.length ? `${plan.created.length} tab(s)` : '',
    plan.added && plan.added.length ? `${plan.added.length} setting(s)` : '',
    plan.extended && plan.extended.length ? `${plan.extended.length} tab(s) widened` : '',
  ].filter(Boolean).join(', ');

  return {
    outcome: 'ok',
    summary: added || `${plan.operations.length} change(s) applied`,
    detail: out.text(),
  };
}

/**
 * Where the shipped catalogue comes from.
 *
 * Fetched rather than baked into this file, for two reasons. It is most of the
 * bulk — the companies outweigh the program — and a copy of the script made
 * six months ago would otherwise be stuck with a six month old list of
 * employers, boards included that have since moved.
 *
 * A script property overrides it, so anybody running their own fork points at
 * their own list without editing generated code.
 */
export const CATALOGUE_URL =
  'https://raw.githubusercontent.com/andycabs/job-watch/main/data/directory.json';

/** A link back to this spreadsheet, for the digest to point at. */
export function spreadsheetUrl() {
  try {
    return globalThis.SpreadsheetApp.getActive().getUrl();
  } catch {
    return '';
  }
}

export function catalogueUrl() {
  return readProperty('CATALOGUE_URL', CATALOGUE_URL);
}

/**
 * Refreshes the catalogue, then follows whatever is ticked.
 *
 * Two steps rather than one because they answer to different owners: the
 * catalogue is shipped content this replaces wholesale, and the Add column is
 * the reader's and is never written from here.
 */
export function runDirectory({ client, fetchImpl = gasFetch, url = null } = {}) {
  const sheet = client || sheetClient();
  const out = transcript();

  // The catalogue that shipped with this file is the floor: it always works,
  // with no network and no repository. A refresh from upstream is an
  // improvement on it, never a precondition for it.
  let doc = cleanDirectory(DIRECTORY);
  let source = `built in (${doc.entries.length} companies)`;

  try {
    const res = fetchImpl(url || catalogueUrl(), { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const fresh = cleanDirectory(res.json());
    if (fresh.entries.length) {
      doc = fresh;
      source = `refreshed (${doc.entries.length} companies)`;
    }
  } catch (err) {
    out.say(`Could not reach the catalogue upstream (${String(err && err.message || err)}) —`);
    out.say('using the list that came with this script.');
  }
  out.say(`Catalogue: ${source}`);

  const existing = sheet.getValues(readRange(TABS.directory));
  const sync = planDirectorySync(existing, doc.entries);
  if (sync.operations.length) sheet.applyOps(sync.operations);
  out.say(`  ${sync.added} new, ${sync.updated} updated.`);
  for (const problem of sync.problems || []) out.say(`  ${problem}`);

  // Read it back rather than trusting that the write worked.
  //
  // "352 new" counts what was planned, not what arrived, and the first real
  // run of this reported exactly that over a tab that was empty. A write that
  // silently does nothing, or fills the rows with blanks, looks identical to
  // success from here — so check, and say what is actually in the tab.
  // Read it back rather than trusting the write. "352 new" counts what was
  // planned, not what arrived — and the first real run reported exactly that
  // over a tab whose rows had all been appended below row 1000.
  const after = sheet.getValues(readRange(TABS.directory));
  const nameAt = indexColumns(TABS.directory, after[0] || []).index.name;
  const body = after.slice(1);
  const named = body.filter((row) => String((row || [])[nameAt] ?? '').trim()).length;
  const firstNamed = body.findIndex((row) => String((row || [])[nameAt] ?? '').trim());

  if (!named || firstNamed > 0) {
    out.say(`  Wrote ${sync.added} rows, but the tab holds ${named} named companies`
      + (firstNamed > 0 ? `, the first at row ${firstNamed + 2}.` : '.'));
    return {
      outcome: 'failed',
      summary: `catalogue written but only ${named} companies are readable in the tab`,
      detail: out.text(),
    };
  }
  out.say(`  ${named} companies are in the tab, starting at row 2.`);

  // Read back rather than reusing what was planned: the ticks live in the
  // sheet, and the refresh above may have appended rows a person has not seen.
  const enable = planEnable(
    sheet.getValues(readRange(TABS.directory)),
    sheet.getValues(readRange(TABS.companies)),
  );
  if (enable.operations.length) sheet.applyOps(enable.operations);
  if (enable.added) out.say(`Now watching ${enable.added} more compan${enable.added === 1 ? 'y' : 'ies'}.`);
  for (const problem of enable.problems || []) out.say(`  ${problem}`);

  return {
    outcome: (sync.problems || []).length || (enable.problems || []).length ? 'failed' : 'ok',
    summary: `${doc.entries.length} in the catalogue, ${enable.added || 0} added to the watch`,
    detail: out.text(),
  };
}

/** The starter rule sets, by name. */
export function templateNames() {
  return TEMPLATES.map((t) => t.id);
}

/**
 * Adds a starter template's rules to the rules tab.
 *
 * Adds only: a rule already there is left alone rather than duplicated, so
 * running this twice, or running two templates, does what somebody would
 * expect rather than filling the tab with pairs.
 */
export function runTemplate(id, { client } = {}) {
  const sheet = client || sheetClient();
  const out = transcript();

  const template = TEMPLATES.find((t) => t.id === id);
  if (!template) {
    out.say(`No template "${id}". Available: ${templateNames().join(', ')}`);
    return { outcome: 'failed', summary: `no template "${id}"`, detail: out.text() };
  }

  const existing = sheet.getValues(readRange(TABS.rules));
  const plan = planTemplateRows(template, existing, { note: `from ${id}` });
  const ops = planTemplateWrite(plan);
  if (ops.length) sheet.applyOps(ops);

  out.say(`${template.name || id}: ${plan.rows.length} rule(s) added`
    + (plan.skipped.length ? `, ${plan.skipped.length} already there` : '') + '.');

  return {
    outcome: 'ok',
    summary: `${plan.rows.length} rule(s) from ${id}`,
    detail: out.text(),
  };
}

/**
 * Everything a new sheet needs, in one go.
 *
 * The order matters and each step is allowed to fail without stopping the
 * rest: a workbook with tabs and rules but no catalogue is still usable, and
 * telling somebody which part did not work beats refusing to do any of it.
 */
export function runFirstRun(templateId, { client, fetchImpl = gasFetch } = {}) {
  const sheet = client || sheetClient();
  const out = transcript();
  const steps = [];

  const step = (name, fn) => {
    try {
      const result = fn();
      steps.push(`${name}: ${result.summary}`);
      out.say(`— ${name} —`);
      out.say(result.detail || result.summary);
      return result;
    } catch (err) {
      steps.push(`${name}: failed`);
      out.say(`— ${name} — failed: ${String(err && err.message || err)}`);
      return { outcome: 'failed' };
    }
  };

  step('setup', () => runSetup({ client: sheet }));
  if (templateId && templateId !== 'none') step('rules', () => runTemplate(templateId, { client: sheet }));
  step('catalogue', () => runDirectory({ client: sheet, fetchImpl }));

  // Nobody has ticked anything yet — a first run cannot know who somebody
  // wants to watch. Running the watch anyway ends a successful setup on "No
  // companies with a resolved board yet", which reads like a failure and is
  // the last thing they see. Say what to do next instead.
  const ready = readConfig(sheet).companies.ready.length;
  if (!ready) {
    out.say('');
    out.say('— next —');
    out.say('Nothing is being watched yet, so there is nothing to fetch.');
    out.say('');
    out.say('  Open the directory tab and tick Add beside any company you would');
    out.say('  work for. Or type names into the companies tab and run');
    out.say('  "Find boards for new companies".');
    out.say('');
    out.say('  Then run the watch.');
    return {
      outcome: 'ok',
      summary: `${steps.join(' · ')} · ready — now pick companies in the directory tab`,
      detail: out.text(),
    };
  }

  const watch = step('watch', () => runWatch({ client: sheet, fetchImpl }));

  return {
    outcome: watch.outcome === 'ok' ? 'ok' : 'failed',
    summary: steps.join(' · '),
    detail: out.text(),
  };
}

/**
 * Runs something and records how it went, the way the command line does.
 *
 * A run started from a menu is invisible while it happens and gone when it
 * finishes, so the row in the log tab is the only evidence it ever ran.
 */
export function recordRun(client, what, fn, now = new Date()) {
  const sheet = client || sheetClient();
  let result;
  try {
    result = fn(sheet);
  } catch (err) {
    result = { outcome: 'failed', summary: String(err && err.message || err), detail: '' };
    writeLog(sheet, what, result, now);
    throw err;
  }
  writeLog(sheet, what, result, now);
  return result;
}

function writeLog(sheet, what, result, now) {
  try {
    const existing = sheet.getValues(readRange(TABS.log));
    sheet.applyOps(planLogWrite(existing, buildEntry({
      what,
      outcome: result.outcome || 'ok',
      summary: result.summary || '',
      detail: result.detail || '',
    }, now)));
  } catch {
    // A log that cannot be written is a smaller problem than a run that
    // stopped because of it.
  }
}
