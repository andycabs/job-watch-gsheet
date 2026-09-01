// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// The four questions, answered inside the spreadsheet.
//
//   check    what does my configuration actually say?
//   suggest  what am I missing?
//   learn    what do my own choices say about my rules?
//   discover where does this company post its jobs?
//
// Each one exists for what it prints, and nobody is watching a console here —
// so each returns its transcript, and the caller puts that in the log tab
// where it can be read afterwards. That is the whole reason the log tab was
// built, and it matters more here than it did on the command line.
// ---------------------------------------------------------------------------
import { ADAPTERS, ATS_NAMES } from '../boards.js';
import { matchJob } from '../match.js';
import { evaluateSalary } from '../salary.js';
import { readConfig, indexColumns } from '../sheet/read.js';
import { auditSheet } from '../sheet/bootstrap.js';
import { readSheetState } from '../sheet/apply.js';
import { TABS, readRange, colLetter, columnIndex } from '../sheet/schema.js';
import { countPhrases, tally } from '../phrases.js';
import { splitByVerdict, leaningPhrases, companyLeanings, salaryLeaning, MINIMUM } from '../leanings.js';
import { probeOrder, planDiscoveryWrites } from '../probe.js';
import { transcript, REQUEST_DELAY_MS } from './run.js';
import { sheetClient } from './sheet.js';
import { watchTimeZone, scriptTimeZone, scheduledHour, lastRunStamp, TZ_FIX } from './when.js';
import { gasFetch, gasSleep } from './fetch.js';

/** Reads the sheet back and says what it understood. Writes nothing. */
export function runCheck({ client } = {}) {
  const sheet = client || sheetClient();
  const out = transcript();

  const audit = auditSheet(readSheetState(sheet));
  if (!audit.ok) {
    out.say('Sheet structure');
    for (const problem of audit.problems) out.say(`  ${problem}`);
    out.say('  Run "Set up the workbook" to add anything missing.');
    out.say('');
  }

  const config = readConfig(sheet);
  if (config.problems && config.problems.length) {
    out.say('Problems');
    for (const problem of config.problems) out.say(`  ${problem}`);
    out.say('');
  }

  out.say('Rules');
  for (const kind of ['title', 'body', 'exclude']) {
    const list = config.rules[kind] || [];
    out.say(`  ${kind.padEnd(9)} ${list.length ? list.map((p) => p.label || p.source).join(', ') : '(none)'}`);
  }

  out.say('');
  out.say('When it runs');
  {
    // The commonest wrong answer in a copied sheet, and a silent one: the run
    // happens, on time, in somebody else's timezone.
    const { tz, ok } = watchTimeZone();
    const at = scheduledHour();
    const last = lastRunStamp();
    out.say(`  daily run          ${at === null ? 'off' : `${at}:00`}`);
    out.say(`  timezone           ${tz || 'unknown'}${ok ? '' : ' (not one Google recognises)'}`);
    out.say(`  change it at       ${TZ_FIX}`);
    if (at !== null) out.say(`  last scheduled run ${last || 'none yet'}`);
    // The script project has a timezone too, and it is not the one that
    // decides. Said only when it differs, so it reads as reassurance rather
    // than one more thing to configure.
    const scriptTz = scriptTimeZone();
    if (scriptTz && tz && scriptTz !== tz) {
      out.say(`  (the script itself is set to ${scriptTz}; it wakes up hourly and`);
      out.say(`   the run happens on ${tz} time, so that does not matter)`);
    }
  }

  out.say('');
  out.say('Settings');
  const s = config.settings;
  out.say(`  salary floor       ${s.salaryFloor || 'none'}`);
  out.say(`  unpriced postings  ${s.unpriced}`);
  out.say(`  stale postings     ${s.stale} after ${s.stalePostingDays} days`);
  out.say(`  location           ${s.locationMode}`
    + (config.rules.location.allowlist.length
      ? ` (${config.rules.location.allowlist.map((p) => p.label).join(', ')})` : ''));
  out.say(`  close after        ${s.closeAfterDays} days unseen`);
  out.say(`  seniority target   ${(s.seniorityTarget || []).join(', ') || 'no preference'}`);

  out.say('');
  out.say('Companies');
  out.say(`  ${config.companies.ready.length} ready to watch`);
  if (config.companies.needsDiscovery.length) {
    out.say(`  ${config.companies.needsDiscovery.length} waiting for a board`);
  }

  const failing = !audit.ok || (config.problems || []).length
    || !config.rules.title.length && !config.rules.body.length
    || !config.companies.ready.length;

  return {
    outcome: failing ? 'failed' : 'ok',
    summary: failing
      ? 'the configuration will not produce results as it stands'
      : `${config.companies.ready.length} companies, ${config.rules.title.length} title rules`,
    detail: out.text(),
  };
}

/**
 * What keeps turning up in postings no rule matched.
 *
 * Fetches, so it costs the same as a watch. It suggests and never changes
 * anything: a tool that edited your rules on its own reading of one morning's
 * postings would be worse than one that says nothing.
 */
export function runSuggest({ client, fetchImpl = gasFetch, sleep = gasSleep } = {}) {
  const sheet = client || sheetClient();
  const out = transcript();
  const config = readConfig(sheet);

  const ready = config.companies.ready;
  if (!ready.length) {
    return { outcome: 'failed', summary: 'no companies to look at', detail: 'Nothing is being watched yet.' };
  }

  const missed = [];
  const locationDrops = [];
  let total = 0;
  let matched = 0;
  let salaryDrops = 0;

  ready.forEach((company, i) => {
    try {
      const jobs = ADAPTERS[company.ats].fetchJobs(company.slug, { fetchImpl });
      for (const job of jobs) {
        total++;
        const verdict = matchJob(job, config.rules);
        if (verdict.stage === 'no-signal') { missed.push(job.title); continue; }
        if (verdict.stage === 'excluded') continue;
        if (verdict.stage === 'location') { locationDrops.push(job.location || '(none given)'); continue; }
        const pay = evaluateSalary(job, config.settings);
        if (pay.verdict === 'below' || (pay.verdict === 'unknown' && config.settings.unpriced === 'drop')) {
          salaryDrops++;
          continue;
        }
        matched++;
      }
    } catch (err) {
      out.say(`${company.name}: board unreachable — ${String(err && err.message || err)}`);
    }
    if (i < ready.length - 1) sleep(REQUEST_DELAY_MS);
  });

  out.say('Coverage');
  out.say(`  ${total} postings across ${ready.length} companies`);
  out.say(`  ${matched} reach your sheet`);
  out.say(`  ${missed.length} matched no rule`
    + (total ? `  (${Math.round((missed.length / total) * 100)}% of everything seen)` : ''));
  if (salaryDrops) out.say(`  ${salaryDrops} matched but were under your salary floor`);

  out.say('');
  out.say('Phrases you have no rule for');
  // countPhrases returns [{ n, ranked: [{ phrase, count, example }] }] —
  // longest phrases first, because "revenue operations manager" says more
  // than "manager" does.
  const groups = countPhrases(missed, { rules: config.rules });
  let anything = false;
  for (const group of groups) {
    const found = (group.ranked || []).slice(0, 8);
    if (!found.length) continue;
    anything = true;
    out.say(`  ${group.n === 1 ? 'Single words' : `${group.n}-word phrases`}`);
    for (const item of found) {
      out.say(`    ${String(item.count).padStart(4)}  ${item.phrase}`
        + (item.example ? `   e.g. ${item.example}` : ''));
    }
  }
  if (!anything) out.say('  Nothing recurring. Your rules cover what these companies post.');

  if (locationDrops.length) {
    out.say('');
    out.say('Locations your filter turned away');
    for (const [place, count] of tally(locationDrops).slice(0, 6)) {
      out.say(`  ${String(count).padStart(4)}  ${place}`);
    }
  }

  return {
    outcome: 'ok',
    summary: `${missed.length} of ${total} postings matched no rule`,
    detail: out.text(),
  };
}

/** What your own Status choices say about your rules. */
export function runLearn({ client } = {}) {
  const sheet = client || sheetClient();
  const out = transcript();

  const rows = sheet.getValues(readRange(TABS.matches));
  const { index } = indexColumns(TABS.matches, rows[0] || []);
  const { kept, passed } = splitByVerdict(rows.slice(1), index);

  if (kept.length < MINIMUM || passed.length < MINIMUM) {
    out.say(`You have marked ${kept.length} kept and ${passed.length} passed.`);
    out.say(`  This needs at least ${MINIMUM} on each side before it says anything.`);
    out.say(`  ${Math.max(0, MINIMUM - kept.length)} more kept and `
      + `${Math.max(0, MINIMUM - passed.length)} more passed to go.`);
    return { outcome: 'ok', summary: 'not enough judgements yet', detail: out.text() };
  }

  const { towards, away } = leaningPhrases(kept, passed);
  out.say(`From ${kept.length} kept and ${passed.length} passed.`);
  out.say('');
  out.say('In the ones you kept');
  if (towards.length) for (const p of towards.slice(0, 8)) out.say(`  ${p.phrase}  (${p.kept} kept, ${p.passed} passed)`);
  else out.say('  Nothing separates them yet.');

  out.say('');
  out.say('In the ones you passed on');
  if (away.length) for (const p of away.slice(0, 8)) out.say(`  ${p.phrase}  (${p.passed} passed, ${p.kept} kept)`);
  else out.say('  Nothing separates them yet.');

  const companies = companyLeanings(kept, passed);
  if (companies.length) {
    out.say('');
    out.say('Companies');
    for (const c of companies.slice(0, 8)) out.say(`  ${c.company}: ${c.kept} kept, ${c.passed} passed`);
  }

  const salary = salaryLeaning(kept, passed);
  if (salary && salary.note) {
    out.say('');
    out.say('Salary');
    out.say(`  ${salary.note}`);
  }

  return {
    outcome: 'ok',
    summary: `${towards.length} phrase(s) towards, ${away.length} away`,
    detail: out.text(),
  };
}

/**
 * Works out where the companies you typed in post their jobs.
 *
 * Slow on purpose: it walks up to six boards per company, and a burst of
 * parallel requests to somebody's free API is how an address gets blocked.
 */
export function runDiscover({ client, fetchImpl = gasFetch, sleep = gasSleep } = {}) {
  const sheet = client || sheetClient();
  const out = transcript();
  const config = readConfig(sheet);

  const pending = config.companies.needsDiscovery;
  if (!pending.length) {
    out.say(config.companies.ready.length
      ? `Nothing to discover — all ${config.companies.ready.length} companies are resolved.`
      : 'No companies yet. Add a name to the companies tab and run this again.');
    return { outcome: 'ok', summary: 'nothing to discover', detail: out.text() };
  }

  const results = [];
  for (const company of pending) {
    let found = null;
    for (const candidate of probeOrder(company, ATS_NAMES)) {
      let jobs = null;
      try {
        jobs = ADAPTERS[candidate.ats].fetchJobs(candidate.slug, { fetchImpl });
      } catch {
        jobs = null;
      }
      // A board that exists but is empty is indistinguishable from a wrong
      // slug, and recording it would quietly retire a company that simply is
      // not hiring this week.
      if (jobs && jobs.length) {
        found = { ...candidate, count: jobs.length, titles: jobs.slice(0, 3).map((j) => j.title) };
        break;
      }
      sleep(REQUEST_DELAY_MS);
    }

    if (!found) {
      out.say(`${company.name} — no board found`);
      continue;
    }
    results.push({ ...found, row: company.row, name: company.name });
    out.say(`${company.name} — ${found.ats}/${found.slug} (${found.count} postings)`);
    // Slugs are first come first served, so a board that answers is not
    // necessarily the company you meant. Three titles is enough to tell.
    for (const title of found.titles) out.say(`    · ${title}`);
  }

  const writes = planDiscoveryWrites(results);
  if (writes.length) sheet.applyOps(writes);

  if (results.length) {
    out.say('');
    out.say('Check the sample titles against the company you meant — a slug can');
    out.say('belong to a different company with the same name.');
  }

  return {
    outcome: 'ok',
    summary: `${results.length} of ${pending.length} resolved`,
    detail: out.text(),
  };
}
