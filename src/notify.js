// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// Telling you about it.
//
//   DISCORD_WEBHOOK_URL   — https://discord.com/api/webhooks/...
//   SLACK_WEBHOOK_URL     — https://hooks.slack.com/services/...
//   TELEGRAM_BOT_TOKEN    — from @BotFather, with TELEGRAM_CHAT_ID
//   EMAIL_TO              — sent through the Apps Script already bound to the
//                           sheet, so there is no mail service to sign up for
//                           and nobody else holding your job data
//   SHEET_URL             — optional link back to the spreadsheet
//
// Any, all, or none. Unset means that channel is skipped silently: a
// tool that refuses to run because nobody configured a webhook is a tool that
// has confused its output with its purpose. The sheet is the record; this is a
// convenience.
//
// Only genuinely new postings are announced. A digest that re-lists everything
// still open gets muted within a week, at which point the notification is worse
// than none — it trains you to ignore it.
//
// Nothing here throws. A dead webhook must not cost you the run that already
// fetched every board and wrote your sheet.
// ---------------------------------------------------------------------------

// A digest people actually read is short. Beyond this, a count.
export const MAX_LISTED = 10;

// Discord hard-caps message content at 2000 characters and rejects the entire
// POST past it, so the budget is enforced here rather than discovered there.
const DISCORD_LIMIT = 1900;

const escapeHtml = (s) => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const trim = (s, n) => {
  const text = String(s || '').trim();
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
};

const byScore = (a, b) => (Number(b.score) || 0) - (Number(a.score) || 0);

/**
 * What to list and what to summarise.
 * Highest-scoring first — the ranking is the whole point of scoring, and a
 * digest that ignores it is just the sheet in a worse format.
 */
export function partition(records, max = MAX_LISTED) {
  const ranked = [...records].sort(byScore);
  const listed = ranked.slice(0, max);
  return { ranked, listed, overflow: Math.max(0, ranked.length - listed.length) };
}

const headline = (n) => `${n} new posting${n === 1 ? '' : 's'}`;

/** " · $250k–300k · 2d — stale" — the details worth having before you click. */
function detail(record, join = ' · ') {
  return [
    record.location,
    record.salary,
    record.payRank,
    record.changed || null,
    /stale/.test(record.age || '') ? record.age : null,
  ].filter(Boolean).join(join);
}

export function discordPayload(records, sheetUrl) {
  const { listed, overflow, ranked } = partition(records);
  const lines = [`**${headline(ranked.length)}**`];

  for (const r of listed) {
    const score = Number(r.score) ? `\`${String(r.score).padStart(3)}\` ` : '';
    const title = r.url
      ? `[${trim(r.title, 70)}](<${r.url}>)`
      : trim(r.title, 70);
    lines.push(`${score}**${trim(r.company, 28)}** ${title}`);
    const rest = detail(r);
    if (rest) lines.push(`      ${rest}`);
  }

  if (overflow > 0) lines.push(`_+${overflow} more in the sheet_`);
  if (sheetUrl) lines.push(`[Open the sheet →](<${sheetUrl}>)`);

  // Drop listed postings from the end until it fits, keeping the headline and
  // the closing link. Losing the tail beats losing the message.
  let content = lines.join('\n');
  while (content.length > DISCORD_LIMIT && lines.length > 2) {
    lines.splice(-2, 1);
    content = lines.join('\n');
  }

  return { content, allowed_mentions: { parse: [] } };
}

export function slackPayload(records, sheetUrl) {
  const { listed, overflow, ranked } = partition(records);
  const lines = [`*${headline(ranked.length)}*`];

  for (const r of listed) {
    const score = Number(r.score) ? `\`${String(r.score).padStart(3)}\` ` : '';
    const title = r.url ? `<${r.url}|${trim(r.title, 70)}>` : trim(r.title, 70);
    const rest = detail(r);
    lines.push(`${score}*${trim(r.company, 28)}* ${title}${rest ? ` — ${rest}` : ''}`);
  }

  if (overflow > 0) lines.push(`_+${overflow} more in the sheet_`);
  if (sheetUrl) lines.push(`<${sheetUrl}|Open the sheet →>`);
  return { text: lines.join('\n') };
}

/**
 * Telegram. HTML rather than MarkdownV2: the latter requires escaping fifteen
 * characters, and a job title containing a bracket would otherwise fail the
 * whole send with a parse error.
 */
export function telegramPayload(records, sheetUrl, chatId) {
  const { listed, overflow, ranked } = partition(records);
  const lines = [`<b>${headline(ranked.length)}</b>`, ''];

  for (const r of listed) {
    const score = Number(r.score) ? `<code>${String(r.score).padStart(3)}</code> ` : '';
    const title = escapeHtml(trim(r.title, 70));
    lines.push(`${score}<b>${escapeHtml(trim(r.company, 28))}</b>`);
    lines.push(r.url ? `<a href="${escapeHtml(r.url)}">${title}</a>` : title);
    const rest = detail(r);
    if (rest) lines.push(escapeHtml(rest));
    lines.push('');
  }

  if (overflow > 0) lines.push(`<i>+${overflow} more in the sheet</i>`);
  if (sheetUrl) lines.push(`<a href="${escapeHtml(sheetUrl)}">Open the sheet →</a>`);

  return {
    chat_id: chatId,
    text: lines.join('\n').slice(0, 4000),   // Telegram caps a message at 4096
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
}

/**
 * Email, as a subject and an HTML body. Sent by the Apps Script bound to the
 * spreadsheet, which already runs as the sheet's owner — so there is no mail
 * service to sign up for, no API key, and no third party in the middle.
 * Consumer Gmail allows around 100 of these a day, which is far more than a
 * daily digest needs.
 */
export function emailPayload(records, sheetUrl, to) {
  const { listed, overflow, ranked } = partition(records);

  const rows = listed.map((r) => {
    const title = escapeHtml(trim(r.title, 90));
    const link = r.url ? `<a href="${escapeHtml(r.url)}" style="color:#1a56db;text-decoration:none">${title}</a>` : title;
    const rest = escapeHtml(detail(r, ' &middot; '));
    return `<tr>
      <td style="padding:10px 12px 10px 0;vertical-align:top;color:#6b7280;font-variant-numeric:tabular-nums">${Number(r.score) ? r.score : ''}</td>
      <td style="padding:10px 0">
        <div style="font-weight:600">${escapeHtml(trim(r.company, 40))}</div>
        <div>${link}</div>
        <div style="color:#6b7280;font-size:13px">${rest}</div>
      </td>
    </tr>`;
  }).join('');

  const body = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;color:#111827;max-width:640px">
    <p style="font-size:17px;font-weight:600;margin:0 0 4px">${headline(ranked.length)}</p>
    <table style="border-collapse:collapse;width:100%">${rows}</table>
    ${overflow > 0 ? `<p style="color:#6b7280">+${overflow} more in the sheet</p>` : ''}
    ${sheetUrl ? `<p><a href="${escapeHtml(sheetUrl)}" style="color:#1a56db">Open the sheet →</a></p>` : ''}
  </div>`;

  return { to, subject: `${headline(ranked.length)}`, html: body };
}

// There is no process inside Apps Script. These defaults are only evaluated
// when a caller omits the argument, so nothing was breaking — but a bare
// reference to something that does not exist is a trap left lying about, and
// the digest path over there passes its own values anyway.
const environment = () => (typeof process === 'undefined' ? {} : process.env);

/** The spreadsheet link, when there is enough to build one. */
export function sheetLink(env = environment()) {
  if (env.SHEET_URL) return env.SHEET_URL;
  if (env.SHEET_ID) return `https://docs.google.com/spreadsheets/d/${env.SHEET_ID}/edit`;
  return null;
}

async function post(url, payload, label, doFetch) {
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`${label} notification failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`${label} notification failed: ${err.message}`);
    return false;
  }
}

/**
 * Fires every configured channel. Never throws.
 * @returns {{ sent: string[], skipped: string, listed: number }}
 */
export async function notify(records = [], { env = environment(), fetchImpl = fetch, changed = [] } = {}) {
  // A posting whose salary went up on a live req is worth a ping even though
  // it is not new — arguably more so, since it is already known to be real.
  const all = [...records, ...changed.filter((c) => !records.some((r) => r.key === c.key))];
  if (!all.length) return { sent: [], skipped: 'nothing new', listed: 0 };
  records = all;

  const url = sheetLink(env);
  const jobs = [];

  if (env.DISCORD_WEBHOOK_URL) {
    jobs.push(['discord', env.DISCORD_WEBHOOK_URL, discordPayload(records, url)]);
  }
  if (env.SLACK_WEBHOOK_URL) {
    jobs.push(['slack', env.SLACK_WEBHOOK_URL, slackPayload(records, url)]);
  }
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    jobs.push([
      'telegram',
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      telegramPayload(records, url, env.TELEGRAM_CHAT_ID),
    ]);
  }
  // Email rides the Apps Script that is already talking to the sheet. It needs
  // no separate credential, which is the whole reason to do it this way.
  if (env.EMAIL_TO && env.APPS_SCRIPT_URL) {
    jobs.push([
      'email',
      env.APPS_SCRIPT_URL,
      { token: env.APPS_SCRIPT_TOKEN || '', action: 'email', ...emailPayload(records, url, env.EMAIL_TO) },
    ]);
  }

  if (!jobs.length) {
    const halfSet = [];
    if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_CHAT_ID) halfSet.push('TELEGRAM_CHAT_ID');
    if (env.TELEGRAM_CHAT_ID && !env.TELEGRAM_BOT_TOKEN) halfSet.push('TELEGRAM_BOT_TOKEN');
    if (env.EMAIL_TO && !env.APPS_SCRIPT_URL) halfSet.push('APPS_SCRIPT_URL (email is sent by the Apps Script)');
    return {
      sent: [],
      skipped: halfSet.length ? `missing ${halfSet.join(', ')}` : 'no channel configured',
      listed: 0,
    };
  }

  const sent = [];
  for (const [name, endpoint, payload] of jobs) {
    if (await post(endpoint, payload, name, fetchImpl)) sent.push(name);
  }
  return { sent, skipped: null, listed: partition(records).listed.length };
}
