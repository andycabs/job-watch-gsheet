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
import { dueNow, localHour, localStamp, watchTimeZone } from './gas/when.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
};

// Node's own formatter, standing in for Utilities.formatDate. Same timezone
// database underneath, which is the whole reason this approach works: the
// answer to "what hour is it in Berlin" is looked up, never calculated.
const utils = {
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

console.log('\n--- once a day, at or after the hour ---');
{
  const base = { tz: 'America/New_York', hour: 8, utils };
  check('before the hour, it waits',
    dueNow({ ...base, now: at('2026-06-01T11:00:00Z'), stamp: '' }).due === false);   // 07:00
  check('on the hour, it runs',
    dueNow({ ...base, now: at('2026-06-01T12:00:00Z'), stamp: '' }).due === true);    // 08:00
  check('having run today, it does not run again',
    dueNow({ ...base, now: at('2026-06-01T16:00:00Z'), stamp: '2026-06-01' }).due === false);
  check('the next day it runs again',
    dueNow({ ...base, now: at('2026-06-02T12:00:00Z'), stamp: '2026-06-01' }).due === true);
  check('and it says why it is waiting',
    /waiting for 8:00/.test(dueNow({ ...base, now: at('2026-06-01T11:00:00Z'), stamp: '' }).reason));

  // A trigger Google fired late, or a sheet that was not reachable at 8. The
  // strict "hour === 8" rule silently loses the day; this catches up.
  check('a wake-up missed at 8 still runs at 11',
    dueNow({ ...base, now: at('2026-06-01T15:00:00Z'), stamp: '' }).due === true);
  check('with no schedule set, nothing is due',
    dueNow({ ...base, hour: null, now: at('2026-06-01T12:00:00Z'), stamp: '' }).due === false);
}

console.log('\n--- the two days a year that break the obvious version ---');
{
  // US clocks go forward 2026-03-08: 02:00 does not exist in New York.
  // A rule that waits for the chosen hour exactly would skip the whole day.
  const spring = { tz: 'America/New_York', hour: 2, utils, stamp: '' };
  check('the hour that never happens does not lose the day',
    dueNow({ ...spring, now: at('2026-03-08T08:00:00Z') }).due === true);   // 03:00 EDT

  // Clocks go back 2026-11-01: 01:00 in New York happens twice.
  const autumn = { tz: 'America/New_York', hour: 1, utils };
  const first = dueNow({ ...autumn, now: at('2026-11-01T05:00:00Z'), stamp: '' });   // 01:00 EDT
  check('the hour that happens twice runs the first time', first.due === true);
  check('and not the second', dueNow({ ...autumn, now: at('2026-11-01T06:00:00Z'), stamp: first.today }).due === false);

  // Europe changes on different dates from the US. Any fix built on a fixed
  // offset between two zones is wrong for the weeks in between; asking what
  // time it is in a named zone is not.
  check('Berlin and New York disagree in late March',
    localHour(at('2026-03-20T12:00:00Z'), 'Europe/Berlin', utils)
      - localHour(at('2026-03-20T12:00:00Z'), 'America/New_York', utils) === 5);
  check('and agree again in April',
    localHour(at('2026-04-10T12:00:00Z'), 'Europe/Berlin', utils)
      - localHour(at('2026-04-10T12:00:00Z'), 'America/New_York', utils) === 6);
}

console.log('\n--- a timezone that cannot be used says so ---');
{
  const bad = dueNow({ tz: 'Not/AZone', hour: 8, now: at('2026-06-01T12:00:00Z'), stamp: '', utils });
  check('an unusable zone is not due', bad.due === false);
  check('and is reported as a problem, not as waiting', bad.problem === true);

  check('a readable sheet zone is used', watchTimeZone({ sheetTz: 'Europe/Berlin', utils }).ok === true);
  check('a nonsense sheet zone is flagged', watchTimeZone({ sheetTz: 'Not/AZone', utils }).ok === false);
  check('an unreadable sheet falls back to the script zone',
    watchTimeZone({ sheetTz: null, scriptTz: 'America/New_York', utils }).tz === 'America/New_York');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
