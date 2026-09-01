#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// The daily run happens on the spreadsheet's clock.
//
// A trigger fires in the script project's timezone, which nobody sets and a
// copied sheet inherits from whoever built the template. So the trigger wakes
// up hourly and these decide. What is worth testing is not the happy hour but
// the days either side of a clock change, and a wake-up Google fired late.
// ---------------------------------------------------------------------------
import { nextRunAt, alreadyRanToday, localHour, localStamp, watchTimeZone } from './gas/when.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
};

// Node's own formatter, standing in for Utilities.formatDate. Same timezone
// database underneath, which is the whole reason this approach works: the
// answer to "what hour is it in Berlin" is looked up, never calculated.
const utils = {
  parseDate(text, tz) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(text));
    const want = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    let guess = want;
    for (let i = 0; i < 3; i++) {
      const p = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).formatToParts(new Date(guess)).reduce((o, x) => (o[x.type] = x.value, o), {});
      const seen = Date.UTC(+p.year, +p.month - 1, +p.day,
        p.hour === '24' ? 0 : +p.hour, +p.minute, +p.second);
      if (seen === want) break;
      guess += want - seen;
    }
    return new Date(guess);
  },
  formatDate(date, tz, pattern) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hour12: false,
    }).formatToParts(date).reduce((o, p) => (o[p.type] = p.value, o), {});
    const hour = parts.hour === '24' ? '00' : parts.hour;
    return pattern === 'yyyy-MM-dd'
      ? `${parts.year}-${parts.month}-${parts.day}`
      : String(Number(hour));
  },
};

const at = (iso) => new Date(iso);

console.log('--- the hour is the spreadsheet\'s, not the server\'s ---');
{
  // 13:00 UTC is a different hour in each of these, which is the point.
  check('New York', localHour(at('2026-06-01T13:00:00Z'), 'America/New_York', utils) === 9);
  check('Berlin', localHour(at('2026-06-01T13:00:00Z'), 'Europe/Berlin', utils) === 15);
  check('Kolkata, a half-hour zone', localHour(at('2026-06-01T13:00:00Z'), 'Asia/Kolkata', utils) === 18);
  check('Auckland, a day ahead', localStamp(at('2026-06-01T13:00:00Z'), 'Pacific/Auckland', utils) === '2026-06-02');
}

console.log('\n--- the next run is an instant, not an hour ---');
{
  const next = (iso, tz, hour) => nextRunAt(at(iso), tz, hour, utils);

  // 8am in Berlin on a summer day is 06:00 UTC. The trigger is armed for that
  // moment, so what the script project believes its own timezone to be never
  // enters into it.
  check('8am Berlin, armed for the right instant',
    next('2026-06-01T03:00:00Z', 'Europe/Berlin', 8).toISOString() === '2026-06-01T06:00:00.000Z');
  check('8am New York the same day is two hours later in real time',
    next('2026-06-01T03:00:00Z', 'America/New_York', 8).toISOString() === '2026-06-01T12:00:00.000Z');
  check('a half-hour zone lands on the half hour',
    next('2026-06-01T00:00:00Z', 'Asia/Kolkata', 8).toISOString() === '2026-06-01T02:30:00.000Z');

  check('once today\u2019s hour has gone, it arms tomorrow\u2019s',
    next('2026-06-01T09:00:00Z', 'Europe/Berlin', 8).toISOString() === '2026-06-02T06:00:00.000Z');
  check('and exactly on the hour it arms tomorrow, not now',
    next('2026-06-01T06:00:00Z', 'Europe/Berlin', 8).toISOString() === '2026-06-02T06:00:00.000Z');
  check('a run always lands in the future',
    next('2026-06-01T23:59:00Z', 'Pacific/Auckland', 8).getTime() > at('2026-06-01T23:59:00Z').getTime());
}

console.log('\n--- the two mornings a year the offset moves ---');
{
  const next = (iso, tz, hour) => nextRunAt(at(iso), tz, hour, utils);

  // New York goes forward on 2026-03-08. 8am is 13:00 UTC the day before and
  // 12:00 UTC after: an hour that a fixed offset gets wrong for three weeks,
  // because Europe does not move until the 29th.
  check('the day before the clocks change',
    next('2026-03-07T00:00:00Z', 'America/New_York', 8).toISOString() === '2026-03-07T13:00:00.000Z');
  check('the day they do',
    next('2026-03-08T00:00:00Z', 'America/New_York', 8).toISOString() === '2026-03-08T12:00:00.000Z');
  check('and back again in November',
    next('2026-11-01T00:00:00Z', 'America/New_York', 8).toISOString() === '2026-11-01T13:00:00.000Z');

  // 02:00 does not exist in New York on 2026-03-08. Asking for it must still
  // produce a real moment on that date rather than throwing or skipping a day.
  const ghost = next('2026-03-08T00:00:00Z', 'America/New_York', 2);
  check('an hour that never happens still arms a real moment',
    ghost.getTime() > at('2026-03-08T00:00:00Z').getTime());
  check('and lands on the same local day',
    localStamp(ghost, 'America/New_York', utils) === '2026-03-08', localStamp(ghost, 'America/New_York', utils));

  // Berlin and New York are 6 hours apart most of the year and 5 in late
  // March. Any schedule built on a stored offset is an hour out for that spell.
  const march = next('2026-03-20T00:00:00Z', 'Europe/Berlin', 8).toISOString();
  const april = next('2026-04-20T00:00:00Z', 'Europe/Berlin', 8).toISOString();
  check('Berlin 8am is 07:00 UTC in late March', march === '2026-03-20T07:00:00.000Z', march);
  check('and 06:00 UTC in April', april === '2026-04-20T06:00:00.000Z', april);
}

console.log('\n--- one run per local day ---');
{
  const base = { tz: 'America/New_York', utils };
  check('no stamp is not a run', alreadyRanToday({ ...base, now: at('2026-06-01T12:00:00Z'), stamp: '' }) === false);
  check('today\u2019s stamp is', alreadyRanToday({ ...base, now: at('2026-06-01T12:00:00Z'), stamp: '2026-06-01' }) === true);
  check('yesterday\u2019s is not', alreadyRanToday({ ...base, now: at('2026-06-02T12:00:00Z'), stamp: '2026-06-01' }) === false);
  check('an unreadable zone does not block the run',
    alreadyRanToday({ tz: 'Not/AZone', now: at('2026-06-01T12:00:00Z'), stamp: '2026-06-01', utils }) === false);
  // Late evening in New York is already tomorrow in UTC. A stamp taken in the
  // wrong zone would skip or double a run every night.
  check('the day is the spreadsheet\u2019s, not UTC\u2019s',
    alreadyRanToday({ ...base, now: at('2026-06-02T02:00:00Z'), stamp: '2026-06-01' }) === true);
}

console.log('\n--- a timezone that cannot be used says so ---');
{
  // Spreadsheet timezones come from Google's own picker, so this is the
  // unreadable-sheet case rather than a typo. Arming must fail loudly rather
  // than silently pick a zone nobody chose.
  let threw = false;
  try { nextRunAt(at('2026-06-01T12:00:00Z'), 'Not/AZone', 8, utils); } catch { threw = true; }
  check('an unusable zone cannot be armed against', threw);

  check('a readable sheet zone is used', watchTimeZone({ sheetTz: 'Europe/Berlin', utils }).ok === true);
  check('a nonsense sheet zone is flagged', watchTimeZone({ sheetTz: 'Not/AZone', utils }).ok === false);
  check('an unreadable sheet falls back to the script zone',
    watchTimeZone({ sheetTz: null, scriptTz: 'America/New_York', utils }).tz === 'America/New_York');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
