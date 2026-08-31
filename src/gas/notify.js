// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// Telling you about it.
//
// A digest can go to your inbox or to a Discord channel. Both were reachable
// before this file existed, by typing a script property into a settings screen
// nobody opens — which is the same as not existing. There is a menu item now,
// and one prompt that takes either.
//
// Which channel it is comes from the shape of what you type. Nobody should
// have to answer "email or Discord?" when the thing they pasted already says.
// ---------------------------------------------------------------------------
import { emailPayload, discordPayload } from '../notify.js';
import { scriptProperties, readProperty } from './props.js';

const EMAIL_KEY = 'EMAIL_TO';
const DISCORD_KEY = 'DISCORD_WEBHOOK_URL';

/** What somebody typed into the notifications prompt. */
export function parseDestination(text) {
  const value = String(text ?? '').trim();
  if (!value) return { kind: 'off', value: '' };
  if (/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//i.test(value)) {
    return { kind: 'discord', value };
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { kind: 'email', value };
  if (/^https?:\/\//i.test(value)) {
    return { kind: null, value, problem: 'That is a link, but not a Discord webhook URL.' };
  }
  return { kind: null, value, problem: `"${value}" is not an email address or a Discord webhook URL.` };
}

/** Where digests currently go, for the prompt to show. */
export function currentDestination() {
  const email = readProperty(EMAIL_KEY, '');
  if (email) return { kind: 'email', value: email };
  const discord = readProperty(DISCORD_KEY, '');
  if (discord) return { kind: 'discord', value: discord };
  return { kind: 'off', value: '' };
}

/** One destination at a time: setting one clears the other. */
export function setDestination(destination) {
  const store = scriptProperties();
  store.deleteProperty(EMAIL_KEY);
  store.deleteProperty(DISCORD_KEY);
  if (destination.kind === 'email') store.setProperty(EMAIL_KEY, destination.value);
  if (destination.kind === 'discord') store.setProperty(DISCORD_KEY, destination.value);
  return destination;
}

/**
 * Sends the digest wherever it is meant to go.
 *
 * Email goes through the account that owns this spreadsheet, so there is no
 * API key and nobody in between. Discord takes a webhook, which is a URL
 * anybody can create from a channel's settings in about thirty seconds.
 *
 * Never fails a run. A digest that could not be sent is a smaller loss than
 * the morning's postings.
 */
export function sendDigest(records = [], { spreadsheetUrl = '', fetchImpl = null } = {}) {
  if (!records.length) return { sent: false, reason: 'nothing new' };

  const to = currentDestination();
  if (to.kind === 'off') return { sent: false, reason: 'no destination set' };

  try {
    if (to.kind === 'email') {
      const payload = emailPayload(records, spreadsheetUrl, to.value);
      globalThis.MailApp.sendEmail({
        to: payload.to,
        subject: payload.subject,
        htmlBody: payload.html,
        name: 'job watch',
      });
      return { sent: true, kind: 'email', to: to.value };
    }

    const post = fetchImpl || ((url, options) => globalThis.UrlFetchApp.fetch(url, options));
    const res = post(to.value, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(discordPayload(records, spreadsheetUrl)),
      muteHttpExceptions: true,
    });
    const status = typeof res?.getResponseCode === 'function' ? res.getResponseCode() : 200;
    if (status >= 300) return { sent: false, reason: `Discord answered HTTP ${status}` };
    return { sent: true, kind: 'discord', to: 'Discord' };
  } catch (err) {
    return { sent: false, reason: String(err && err.message || err) };
  }
}
