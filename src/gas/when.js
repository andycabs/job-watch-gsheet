// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// When the run happens.
//
// Its own file because two callers need it and they already point at each
// other: the menu schedules, the check reports, and the menu imports the
// check. The bundler refuses an import cycle rather than guessing an order,
// which is how this ended up here rather than in either of them.
// ---------------------------------------------------------------------------
import { readProperty } from './props.js';

export const HOUR_KEY = 'WATCH_HOUR';

/**
 * The timezone a scheduled run actually fires in.
 *
 * Not the spreadsheet's. A time-driven trigger goes by the *script project's*
 * timezone — the `timeZone` in appsscript.json — and the two are separate
 * settings that a copied sheet carries over from whoever made the template.
 * Someone in Berlin copying a sheet built in New York gets both set to New
 * York, and a prompt that asked in the spreadsheet's timezone would have
 * promised 8am and delivered 2pm.
 *
 * Named rather than computed. Converting between the two zones looks like the
 * obliging thing to do and is a trap: they observe daylight saving on
 * different dates, so an offset worked out in January is wrong for three weeks
 * in March. One timezone that is right beats two that agree twice a year.
 */
export function scheduleTimeZone(session = globalThis.Session) {
  try {
    const tz = session && session.getScriptTimeZone();
    return tz ? String(tz) : null;
  } catch {
    return null;
  }
}

/** The spreadsheet's own, which governs how dates display but not the trigger. */
export function sheetTimeZone(app = globalThis.SpreadsheetApp) {
  try {
    return String(app.getActive().getSpreadsheetTimeZone());
  } catch {
    return null;
  }
}

/** Where to go when the answer is "not that one". */
export const TZ_FIX = 'Extensions → Apps Script → ⚙ Project Settings → Time zone';

/** The hour currently set, or null. */
export function scheduledHour() {
  const raw = readProperty(HOUR_KEY, null);
  return raw === null ? null : Number(raw);
}
