#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Offline tests for notifications. No webhook, no network.
import { discordPayload, slackPayload, telegramPayload, emailPayload, partition, notify, sheetLink, MAX_LISTED } from './notify.js';
import { readFileSync } from 'node:fs';
import { planSync, buildRecord } from './sync.js';
import { TABS, headers } from './sheet/schema.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

// Shaped like the rows the first live run produced.
const record = (over = {}) => ({
  key: 'clickup:1', score: 72, company: 'ClickUp', title: 'Principal Frontend Engineer',
  salary: '$250k–300k', location: 'United States (Remote)', age: '2d',
  url: 'https://jobs.ashbyhq.com/clickup/1', ...over,
});

// --- ranking ---------------------------------------------------------------
console.log('--- what gets listed ---');
{
  const records = [record({ score: 40, key: 'a' }), record({ score: 90, key: 'b' }), record({ score: 65, key: 'c' })];
  const { listed } = partition(records);
  check('highest score first', listed.map((r) => r.score).join(',') === '90,65,40');
  check('nothing is dropped when it fits', listed.length === 3);
}
{
  const many = Array.from({ length: 25 }, (_, i) => record({ key: String(i), score: i }));
  const { listed, overflow } = partition(many);
  check('a long run is capped', listed.length === MAX_LISTED);
  check('and the rest are counted', overflow === 25 - MAX_LISTED);
  check('the ones kept are the best ones', listed[0].score === 24);
}

// --- discord ---------------------------------------------------------------
console.log('\n--- discord ---');
{
  const { content } = discordPayload([record()], 'https://docs.google.com/x');
  check('says how many', content.startsWith('**1 new posting**'), content.split('\n')[0]);
  check('names the company', content.includes('ClickUp'));
  check('links the title', content.includes('](<https://jobs.ashbyhq.com/clickup/1>)'));
  check('shows the score', content.includes('72'));
  check('shows pay and location', content.includes('$250k–300k') && content.includes('United States (Remote)'));
  check('links the sheet', content.includes('Open the sheet'));
  check('pluralises correctly',
    discordPayload([record(), record({ key: 'b' })]).content.startsWith('**2 new postings**'));
}
{
  const stale = discordPayload([record({ age: '95d — stale' })]).content;
  check('a stale posting is flagged', stale.includes('stale'));
  const fresh = discordPayload([record({ age: '2d' })]).content;
  check('a fresh one is not cluttered with its age', !fresh.includes('2d'));
}
{
  // Discord rejects the whole POST past 2000 characters, so the message must
  // shed postings rather than be lost.
  const many = Array.from({ length: 40 }, (_, i) =>
    record({ key: String(i), title: 'A Very Long Job Title That Goes On And On For Quite Some Way Indeed', score: i }));
  const { content } = discordPayload(many, 'https://docs.google.com/x');
  check('stays under the limit', content.length <= 1900, `${content.length} chars`);
  check('the headline survives', content.startsWith('**40 new postings**'));
  check('and the sheet link survives', content.includes('Open the sheet'));
}
{
  const { allowed_mentions } = discordPayload([record()]);
  check('no @everyone can be triggered by a job title',
    JSON.stringify(allowed_mentions.parse) === '[]');
}

// --- slack -----------------------------------------------------------------
console.log('\n--- slack ---');
{
  const { text } = slackPayload([record()], 'https://docs.google.com/x');
  check('uses slack link syntax', text.includes('<https://jobs.ashbyhq.com/clickup/1|'));
  check('names the company', text.includes('ClickUp'));
  check('links the sheet', text.includes('|Open the sheet'));
}

// --- missing fields --------------------------------------------------------
console.log('\n--- postings missing things ---');
{
  const bare = { key: 'x', company: 'Somewhere', title: 'A Role' };
  const { content } = discordPayload([bare]);
  check('no url means no link, not a broken one', !content.includes(']()') && content.includes('A Role'));
  check('no salary is simply absent', !content.includes('undefined'), content);
  check('no score is not shown as zero', !/`\s*0`/.test(content), content);
  check('slack survives it too', slackPayload([bare]).text.includes('A Role'));
}

// --- sending ---------------------------------------------------------------
console.log('\n--- sending ---');
{
  const sent = [];
  const fetchImpl = async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, text: async () => '' };
  };
  const result = await notify([record()], {
    env: { DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x', SHEET_ID: 'abc' },
    fetchImpl,
  });
  check('posts to the webhook', sent.length === 1 && sent[0].url.includes('discord.com'));
  check('reports what it sent', result.sent.join(',') === 'discord');
  check('builds a sheet link from the id', sent[0].body.content.includes('spreadsheets/d/abc'));
}
{
  const result = await notify([], { env: { DISCORD_WEBHOOK_URL: 'https://x' }, fetchImpl: notCalled });
  check('nothing new means nothing sent', result.sent.length === 0 && result.skipped === 'nothing new');
}
{
  const result = await notify([record()], { env: {}, fetchImpl: notCalled });
  check('no channel configured is not an error',
    result.sent.length === 0 && result.skipped === 'no channel configured', result.skipped);
}
{
  // A dead webhook must not cost the run that already wrote the sheet.
  let threw = null;
  let result = null;
  try {
    result = await notify([record()], {
      env: { DISCORD_WEBHOOK_URL: 'https://x' },
      fetchImpl: async () => { throw new Error('connection refused'); },
    });
  } catch (e) { threw = e.message; }
  check('a dead webhook does not throw', threw === null, threw || '');
  check('and is reported as unsent', result.sent.length === 0);
}
{
  const result = await notify([record()], {
    env: { DISCORD_WEBHOOK_URL: 'https://x' },
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => 'Unknown Webhook' }),
  });
  check('a 404 from Discord is survivable', result.sent.length === 0);
}
{
  const posts = [];
  await notify([record()], {
    env: { DISCORD_WEBHOOK_URL: 'https://discord/x', SLACK_WEBHOOK_URL: 'https://slack/x' },
    fetchImpl: async (url) => { posts.push(url); return { ok: true, status: 200, text: async () => '' }; },
  });
  check('both channels fire when both are set', posts.length === 2);
}
function notCalled() { throw new Error('no request should have been made'); }

// --- the link --------------------------------------------------------------
console.log('\n--- sheet link ---');
check('an explicit url wins', sheetLink({ SHEET_URL: 'https://custom', SHEET_ID: 'abc' }) === 'https://custom');
check('an id builds one', sheetLink({ SHEET_ID: 'abc' }).endsWith('/abc/edit'));
// The Apps Script path needs no SHEET_ID, so this is the normal case there.
check('neither means no link, not a broken one', sheetLink({}) === null);
{
  const { content } = discordPayload([record()], null);
  check('and the digest simply omits it', !content.includes('Open the sheet'));
}

// --- only what is new ------------------------------------------------------
console.log('\n--- only genuinely new postings ---');
{
  const HEAD = headers(TABS.matches);
  const settings = { closeAfterDays: 7, stalePostingDays: 60 };
  const now = new Date('2026-08-29T09:00:00Z');
  const company = { name: 'ClickUp', slug: 'clickup' };
  const job = (id, title) => ({ id, title, location: 'Remote', url: `https://x/${id}`, postedAt: '2026-08-28', body: '' });

  const first = planSync([HEAD],
    [buildRecord({ job: job('1', 'Staff Frontend Engineer'), company, settings }, now)],
    { settings, now });
  check('a first run announces the new row', first.addedRecords.length === 1);

  // The same posting, seen again next day, plus one genuinely new.
  const rows = [HEAD, TABS.matches.columns.map((c) =>
    (c.key === 'key' ? 'clickup:1' : c.key === 'lastSeen' ? '2026-08-28' : ''))];
  const second = planSync(rows, [
    buildRecord({ job: job('1', 'Staff Frontend Engineer'), company, settings }, now),
    buildRecord({ job: job('2', 'Principal Frontend Engineer'), company, settings }, now),
  ], { settings, now });

  check('the second run announces only the new one', second.addedRecords.length === 1,
    second.addedRecords.map((r) => r.key).join(','));
  check('and it is the right one', second.addedRecords[0].key === 'clickup:2');
  check('the re-seen row is updated, not announced', second.updated === 1);
  check('so the digest holds one posting',
    discordPayload(second.addedRecords).content.startsWith('**1 new posting**'));
}

// --- telegram --------------------------------------------------------------
console.log('\n--- telegram ---');
{
  const p = telegramPayload([record()], 'https://docs.google.com/x', '12345');
  check('addressed to the chat', p.chat_id === '12345');
  check('sent as HTML', p.parse_mode === 'HTML');
  check('names the company', p.text.includes('<b>ClickUp</b>'));
  check('links the posting', p.text.includes('<a href="https://jobs.ashbyhq.com/clickup/1">'));
  check('no link previews cluttering the chat', p.disable_web_page_preview === true);
}
{
  // A title containing markup must not break the send. MarkdownV2 would need
  // fifteen characters escaped and a stray bracket fails the whole message —
  // which is why this uses HTML.
  const p = telegramPayload([record({ title: 'Engineer <script> & "Ops"' })], null, '1');
  check('markup in a title is escaped', p.text.includes('&lt;script&gt;') && p.text.includes('&amp;'));
  check('and no raw tag survives', !/<script>/.test(p.text));
}
{
  const many = Array.from({ length: 60 }, (_, i) => record({ key: String(i), score: i }));
  check('a long digest stays inside Telegram\'s limit',
    telegramPayload(many, 'https://x', '1').text.length <= 4000);
}

// --- email -----------------------------------------------------------------
console.log('\n--- email ---');
{
  const p = emailPayload([record(), record({ key: 'b' })], 'https://docs.google.com/x', 'me@example.com');
  check('addressed', p.to === 'me@example.com');
  check('the subject says how many', p.subject === '2 new postings', p.subject);
  check('the body lists the posting', p.html.includes('Principal Frontend Engineer'));
  check('and links it', p.html.includes('href="https://jobs.ashbyhq.com/clickup/1"'));
  check('and links the sheet', p.html.includes('Open the sheet'));
}
{
  const p = emailPayload([record({ company: 'A & B <Inc>' })], null, 'me@example.com');
  check('markup in a company name is escaped', p.html.includes('A &amp; B &lt;Inc&gt;'));
  check('no raw tag survives', !p.html.includes('<Inc>'));
}

// --- dispatch across four channels -----------------------------------------
console.log('\n--- every channel ---');
{
  const posts = [];
  const fetchImpl = async (url, opts) => {
    posts.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, status: 200, text: async () => '' };
  };
  const result = await notify([record()], {
    env: {
      DISCORD_WEBHOOK_URL: 'https://discord/x',
      SLACK_WEBHOOK_URL: 'https://slack/x',
      TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_CHAT_ID: '999',
      EMAIL_TO: 'me@example.com',
      APPS_SCRIPT_URL: 'https://script.google.com/macros/s/A/exec',
      APPS_SCRIPT_TOKEN: 'sekrit',
      SHEET_URL: 'https://sheet',
    },
    fetchImpl,
  });
  check('all four fire', result.sent.join(',') === 'discord,slack,telegram,email', result.sent.join(','));
  check('telegram goes to the bot endpoint',
    posts.find((p) => p.url.includes('api.telegram.org/botbot-token/sendMessage')) !== undefined);
  check('email rides the Apps Script already talking to the sheet',
    posts.find((p) => p.body.action === 'email')?.url.includes('script.google.com') === true);
  check('and carries the same token as every other Apps Script call',
    posts.find((p) => p.body.action === 'email').body.token === 'sekrit');
}
{
  // Half-configured is a mistake worth naming rather than silently skipping.
  const r = await notify([record()], { env: { TELEGRAM_BOT_TOKEN: 'x' }, fetchImpl: notCalled });
  check('a bot token with no chat id says which half is missing',
    r.skipped === 'missing TELEGRAM_CHAT_ID', r.skipped);
  const e = await notify([record()], { env: { EMAIL_TO: 'me@x.com' }, fetchImpl: notCalled });
  check('email without the Apps Script says so', /APPS_SCRIPT_URL/.test(e.skipped), e.skipped);
}
{
  // One dead channel must not stop the others.
  const r = await notify([record()], {
    env: { DISCORD_WEBHOOK_URL: 'https://dead', SLACK_WEBHOOK_URL: 'https://live' },
    fetchImpl: async (url) => (String(url).includes('dead')
      ? { ok: false, status: 500, text: async () => 'nope' }
      : { ok: true, status: 200, text: async () => '' }),
  });
  check('a failing channel does not stop the rest', r.sent.join(',') === 'slack', r.sent.join(','));
}
{
  // There is no web app to send through here: the script inside the
  // spreadsheet sends the mail itself, as the person who owns the sheet.
  const gs = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
  check('the built script sends mail itself', gs.includes('MailApp.sendEmail'));
  check('and can post to Discord', /discord/i.test(gs));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
