// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// When the run happens.
//
// A time-driven trigger fires on the *script project's* clock — a setting
// inside the Apps Script editor that nobody sets and every copy inherits from
// the sheet it was copied from. The hour a person means is their
// spreadsheet's, which they set in Sheets like any other document property.
//
// So the schedule is not "every day at 8". It is one single-shot trigger armed
// for an exact instant, worked out by asking Google when 8am next happens in
// the spreadsheet's timezone. An instant has no timezone to get wrong. When it
// fires it arms the next one, so the answer is recomputed daily and daylight
// saving is picked up the day it happens rather than approximated.
//
// The alternative — waking hourly and checking the clock — worked and cost
// twenty-four executions a day to deliver one, each of which opened the
// spreadsheet to ask what timezone it was in. One a day does the same job.
//
// What a chain of single-shots risks is stopping: if an execution never
// happens, nothing arms the next. Two things guard that. The next trigger is
// armed *before* the watch runs, so a failing run cannot break the chain; and
// opening the sheet repairs a schedule that has no trigger behind it.
//
// Its own file because two callers need it and they already point at each
// other: the menu schedules, the check reports, and the menu imports the
// check. The bundler refuses an import cycle rather than guessing an order.
// ---------------------------------------------------------------------------
import { readProperty } from './props.js';

export const HOUR_KEY = 'WATCH_HOUR';
export const LAST_RUN_KEY = 'WATCH_LAST_RUN';

/** Where somebody goes to change it — a Sheets menu, not the script editor. */
export const TZ_FIX = 'File → Settings → Time zone';

const utilities = () => globalThis.Utilities;

/**
 * A date rendered in a named zone.
 *
 * Google's own timezone database does the work, so a zone that has just moved
 * on or off daylight saving is handled by asking rather than by arithmetic.
 */
export function formatIn(now, tz, pattern, utils = utilities()) {
  return String(utils.formatDate(now, tz, pattern));
}

/** The spreadsheet's timezone — the one a person sets in Sheets. */
export function sheetTimeZone(app = globalThis.SpreadsheetApp) {
  try {
    const tz = app.getActive().getSpreadsheetTimeZone();
    return tz ? String(tz) : null;
  } catch {
    return null;
  }
}

/** The script project's, which is what the raw trigger goes by. Reported, not used. */
export function scriptTimeZone(session = globalThis.Session) {
  try {
    const tz = session && session.getScriptTimeZone();
    return tz ? String(tz) : null;
  } catch {
    return null;
  }
}

/**
 * The zone this schedules against, and whether it is one Google recognises.
 *
 * A spreadsheet always has a timezone, so the fallback is for the case where
 * the sheet cannot be read at all rather than for a person who has not chosen.
 */
export function watchTimeZone(deps = {}) {
  const tz = ('sheetTz' in deps ? deps.sheetTz : sheetTimeZone());
  const now = deps.now || new Date();
  if (tz) {
    try {
      formatIn(now, tz, 'H', deps.utils || utilities());
      return { tz, ok: true };
    } catch {
      return { tz, ok: false };
    }
  }
  return { tz: ('scriptTz' in deps ? deps.scriptTz : scriptTimeZone()), ok: false };
}

/** The hour currently set, or null. */
export function scheduledHour(read = readProperty) {
  const raw = read(HOUR_KEY, null);
  return raw === null ? null : Number(raw);
}

/** The local date a run last happened on, as the sheet's timezone saw it. */
export function lastRunStamp(read = readProperty) {
  return read(LAST_RUN_KEY, '') || '';
}

/** Today, where the spreadsheet lives. One run per one of these. */
export function localStamp(now, tz, utils) {
  return formatIn(now, tz, 'yyyy-MM-dd', utils);
}

export function localHour(now, tz, utils) {
  return Number(formatIn(now, tz, 'H', utils));
}

/**
 * The next instant at which it is `hour` o'clock in `tz`.
 *
 * Built by asking rather than by arithmetic: format "what day is it there",
 * then parse "that day at that hour, there" back into an instant. Google's own
 * timezone database answers both halves, so the two mornings a year when the
 * offset moves are handled by the same code as every other morning.
 *
 * Returns a Date, which is an absolute moment. A trigger armed for one does
 * not care what timezone the script project thinks it is in.
 */
export function nextRunAt(now, tz, hour, utils = utilities()) {
  const h = String(Number(hour)).padStart(2, '0');
  const on = (day) => utils.parseDate(`${day} ${h}:00:00`, tz, 'yyyy-MM-dd HH:mm:ss');

  let when = on(localStamp(now, tz, utils));
  if (when.getTime() > now.getTime()) return when;

  // Today's has gone. Tomorrow, named in the spreadsheet's own calendar — a
  // day there is 23 or 25 hours twice a year, so the date is asked for rather
  // than assumed.
  const nextDay = localStamp(new Date(now.getTime() + 24 * 60 * 60 * 1000), tz, utils);
  when = on(nextDay);
  // A clock that jumped forward can land the parsed time before `now` even on
  // the following day; step a day at a time until it is genuinely ahead.
  for (let i = 0; i < 3 && when.getTime() <= now.getTime(); i++) {
    when = on(localStamp(new Date(when.getTime() + 24 * 60 * 60 * 1000), tz, utils));
  }
  return when;
}

/**
 * Whether a run has already happened today, where the spreadsheet lives.
 *
 * A single-shot trigger fires once, so this is not what stops a double run in
 * the ordinary case — repairing a chain is. It costs one comparison and saves
 * a duplicate digest, which is the failure people notice.
 */
export function alreadyRanToday({ now, tz, stamp, utils } = {}) {
  if (!stamp) return false;
  try {
    return stamp === localStamp(now, tz, utils);
  } catch {
    return false;
  }
}
