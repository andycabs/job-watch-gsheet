// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// One company's postings, sorted into kept, filtered out, and unusable.
//
// Lifted out of the watch loop because it is the only part of a run that is a
// decision rather than plumbing, and because two runtimes need it: the command
// line fetches with Node and writes over HTTP, the spreadsheet fetches with
// UrlFetchApp and writes to itself, and neither difference reaches this far.
//
// Pure and synchronous — given postings and a configuration it returns the
// same answer anywhere, which is what makes the two runtimes worth trusting.
// ---------------------------------------------------------------------------
import { matchJob } from './match.js';
import { evaluateSalary, formatSalary } from './salary.js';
import { scoreJob, ageInDays } from './score.js';
import { buildRecord } from './sync.js';

export function triage(jobs, company, { rules, settings }, now = new Date()) {
  const matches = [];
  const dropped = [];
  const skipped = [];

  const drop = (job, reason, salary) => dropped.push({
    company: company.name,
    title: job.title,
    salary: formatSalary(salary),
    location: job.location,
    reason,
    url: job.url,
  });

  for (const job of jobs) {
    // Every row is keyed on the posting's id. Without one, two postings from
    // the same company collapse into a single row that overwrites itself —
    // so they are counted and skipped rather than silently merged.
    if (!job || job.id === undefined || job.id === null || String(job.id).trim() === ''
        || String(job.id) === 'undefined') {
      skipped.push(job?.title || '(untitled)');
      continue;
    }

    const verdict = matchJob(job, rules);

    if (!verdict.matched) {
      // The dropped tab exists to answer "are my filters too tight", so every
      // posting a filter cost belongs in it — not just the ones the salary
      // floor caught. A posting that matched a rule and was then rejected for
      // its location is precisely the case the tab is for, and it used to be
      // discarded here without trace.
      //
      // A posting no rule matched is not "dropped": nothing filtered it out,
      // it simply wasn't wanted. Those are `npm run suggest`'s business.
      if (verdict.stage === 'location' || (verdict.stage === 'excluded' && verdict.signals.length)) {
        drop(job, verdict.reason);
      }
      continue;
    }

    const { verdict: pay, salary, reason } = evaluateSalary(job, settings);
    const unpricedDrop = pay === 'unknown' && settings.unpriced === 'drop';

    if (pay === 'below' || unpricedDrop) {
      drop(job, unpricedDrop
        ? 'no salary stated, and unpriced postings are set to drop'
        : reason, salary);
      continue;
    }

    // Age last, so a posting dropped for being old still had to clear every
    // other filter — the dropped tab then says "stale", not "stale, and also
    // underpaid, and also in the wrong country".
    //
    // Off by default. A long-open req is often a pipeline posting rather than
    // a real opening, but not always: small teams leave good roles up for
    // months, and silently hiding them would be the tool deciding something it
    // has no business deciding.
    const days = ageInDays(job.postedAt, now);
    const staleAfter = Number(settings.stalePostingDays) || 0;
    if (settings.stale === 'drop' && staleAfter > 0 && days !== null && days >= staleAfter) {
      drop(job, `posted ${days} days ago, and postings over ${staleAfter} days are set to drop`, salary);
      continue;
    }

    const score = scoreJob({ job, verdict, salary, settings }, now);
    matches.push(buildRecord({ job, company, salary, verdict, score, settings }, now));
  }

  return { matches, dropped, skipped };
}
