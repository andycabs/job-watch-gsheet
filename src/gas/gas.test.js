#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Tests for the spreadsheet build.
//
// These run the *built* file, not the sources. A build step transforms the
// program — flattens its scopes, removes its async — and every one of those is
// a chance for it to become a different program that the original's tests
// still pass. So the artefact is what gets exercised here.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { installFakes } from './fake.js';
import { TABS, headers, seedRow } from '../sheet/schema.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
};

const root = fileURLToPath(new URL('../../', import.meta.url));
const built = path.join(root, 'build', 'Code.mjs');

// Build fresh, so a stale artefact can never be what passed.
execFileSync('node', [path.join(root, 'src/gas/build.js'), '--module'], { cwd: root });
check('the build produces a file', existsSync(built));

const source = readFileSync(path.join(root, 'build', 'Code.gs'), 'utf8');

console.log('\n--- the committed file is the built one ---');
{
  // Code.gs is what people paste into a spreadsheet. A committed artefact
  // that has drifted from its sources is worse than none: everything here
  // passes against the sources while the file being handed out is last week's.
  const shipped = existsSync(path.join(root, 'Code.gs'))
    ? readFileSync(path.join(root, 'Code.gs'), 'utf8') : '';
  check('Code.gs exists', Boolean(shipped));
  check('and matches a fresh build', shipped === source,
    'run `npm run build` and commit the result');
}
console.log('\n--- what the built file is ---');
// Prose mentions async; code must not contain it. Strip comments first, or
// the assertion is about the commentary rather than the program.
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

check('no modules survive', !/^\s*(import|export)\s/m.test(code));
check('no async function or method survives',
  !/\basync\s+(function|[A-Za-z_$][\w$]*\s*\()/.test(code),
  'the adapters are async methods — the shorthand form the transform first missed');
check('no await survives', !/\bawait\b/.test(code));
{
  // A reference guarded by `typeof process` is fine anywhere. A bare one is a
  // crash waiting for whichever line reaches it first.
  const unguarded = code.split('\n')
    .filter((l) => /\bprocess\./.test(l) && !/typeof process/.test(l));
  check('no unguarded process use survives', unguarded.length === 0,
    unguarded.join(' / ') || 'a spreadsheet has no process to exit');
}
check('nothing requires Node', !/require\(|from '?node:/.test(code));
check('AbortController is reached for only where it exists',
  !/new AbortController/.test(code) || /typeof AbortController/.test(code));

const G = await import(`file://${built}?t=${Date.now()}`);

// --- a sheet with everything a watch needs ---------------------------------
const grid = (tab, rows) => [headers(tab), ...rows.map((r) => seedRow(tab, r))];
const tabs = {
  rules: grid(TABS.rules, [{ active: 'TRUE', kind: 'title', pattern: 'engineer', note: '' }]),
  companies: grid(TABS.companies, [
    { active: 'TRUE', name: 'Acme', category: '', note: '', ats: 'greenhouse', slug: 'acme', resolved: '' },
  ]),
  matches: [headers(TABS.matches)],
  dropped: [headers(TABS.dropped)],
  directory: [headers(TABS.directory)],
  log: [headers(TABS.log)],
  settings: grid(TABS.settings, TABS.settings.seed),
};

const posting = {
  id: 991, title: 'Staff Engineer', absolute_url: 'https://example.com/991',
  updated_at: '2026-08-28T00:00:00Z',
  location: { name: 'Remote — United States' },
  content: 'The base salary range is $180,000 - $220,000 per year.',
};

let fetched = 0;
const fake = installFakes({
  tabs,
  fetch: (url) => {
    fetched++;
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ jobs: [posting] }),
    };
  },
});

console.log('\n--- a watch, end to end, in a fake spreadsheet ---');
try {
  const result = G.runWatch({ now: new Date('2026-08-30T12:00:00Z') });

  check('it fetched the board', fetched === 1, `${fetched} requests`);
  check('it matched the posting', result.matched === 1, JSON.stringify(result.summary));
  check('and reported success', result.outcome === 'ok', result.outcome);

  const matches = fake.spreadsheet.grid('matches');
  check('a row reached the sheet', matches.length === 2, `${matches.length} rows`);

  const head = matches[0];
  const row = matches[1];
  const at = (name) => row[head.indexOf(name)];
  check('with the company', at('Company') === 'Acme', at('Company'));
  check('and the title', at('Title') === 'Staff Engineer', at('Title'));
  check('and the salary it parsed out of the description',
    /180k/.test(at('Salary')) && /220k/.test(at('Salary')), at('Salary'));
  check('and the numbers behind it', Number(at('Salary min')) === 180000
    && Number(at('Salary max')) === 220000, `${at('Salary min')}–${at('Salary max')}`);
  check('and a score', Number(at('Score')) > 0, at('Score'));
  check('and Status left for a person to fill in', at('Status') === 'Not reviewed', at('Status'));

  check('it was polite between boards', fake.slept.length === 0,
    'one company means nothing to wait between');
} finally {
  fake.restore();
}

// --- the second run is the one that finds bugs ------------------------------
console.log('\n--- running twice does not duplicate ---');
{
  const again = installFakes({
    tabs,
    fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ jobs: [posting] }) }),
  });
  try {
    G.runWatch({ now: new Date('2026-08-30T12:00:00Z') });
    G.runWatch({ now: new Date('2026-08-31T12:00:00Z') });
    const matches = again.spreadsheet.grid('matches');
    check('still one row', matches.length === 2, `${matches.length} rows`);
  } finally {
    again.restore();
  }
}

// --- refusing to run rather than reporting nothing --------------------------
console.log('\n--- it refuses instead of reporting an empty morning ---');
{
  const noRules = installFakes({ tabs: { ...tabs, rules: [headers(TABS.rules)] } });
  try {
    const r = G.runWatch({});
    check('no rules is a failure, not zero matches', r.outcome === 'failed', r.outcome);
    check('and says why', /no rules/.test(r.summary), r.summary);
  } finally {
    noRules.restore();
  }
}

// --- one bad board does not cost the run ------------------------------------
console.log('\n--- an unreachable board ---');
{
  const broken = installFakes({
    tabs,
    fetch: () => { throw new Error('connection refused'); },
  });
  try {
    const r = G.runWatch({ now: new Date('2026-08-30T12:00:00Z') });
    check('the run finishes', typeof r.outcome === 'string');
    check('and the failure is in the transcript', /connection refused/.test(r.detail), r.detail.slice(0, 80));
  } finally {
    broken.restore();
  }
}

console.log('\n--- a blank spreadsheet, taken all the way ---');
{
  // The journey a new person makes: an empty sheet, one menu click, a tick,
  // and a matched job. Every step here reaches a real planner; only the
  // spreadsheet and the boards are fakes.
  const catalogue = readFileSync(path.join(root, 'data', 'directory.json'), 'utf8');
  const env = installFakes({
    tabs: {},
    fetch: (url) => ({
      getResponseCode: () => 200,
      getContentText: () => (String(url).includes('directory.json')
        ? catalogue
        : JSON.stringify({ jobs: [posting] })),
    }),
  });
  try {
    check('the templates travel inside the build',
      G.templateNames().length === 4, G.templateNames().join(', '));

    G.runFirstRun('software-engineering', {});
    const grid = (n) => env.spreadsheet.grid(n);

    check('it built the workbook',
      env.spreadsheet.getSheets().length === 7,
      env.spreadsheet.getSheets().map((s) => s.getName()).join(', '));
    check('and loaded the starter rules', grid('rules').length > 10, `${grid('rules').length - 1} rules`);
    check('and filled the catalogue', grid('directory').length === 353, `${grid('directory').length - 1}`);
    check('but watches nothing yet', grid('companies').length === 2,
      'a first run cannot know who somebody wants to watch');

    // A first run that ends on "No companies with a resolved board yet" reads
    // like a failure, and it is the last thing somebody sees after setting the
    // whole thing up successfully.
    const first = G.runFirstRun('none', { client: undefined });
    check('a first run with nothing ticked still succeeds', first.outcome === 'ok', first.outcome);
    check('and ends by saying what to do next',
      /tick Add/.test(first.detail) && !/No companies with a resolved board/.test(first.detail),
      first.detail.split('\n').slice(-4).join(' ').trim());

    // Tick a company, the way a person does.
    grid('directory')[1][0] = 'TRUE';
    const added = G.runDirectory({});
    check('ticking a row starts a watch on it', /1 added to the watch/.test(added.summary), added.summary);

    const watched = G.runWatch({});
    check('and the watch then finds something', watched.outcome === 'ok' && watched.matched === 1,
      watched.summary);
    check('which lands in the sheet', grid('matches').length === 2);
  } finally {
    env.restore();
  }
}

console.log('\n--- when the catalogue cannot be reached ---');
{
  // What the first real run hit: the script fetched the list from a repository
  // that is private and answers 404, and the directory tab came back empty. A
  // tool that calls itself self-contained has to carry its own companies.
  const env = installFakes({
    tabs: {},
    fetch: () => { throw new Error('network is unreachable'); },
  });
  try {
    G.runSetup({});
    const r = G.runDirectory({});
    check('the catalogue still arrives with no network at all', r.outcome === 'ok', r.outcome);
    check('all of it', env.spreadsheet.grid('directory').length === 353,
      `${env.spreadsheet.grid('directory').length - 1} companies`);
    // Where it lands matters as much as whether it lands. The first real run
    // put all 352 below row 1000, in a tab that looked empty.
    check('starting at row 2', /starting at row 2/.test(r.detail),
      r.detail.split('\n').slice(-1)[0]);
    check('and it says which copy it used', /came with this script/.test(r.detail),
      r.detail.split('\n')[1]);
  } finally {
    env.restore();
  }
}
{
  // A refresh that works is an improvement on the built-in list, not a
  // precondition for it.
  const fresher = JSON.stringify({
    name: 'x',
    entries: [{ name: 'Newco', description: 'd', category: 'saas', ats: 'greenhouse', slug: 'newco' }],
  });
  const env = installFakes({
    tabs: {},
    fetch: () => ({ getResponseCode: () => 200, getContentText: () => fresher }),
  });
  try {
    G.runSetup({});
    const r = G.runDirectory({});
    check('a reachable upstream list is preferred', /refreshed/.test(r.detail), r.detail.split('\n')[0]);
    check('and replaces what shipped', r.summary.includes('1 in the catalogue'), r.summary);
  } finally {
    env.restore();
  }
}
{
  // An upstream that answers with nothing must not empty the tab.
  const env = installFakes({
    tabs: {},
    fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ entries: [] }) }),
  });
  try {
    G.runSetup({});
    G.runDirectory({});
    check('an empty answer upstream does not wipe the catalogue',
      env.spreadsheet.grid('directory').length === 353,
      `${env.spreadsheet.grid('directory').length - 1} companies`);
  } finally {
    env.restore();
  }
}

console.log('\n--- a template that is not there ---');
{
  const env = installFakes({ tabs });
  try {
    const r = G.runTemplate('astrology', {});
    check('is refused by name', r.outcome === 'failed' && /astrology/.test(r.summary), r.summary);
    check('and the alternatives are listed', /software-engineering/.test(r.detail), r.detail);
  } finally {
    env.restore();
  }
}

console.log('\n--- loading a template twice ---');
{
  const env = installFakes({ tabs: {} });
  try {
    G.runSetup({});
    const first = G.runTemplate('data', {});
    const second = G.runTemplate('data', {});
    check('adds nothing the second time', /^0 rule/.test(second.summary),
      `${first.summary} then ${second.summary}`);
    check('and says they were already there', /already there/.test(second.detail), second.detail);
  } finally {
    env.restore();
  }
}

console.log('\n--- the example row ---');
{
  const env = installFakes({ tabs: {}, fetch: () => { throw new Error('no'); } });
  try {
    G.runSetup({});
    const rows = env.spreadsheet.grid('companies');
    const head = rows[0];
    const example = rows[1];
    check('setup seeds an example company', /Example Co/.test(example[head.indexOf('Name')]),
      example[head.indexOf('Name')]);
    check('but leaves it switched off',
      String(example[head.indexOf('Active')]).toUpperCase() === 'FALSE',
      'an active example with no board costs 36 requests on every discovery run');

    const found = G.runDiscover({});
    check('so discovery has nothing to chase', /nothing to discover/.test(found.summary),
      found.summary);
  } finally {
    env.restore();
  }
}

console.log('\n--- the four questions ---');
{
  const env = installFakes({
    tabs,
    fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ jobs: [posting] }) }),
  });
  try {
    const checked = G.runCheck({});
    check('check reads the configuration back', /Rules/.test(checked.detail) && /Settings/.test(checked.detail));
    check('and reports the rule it found', /engineer/.test(checked.detail));
    check('and the settings that filter', /stale postings/.test(checked.detail), checked.detail.split('\n').find((l) => /stale/.test(l)));
    check('and writes nothing', env.spreadsheet.grid('matches').length === 1);

    const suggested = G.runSuggest({});
    check('suggest counts what no rule matched', /matched no rule/.test(suggested.detail), suggested.summary);
    check('and reports coverage', /Coverage/.test(suggested.detail));

    const learned = G.runLearn({});
    check('learn refuses below the minimum rather than inventing a pattern',
      /at least/.test(learned.detail), learned.summary);
    check('and says how many more are needed', /more kept and/.test(learned.detail));
  } finally {
    env.restore();
  }
}

console.log('\n--- learn, once there is enough to go on ---');
{
  // Six kept and six passed, split cleanly on one word.
  const rows = [headers(TABS.matches)];
  const at = (name) => headers(TABS.matches).indexOf(name);
  const row = (status, title, company) => {
    const r = new Array(headers(TABS.matches).length).fill('');
    r[at('Status')] = status;
    r[at('Title')] = title;
    r[at('Company')] = company;
    return r;
  };
  for (let i = 0; i < 6; i++) rows.push(row('Interested', `Staff Platform Engineer ${i}`, 'Acme'));
  for (let i = 0; i < 6; i++) rows.push(row('Passed', `Engineering Manager ${i}`, 'Globex'));

  const env = installFakes({ tabs: { ...tabs, matches: rows } });
  try {
    const learned = G.runLearn({});
    check('it now says something', /From 6 kept and 6 passed/.test(learned.detail), learned.summary);
    check('and separates the two piles', /manager/i.test(learned.detail), learned.detail.slice(0, 200));
  } finally {
    env.restore();
  }
}

console.log('\n--- discover ---');
{
  const pending = [
    headers(TABS.companies),
    seedRow(TABS.companies, { active: 'TRUE', name: 'Acme', category: '', note: '', ats: '', slug: '', verified: '' }),
  ];
  let asked = [];
  const env = installFakes({
    tabs: { ...tabs, companies: pending },
    fetch: (url) => {
      asked.push(String(url));
      const hit = String(url).includes('greenhouse') && String(url).includes('acme');
      return {
        getResponseCode: () => (hit ? 200 : 404),
        getContentText: () => (hit ? JSON.stringify({ jobs: [posting] }) : 'not found'),
      };
    },
  });
  try {
    const found = G.runDiscover({});
    check('it probes for a board', asked.length > 0, `${asked.length} requests`);
    check('and finds the one that answers', /greenhouse\/acme/.test(found.detail), found.summary);
    check('and shows a sample title to check by eye', /Staff Engineer/.test(found.detail),
      'a slug can belong to a different company with the same name');

    const written = env.spreadsheet.grid('companies')[1];
    check('and writes the board back to the row',
      written[headers(TABS.companies).indexOf('ATS')] === 'greenhouse'
      && written[headers(TABS.companies).indexOf('Slug')] === 'acme',
      written.join('|'));
  } finally {
    env.restore();
  }
}

console.log('\n--- the daily run, with nobody watching ---');
{
  // The question this answers: does a scheduled run work with no browser
  // open, no GitHub, and nothing outside the spreadsheet? The trigger is
  // owned by this script, so firing its handler is the whole mechanism.
  const env = installFakes({
    tabs,
    fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ jobs: [posting] }) }),
  });
  try {
    check('nothing is scheduled to begin with', G.scheduledHour() === null);

    const set = G.schedule(7);
    check('scheduling creates one trigger', env.triggers.length === 1, `${env.triggers.length}`);
    // A moment, not an hour. The hour a trigger fires at belongs to the script
    // project, which nobody sets and every copy inherits from the template it
    // came from; an instant belongs to nobody and cannot be misread.
    check('the trigger is armed for an instant, not an hour',
      env.triggers[0].at instanceof Date && env.triggers[0].hour === null);
    check('and that instant is in the future', env.triggers[0].at.getTime() > Date.now());
    check('pointed at the handler Google will call',
      env.triggers[0].getHandlerFunction() === 'scheduledWatch');
    check('and the hour is remembered', G.scheduledHour() === 7);
    check('nothing was replaced the first time', set.replaced === 0);

    // Scheduling twice is the mistake that costs two emails every morning,
    // and nothing in the sheet would show it.
    const again = G.schedule(9);
    check('scheduling again replaces rather than adds', env.triggers.length === 1, `${env.triggers.length}`);
    check('and says so', again.replaced === 1);
    check('at the new hour', G.scheduledHour() === 9);

    // A chain of single-shots stops if an execution never happens. Opening the
    // sheet is where that gets noticed and put right.
    const armed = env.triggers[0];
    G.unschedule();
    check('the trigger can go missing while the schedule remains',
      env.triggers.length === 0 && G.scheduledHour() === 9);
    const fixed = G.repairSchedule();
    check('opening the sheet puts it back', fixed.repaired === true);
    check('exactly one, not two', env.triggers.length === 1, `${env.triggers.length}`);
    check('and a repair is a no-op when one is already armed',
      G.repairSchedule().repaired === false && env.triggers.length === 1);
    check('the replacement is armed for the same schedule', armed.at instanceof Date);

    // A copy made before the schedule became a single-shot is carrying a daily
    // trigger pinned to an hour on the script project's clock. Pasting new code
    // over old must not leave somebody to notice that themselves.
    G.unschedule();
    globalThis.ScriptApp.newTrigger('scheduledWatch').timeBased().atHour(8).everyDays(1).create();
    globalThis.PropertiesService.getScriptProperties().setProperty('WATCH_HOUR', '8');
    globalThis.PropertiesService.getScriptProperties().deleteProperty('WATCH_LAST_RUN');
    G.scheduledWatch();
    check('an old daily trigger converts itself on its next fire',
      env.triggers.length === 1 && env.triggers[0].days === null, `${env.triggers.length}`);
    check('into one armed for a moment', env.triggers[0].at instanceof Date);

    // Fire it the way Google would: by calling the named handler.
    G.schedule(9);
    globalThis.PropertiesService.getScriptProperties().deleteProperty('WATCH_LAST_RUN');
    const result = G.scheduledWatch();
    check('the run happens', result.ran === true);
    check('and tomorrow is armed before the work, not after',
      env.triggers.length === 1 && env.triggers[0].at.getTime() > Date.now());
    check('the scheduled run works with no browser involved', result.outcome === 'ok', result.outcome);
    check('and writes its results', env.spreadsheet.grid('matches').length === 2);

    const log = env.spreadsheet.grid('log');
    check('and leaves a row in the log', log.length >= 2, `${log.length} rows`);
    check('saying it was the scheduled one', /watch \(scheduled\)/.test(String(log[1])), String(log[1][1]));

    // Having run, the rest of the day's wake-ups are silent.
    const again2 = G.scheduledWatch();
    check('it does not run twice in one day', again2.ran === false, again2.reason);
    check('and says it already ran', /already ran/.test(again2.reason), again2.reason);

    check('stopping it removes the trigger', G.unschedule() === 1 && env.triggers.length === 0);
  } finally {
    env.restore();
  }
}

console.log('\n--- the hour someone types ---');
for (const [input, hour] of [['7', 7], [' 23 ', 23], ['0', 0]]) {
  check(`"${input}" is ${hour}`, G.parseHour(input).hour === hour);
}
for (const bad of ['24', '-1', 'nine', '', '7pm', '7.5']) {
  const { hour, problem } = G.parseHour(bad);
  check(`"${bad}" is refused with a reason`, hour === null && Boolean(problem), problem);
}

console.log('\n--- where a digest goes ---');
{
  const env = installFakes({ tabs });
  try {
    check('nothing is set to begin with', G.currentDestination().kind === 'off');

    for (const [text, kind] of [
      ['me@example.com', 'email'],
      ['  me@example.com  ', 'email'],
      ['https://discord.com/api/webhooks/123/abc', 'discord'],
      ['https://discordapp.com/api/webhooks/123/abc', 'discord'],
      ['', 'off'],
      ['   ', 'off'],
    ]) {
      check(`"${text.trim() || '(empty)'}" is ${kind}`, G.parseDestination(text).kind === kind);
    }
    for (const bad of ['not an address', 'https://example.com/hook', 'me@', '@example.com']) {
      const parsed = G.parseDestination(bad);
      check(`"${bad}" is refused with a reason`, parsed.kind === null && Boolean(parsed.problem),
        parsed.problem);
    }

    G.setDestination({ kind: 'email', value: 'me@example.com' });
    check('an email destination sticks', G.currentDestination().value === 'me@example.com');

    // One destination at a time, or a change of mind quietly leaves the old
    // one running alongside the new one.
    G.setDestination({ kind: 'discord', value: 'https://discord.com/api/webhooks/1/x' });
    check('setting a second one replaces the first',
      G.currentDestination().kind === 'discord' && env.property('EMAIL_TO') === null);

    G.setDestination({ kind: 'off', value: '' });
    check('and it can be turned off', G.currentDestination().kind === 'off');
  } finally {
    env.restore();
  }
}

console.log('\n--- sending one ---');
{
  const records = [{ company: 'Acme', title: 'Staff Engineer', url: 'https://x/1', score: 88 }];
  const env = installFakes({ tabs });
  try {
    check('nothing is sent with no destination',
      G.sendDigest(records, {}).reason === 'no destination set');

    G.setDestination({ kind: 'email', value: 'me@example.com' });
    check('a quiet morning sends nothing', G.sendDigest([], {}).reason === 'nothing new',
      'a digest of nothing is noise');

    const sent = G.sendDigest(records, { spreadsheetUrl: 'https://sheet' });
    check('email goes out as you', sent.sent && sent.kind === 'email', JSON.stringify(sent));
    check('with the posting in it',
      env.mailed.length === 1 && /Staff Engineer/.test(env.mailed[0].htmlBody), `${env.mailed.length}`);

    const posted = [];
    G.setDestination({ kind: 'discord', value: 'https://discord.com/api/webhooks/1/x' });
    const r = G.sendDigest(records, {
      spreadsheetUrl: 'https://sheet',
      fetchImpl: (url, options) => { posted.push({ url, options }); return { getResponseCode: () => 204 }; },
    });
    check('Discord gets a POST', r.sent && posted.length === 1, JSON.stringify(r));
    check('with the posting in the body', /Staff Engineer/.test(posted[0].options.payload));

    const refused = G.sendDigest(records, {
      fetchImpl: () => ({ getResponseCode: () => 401 }),
    });
    check('and a rejection is reported, not swallowed',
      !refused.sent && /401/.test(refused.reason), refused.reason);
  } finally {
    env.restore();
  }
}

console.log('\n--- the menu Google will build ---');
{
  const env = installFakes({ tabs });
  try {
    const items = [];
    globalThis.SpreadsheetApp.getUi = () => ({
      createMenu: () => {
        const menu = {
          addItem: (label, fn) => { items.push([label, fn]); return menu; },
          addSeparator: () => menu,
          addToUi: () => {},
        };
        return menu;
      },
    });
    G.onOpen();
    check('the menu has items', items.length >= 3, `${items.length}`);
    // Two items called "set up" something, one of which was the upgrade path,
    // was a question somebody had to ask before they could use the tool.
    const labels = items.map(([label]) => label);
    check('only one item is about setting up',
      labels.filter((l) => /^Set|set everything/i.test(l)).length <= 1, labels.join(' | '));
    check('and digests are reachable from the menu',
      labels.some((l) => /digest/i.test(l)), labels.join(' | '));
    check('every item points at a function that exists',
      items.every(([, fn]) => typeof G[fn] === 'function'),
      items.map(([, fn]) => fn).join(', '));
  } finally {
    env.restore();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
