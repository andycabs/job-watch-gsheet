// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// The menu, and the clock.
//
// Everything a person can start, and the one thing that starts itself. These
// are the only functions Google calls by name, so they have to end up at the
// top level of the built file — which is what the bundler's stripping of
// `export` leaves behind.
//
// The daily run is a time-driven trigger owned by this script. It fires
// whether or not the spreadsheet is open, in the spreadsheet's own timezone,
// so it follows daylight saving and the hour someone picks stays the hour they
// get. Nothing outside the sheet is involved: no cron, no repository, nothing
// that switches itself off after sixty days of quiet.
// ---------------------------------------------------------------------------
import { runWatch, runSetup, runDirectory, runFirstRun, templateNames, recordRun } from './run.js';
import { runCheck, runSuggest, runLearn, runDiscover } from './diagnose.js';
import { parseDestination, currentDestination, setDestination } from './notify.js';
import { scriptProperties } from './props.js';
import {
  HOUR_KEY, LAST_RUN_KEY, TZ_FIX, watchTimeZone, scheduledHour,
  lastRunStamp, dueNow, localHour, localStamp,
} from './when.js';
import { sheetClient } from './sheet.js';

const MENU = 'Job watch';
const TRIGGER = 'scheduledWatch';

const ui = () => globalThis.SpreadsheetApp.getUi();
const scriptApp = () => globalThis.ScriptApp;

export function onOpen() {
  ui().createMenu(MENU)
    .addItem('Start here — set everything up', 'menuFirstRun')
    .addSeparator()
    .addItem('Run the watch now', 'menuWatch')
    .addItem('Find boards for new companies', 'menuDiscover')
    .addItem('Refresh the company catalogue', 'menuDirectory')
    .addSeparator()
    .addItem('Check my configuration', 'menuCheck')
    .addItem('What am I missing?', 'menuSuggest')
    .addItem('What have I been passing on?', 'menuLearn')
    .addSeparator()
    .addItem('Schedule the daily run…', 'menuSchedule')
    .addItem('Stop the daily run', 'menuUnschedule')
    .addItem('Send me a digest…', 'menuNotifications')
    .addSeparator()
    .addItem('Add anything missing (after an update)', 'menuSetup')
    .addToUi();
}

/** Hour a person typed, or null with the reason it is not one. */
export function parseHour(text) {
  const trimmed = String(text ?? '').trim();
  if (!/^\d{1,2}$/.test(trimmed)) return { hour: null, problem: `"${trimmed}" is not a number` };
  const hour = Number(trimmed);
  if (hour < 0 || hour > 23) return { hour: null, problem: `${hour} is not an hour between 0 and 23` };
  return { hour, problem: null };
}

/**
 * Replaces any existing daily run rather than adding a second one.
 *
 * Scheduling twice is the mistake that costs two emails every morning, and it
 * is invisible: nothing in the sheet shows how many triggers exist.
 */
export function schedule(hour, app = scriptApp(), deps = {}) {
  const removed = unschedule(app);
  // Hourly, not daily-at-an-hour: the hour a trigger fires at is the script
  // project's, and the hour a person means is their spreadsheet's. This wakes
  // up often enough that the second one can decide. See when.js.
  app.newTrigger(TRIGGER).timeBased().everyHours(1).create();

  const store = scriptProperties();
  store.setProperty(HOUR_KEY, String(hour));

  // If the hour has already gone today, start tomorrow. Otherwise leave the
  // stamp clear so the first run is the one they are expecting, today.
  const { tz, ok } = deps.zone || watchTimeZone();
  let startsToday = true;
  store.deleteProperty(LAST_RUN_KEY);
  if (ok) {
    try {
      const now = deps.now || new Date();
      if (localHour(now, tz) >= Number(hour)) {
        store.setProperty(LAST_RUN_KEY, localStamp(now, tz));
        startsToday = false;
      }
    } catch { /* leave it clear — a missed first day beats a missed schedule */ }
  }
  return { hour, replaced: removed, tz, startsToday };
}

export function unschedule(app = scriptApp()) {
  let removed = 0;
  for (const trigger of app.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === TRIGGER) { app.deleteTrigger(trigger); removed++; }
  }
  return removed;
}

// --- what the menu items do -------------------------------------------------

export function menuFirstRun() {
  const answer = ui().prompt('Set everything up',
    `Which starter rules?\n\n  ${templateNames().join('\n  ')}\n  none\n\n`
    + 'You can edit or delete every rule afterwards, and load a second set later.',
    ui().ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui().Button.OK) return;

  const choice = String(answer.getResponseText()).trim().toLowerCase() || 'none';
  if (choice !== 'none' && !templateNames().includes(choice)) {
    ui().alert('Not one of the options', templateNames().concat('none').join('\n'), ui().ButtonSet.OK);
    return;
  }

  const client = sheetClient();
  const result = recordRun(client, 'first run', () => runFirstRun(choice, { client }));
  ui().alert('Setup finished', `${result.summary}\n\nThe full output is in the log tab.`, ui().ButtonSet.OK);
}

export function menuWatch() {
  const client = sheetClient();
  const result = recordRun(client, 'watch', () => runWatch({ client }));
  ui().alert('Watch finished', `${result.summary}\n\nThe full output is in the log tab.`, ui().ButtonSet.OK);
}

export function menuSetup() {
  const client = sheetClient();
  const result = recordRun(client, 'setup', () => runSetup({ client }));
  ui().alert('Setup', `${result.summary}\n\nThe full output is in the log tab.`, ui().ButtonSet.OK);
}

export function menuDirectory() {
  const client = sheetClient();
  const result = recordRun(client, 'directory', () => runDirectory({ client }));
  ui().alert('Catalogue', `${result.summary}\n\nThe full output is in the log tab.`, ui().ButtonSet.OK);
}

/**
 * Every diagnostic is the same shape: run it, log it, and point at the log.
 *
 * The alert can only carry a sentence — the answer itself is often thirty
 * lines — so the summary goes in the dialog and the whole transcript goes
 * where it can be read and kept.
 */
function diagnostic(what, fn, title) {
  return () => {
    const client = sheetClient();
    const result = recordRun(client, what, () => fn({ client }));
    ui().alert(title, `${result.summary}\n\nThe full answer is in the log tab — `
      + 'click the Detail cell to read it in the formula bar.', ui().ButtonSet.OK);
  };
}

export const menuCheck = diagnostic('check', runCheck, 'Your configuration');
export const menuSuggest = diagnostic('suggest', runSuggest, 'What you are missing');
export const menuLearn = diagnostic('learn', runLearn, 'What you have been passing on');
export const menuDiscover = diagnostic('discover', runDiscover, 'Finding boards');

/**
 * One prompt for both channels.
 *
 * Asking "email or Discord?" first is a question the answer already contains:
 * a webhook URL looks nothing like an email address. So take either, work out
 * which it is, and say plainly where things will go from now on.
 */
export function menuNotifications() {
  const now = currentDestination();
  const where = now.kind === 'off' ? 'Nothing is being sent at the moment.'
    : now.kind === 'email' ? `Digests currently go to ${now.value}.`
      : 'Digests currently go to a Discord channel.';

  const answer = ui().prompt('Send me a digest',
    `${where}\n\n`
    + 'Paste an email address, or a Discord webhook URL.\n'
    + 'Leave it empty to stop sending anything.\n\n'
    + 'A digest goes out after a run that found something new. Nothing is sent '
    + 'on a quiet morning.',
    ui().ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui().Button.OK) return;

  const parsed = parseDestination(answer.getResponseText());
  if (parsed.problem) {
    ui().alert('Not a destination', parsed.problem, ui().ButtonSet.OK);
    return;
  }

  setDestination(parsed);
  ui().alert('Digests',
    parsed.kind === 'off' ? 'Nothing will be sent from now on.'
      : parsed.kind === 'email'
        ? `New matches will be emailed to ${parsed.value} after a run that finds something.`
        : 'New matches will be posted to that Discord channel after a run that finds something.',
    ui().ButtonSet.OK);
}

export function menuSchedule() {
  const zone = watchTimeZone();
  const answer = ui().prompt('Daily run',
    `What hour should the watch run? (0-23)\n\n`
    + `Times are ${zone.tz}, this spreadsheet\u2019s timezone.\n`
    + `To change it: ${TZ_FIX}\n\n`
    + 'It fires within the hour you pick rather than on the minute.',
    ui().ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui().Button.OK) return;

  const { hour, problem } = parseHour(answer.getResponseText());
  if (problem) { ui().alert('Not an hour', problem, ui().ButtonSet.OK); return; }

  const set = schedule(hour, scriptApp(), { zone });
  const when = set.startsToday
    ? `starting today`
    : `starting tomorrow — ${hour}:00 has already gone there`;
  ui().alert('Scheduled',
    `The watch will run daily around ${hour}:00 ${set.tz}, ${when}.\n\n`
    + 'It runs whether or not this spreadsheet is open, and fires within that '
    + 'hour rather than on the minute.',
    ui().ButtonSet.OK);
}

export function menuUnschedule() {
  const removed = unschedule();
  scriptProperties().deleteProperty(HOUR_KEY);
  ui().alert(removed ? 'The daily run is off. Nothing runs on its own now.'
    : 'There was no daily run scheduled here.');
}

/**
 * What the trigger calls.
 *
 * No dialogs: nobody is watching. A failure has to leave its evidence in the
 * log tab, which is the only place a person will look tomorrow morning.
 */
export function scheduledWatch() {
  // Twenty-three of these a day do nothing. Deciding costs two comparisons and
  // is deliberately ahead of opening the sheet: a wake-up that is not due
  // should not read a spreadsheet or touch a job board.
  const { tz } = watchTimeZone();
  const verdict = dueNow({
    now: new Date(), tz, hour: scheduledHour(), stamp: lastRunStamp(),
  });
  if (!verdict.due) return { ran: false, reason: verdict.reason };

  // Stamped before the run, not after. A run that dies halfway has still had
  // its turn today, and retrying it every hour until midnight would be worse
  // than waiting for tomorrow.
  scriptProperties().setProperty(LAST_RUN_KEY, verdict.today);

  const client = sheetClient();
  const result = recordRun(client, 'watch (scheduled)', () => runWatch({ client }));
  return { ran: true, at: verdict.reason, ...result };
}
