// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// When the run happens.
//
// A time-driven trigger fires in the *script project's* timezone, which is a
// setting buried in Project Settings and copied from whoever built the
// template. Asking somebody to go and change it there — to make a daily run
// happen at the hour they asked for — is a setup step for a thing they have
// already told us, since the spreadsheet has a timezone of its own that they
// set in Sheets like any other document property.
//
// So the trigger is not the schedule. The trigger fires every hour and this
// decides whether it is time, by asking what hour it currently is in the
// spreadsheet's timezone. Twenty-three of those wake up, compare two numbers
// and stop.
//
// The reason to prefer it over converting between the two zones — the obvious
// fix — is daylight saving. Zones do not change on the same dates, so an
// offset worked out in January is wrong for three weeks in March. Asking
// Google what time it is *now*, in a named zone, is right every day of the
// year including the two that are weird.
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
 * Whether an hourly wake-up is the one that should do the work.
 *
 * "At or after the hour, once per local day" rather than "at the hour". Three
 * things fall out of that which the stricter rule gets wrong: the morning the
 * clocks go forward and the chosen hour does not exist, a trigger Google fired
 * late, and the hour that happens twice in the autumn — the last one caught by
 * the stamp rather than the comparison.
 */
export function dueNow({ now, tz, hour, stamp, utils } = {}) {
  if (hour === null || hour === undefined || Number.isNaN(Number(hour))) {
    return { due: false, reason: 'no daily run is scheduled' };
  }
  let today;
  let atHour;
  try {
    today = localStamp(now, tz, utils);
    atHour = localHour(now, tz, utils);
  } catch (err) {
    return { due: false, reason: `cannot read the time in ${tz}`, problem: true };
  }
  if (stamp && stamp === today) return { due: false, reason: `already ran on ${today}`, today };
  if (atHour < Number(hour)) {
    return { due: false, reason: `it is ${atHour}:00 in ${tz}, waiting for ${hour}:00`, today };
  }
  return { due: true, today, reason: `${atHour}:00 in ${tz}` };
}
