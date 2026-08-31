#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Tests for the remote-company catalogue.
//
// The property that matters most: a tick is the only thing in that tab a
// person owns, and it must survive every refresh, including one that rewrites
// every other cell on its row.
import { cleanDirectory, planDirectorySync, planEnable } from './directory-plan.js';
import { DIRECTORY } from './directory-data.js';
import { TABS, headers, resolveWriteRange, readRange } from './sheet/schema.js';
import { memoryClient } from './sheet/memory.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
};

const DIR = headers(TABS.directory);
const CO = headers(TABS.companies);
const row = (over = {}) => TABS.directory.columns.map((c) => String(over[c.key] ?? ''));

// --- the shipped data ------------------------------------------------------
console.log('--- the catalogue file ---');
{
  const { entries, unlisted, updated } = cleanDirectory(DIRECTORY);
  check('it has entries', entries.length > 50, String(entries.length));
  // The catalogue's promise is "tick this and it gets watched". A row that
  // cannot be watched breaks that promise every time someone reads the tab.
  check('every listed company names a board',
    entries.every((e) => e.ats && e.slug),
    entries.filter((e) => !e.ats || !e.slug).map((e) => e.name).join(', '));
  check('the ones that cannot be watched are kept, not deleted', unlisted.length > 0);
  check('and each says why', unlisted.every((e) => e.reason && e.reason.length > 3),
    unlisted.filter((e) => !e.reason).map((e) => e.name).join(', '));
  check('none of them is silently in both lists',
    !entries.some((e) => unlisted.some((u) => u.name === e.name)));
  // Three source notes nest parentheses — "no supported ATS found (Workday
  // (host), unsupported platform)" — and a lazy capture cut the reason
  // mid-word, leaving "custom domain (jobs.chargebee.com".
  const unbalanced = unlisted.filter((e) =>
    (e.reason.match(/\(/g) || []).length !== (e.reason.match(/\)/g) || []).length);
  check('no reason is truncated mid-parenthesis', unbalanced.length === 0,
    unbalanced.map((e) => `${e.name}: ${e.reason}`).join(' | '));
  check('it is dated', /^\d{4}-\d{2}-\d{2}$/.test(updated), updated);
  check('every entry has a name and a description',
    entries.every((e) => e.name && e.description));
  check('no entry claims a board without a slug',
    entries.every((e) => !e.ats || e.slug), entries.filter((e) => e.ats && !e.slug).map((e) => e.name).join(', '));
  check('names are unique',
    new Set(entries.map((e) => e.name.toLowerCase())).size === entries.length);
  check('descriptions are short enough to read in a cell',
    entries.every((e) => e.description.length <= 120),
    entries.filter((e) => e.description.length > 120).map((e) => e.name).join(', '));
  check('no personal flags leaked in from the source list',
    !JSON.stringify(entries).match(/"(excluded|disabled|verified)"/));
  // A description is a fact about the company. Whether its owner wants to
  // watch it is not, and this file is bound for a public catalogue — one
  // entry read "excluded by choice, not a board problem".
  const opinionated = [...entries, ...unlisted].filter((e) =>
    /\b(excluded|by choice|avoid|dislike|do not like|don't like)\b/i.test(e.description));
  check('no description carries somebody\'s judgement of a company',
    opinionated.length === 0, opinionated.map((e) => `${e.name}: ${e.description}`).join(' | '));
}

// --- a tick is sacred ------------------------------------------------------
console.log('\n--- refreshing without touching a tick ---');
{
  const existing = [DIR,
    row({ add: 'TRUE', name: 'GitLab', description: 'stale text', category: 'old', ats: '', slug: '' }),
    row({ add: '', name: 'Zapier', description: 'stale too', category: 'old' }),
  ];
  const entries = [
    { name: 'GitLab', description: 'All-remote, 65+ countries', category: 'devtools', ats: 'greenhouse', slug: 'gitlab' },
    { name: 'Zapier', description: 'Fully remote since 2011', category: 'automation', ats: 'lever', slug: 'zapier' },
    { name: 'Newcomer', description: 'Just added', category: 'saas', ats: '', slug: '' },
  ];
  const plan = planDirectorySync(existing, entries);
  check('the two stale rows are updated', plan.updated === 2, String(plan.updated));
  check('and the new one appended', plan.added === 1);
  check('no write starts at column A on an existing row',
    plan.operations.filter((o) => /!A\d/.test(o.range) && !/A4/.test(o.range)).length === 0,
    plan.operations.map((o) => o.range).join(' '));

  const sheet = memoryClient({ directory: existing });
  await sheet.applyOps(plan.operations);
  const grid = sheet._grid('directory');
  check('the tick survives a full rewrite of its row', grid[1][0] === 'TRUE', grid[1][0]);
  check('while the description updates', grid[1][2] === 'All-remote, 65+ countries');
  check('and the board is filled in', grid[1][4] === 'greenhouse' && grid[1][5] === 'gitlab');
  check('an unticked row stays unticked', grid[2][0] === '');
  check('the newcomer arrives unticked', grid[3][0] === '' && grid[3][1] === 'Newcomer');
}
{
  // Someone sorts the tab. Rows must be found by name, not by position.
  const sorted = [DIR,
    row({ add: '', name: 'Zapier', description: 'old' }),
    row({ add: 'TRUE', name: 'GitLab', description: 'old' }),
  ];
  const entries = [
    { name: 'GitLab', description: 'gitlab now', category: 'devtools' },
    { name: 'Zapier', description: 'zapier now', category: 'automation' },
  ];
  const sheet = memoryClient({ directory: sorted });
  await sheet.applyOps(planDirectorySync(sorted, entries).operations);
  const grid = sheet._grid('directory');
  check('a sorted tab updates the right rows',
    grid[1][1] === 'Zapier' && grid[1][2] === 'zapier now' &&
    grid[2][1] === 'GitLab' && grid[2][2] === 'gitlab now',
    grid.slice(1).map((r) => `${r[1]}=${r[2]}`).join(' '));
  check('and the tick stayed with its company', grid[2][0] === 'TRUE');
}
{
  const same = [DIR, row({ add: 'TRUE', name: 'GitLab', description: 'x', category: 'y', ats: 'greenhouse', slug: 'gitlab' })];
  const plan = planDirectorySync(same, [{ name: 'GitLab', description: 'x', category: 'y', ats: 'greenhouse', slug: 'gitlab' }]);
  check('a refresh that changes nothing writes nothing', plan.operations.length === 0);
}
{
  const plan = planDirectorySync([DIR.filter((h) => h !== 'Slug')], [{ name: 'A', description: 'b' }]);
  check('a deleted column stops the refresh', plan.operations.length === 0);
  check('and says which one', /no "Slug" column/.test(plan.problems[0]), plan.problems[0]);
}

// --- enabling --------------------------------------------------------------
console.log('\n--- enabling what is ticked ---');
{
  const directory = [DIR,
    row({ add: 'TRUE', name: 'GitLab', description: 'd', category: 'devtools', ats: 'greenhouse', slug: 'gitlab' }),
    row({ add: '', name: 'Zapier', description: 'd', category: 'automation', ats: 'lever', slug: 'zapier' }),
    row({ add: 'TRUE', name: 'Newcomer', description: 'd', category: 'saas' }),
  ];
  const plan = planEnable(directory, [CO]);

  check('only ticked rows are added', plan.added === 2, String(plan.added));
  check('and the unticked one is left', !plan.rows.some((r) => r[1] === 'Zapier'));
  check('a known board comes across', plan.rows[0][4] === 'greenhouse' && plan.rows[0][5] === 'gitlab');
  check('one without a board is left for discovery', plan.rows[1][4] === '' && plan.rows[1][5] === '');
  check('the category comes across', plan.rows[0][2] === 'devtools');
  check('and the row says where it came from', /from the directory/.test(plan.rows[0][3]));
  check('everything arrives active', plan.rows.every((r) => r[0] === 'TRUE'));
}
{
  // Ticking twice, or ticking something already watched, must not duplicate.
  const directory = [DIR,
    row({ add: 'TRUE', name: 'GitLab', ats: 'greenhouse', slug: 'gitlab' }),
    row({ add: 'TRUE', name: 'gitlab', ats: 'greenhouse', slug: 'gitlab' }),
  ];
  const companies = [CO, ['TRUE', 'GitLab', '', 'my own note', 'greenhouse', 'gitlab', '2026-08-01']];
  const plan = planEnable(directory, companies);
  check('a company already watched is not added again', plan.added === 0, String(plan.added));
  check('and is reported as already there', plan.already.includes('GitLab'));
  check('the same company ticked twice lands once',
    planEnable(directory, [CO]).added === 1);
}
{
  // The user edits a company that came from the directory. Nothing here may
  // reach back and change it.
  const directory = [DIR, row({ add: 'TRUE', name: 'GitLab', ats: 'greenhouse', slug: 'gitlab' })];
  const mine = ['FALSE', 'GitLab', 'my category', 'I turned this off', 'lever', 'my-slug', '2026-01-01'];
  const sheet = memoryClient({ directory, companies: [CO, mine] });
  await sheet.applyOps(planEnable(directory, sheet._grid('companies')).operations);
  check('an edited company keeps every edit',
    sheet._grid('companies')[1].join('|') === mine.join('|'), sheet._grid('companies')[1].join('|'));
}
{
  const truthy = ['TRUE', 'true', 'True', 'yes', 'Y', '1', 'x', 'X', ' TRUE '];
  const falsy = ['', 'FALSE', 'false', 'no', '0', 'maybe', 'n'];
  const enabled = truthy.map((v, i) => row({ add: v, name: `T${i}` }));
  const skipped = falsy.map((v, i) => row({ add: v, name: `F${i}` }));
  const plan = planEnable([DIR, ...enabled, ...skipped], [CO]);
  check('every reasonable way of saying yes counts', plan.added === truthy.length,
    `${plan.added} of ${truthy.length}`);
  check('and nothing else does', !plan.rows.some((r) => r[1].startsWith('F')));
}
{
  const plan = planEnable([DIR, row({ add: 'TRUE', name: 'X', ats: 'workday', slug: 'x' })], [CO]);
  check('an unsupported board is not carried across', plan.rows[0][4] === '');
  check('and is reported', /not supported/.test(plan.problems[0]), plan.problems[0]);
}
{
  const plan = planEnable([DIR, row({ add: 'TRUE', name: '   ' })], [CO]);
  check('a ticked row with no company name is skipped', plan.added === 0);
}

// --- a rearranged sheet ----------------------------------------------------
console.log('\n--- columns moved around ---');
{
  const reordered = ['Add', 'Company', 'Category', 'What they do', 'ATS', 'Slug'];
  const r = new Array(6).fill('');
  r[0] = 'TRUE'; r[1] = 'GitLab'; r[2] = 'devtools'; r[3] = 'desc'; r[4] = 'greenhouse'; r[5] = 'gitlab';
  const plan = planEnable([reordered, r], [CO]);
  check('a reordered directory still reads the right cells',
    plan.rows[0][1] === 'GitLab' && plan.rows[0][2] === 'devtools' && plan.rows[0][4] === 'greenhouse',
    JSON.stringify(plan.rows[0]));
}
{
  // A column of the user's own, inserted mid-tab. The refresh must step over
  // it, exactly as the matches sync does.
  const withMine = [...DIR];
  withMine.splice(1, 0, 'My rating');
  const r = new Array(withMine.length).fill('');
  r[0] = 'TRUE'; r[1] = '9/10'; r[2] = 'GitLab'; r[withMine.indexOf('ATS')] = 'greenhouse';
  const sheet = memoryClient({ directory: [withMine, r] });
  const plan = planDirectorySync(sheet._grid('directory'),
    [{ name: 'GitLab', description: 'new', category: 'devtools', ats: 'greenhouse', slug: 'gitlab' }]);
  check('the refresh writes past an inserted column',
    plan.operations[0].range === 'directory!C2:G2', plan.operations[0].range);

  await sheet.applyOps(plan.operations);
  const after = sheet._grid('directory')[1];
  check('the inserted column survives', after[1] === '9/10', after[1]);
  check('so does the tick', after[0] === 'TRUE');
  check('and the description still updates', after[3] === 'new', after[3]);
}

// --- robustness ------------------------------------------------------------
console.log('\n--- robustness ---');
{
  let threw = null;
  try {
    planDirectorySync(null, null); planDirectorySync([], []); planDirectorySync([DIR], [{}]);
    planDirectorySync([DIR], [null, undefined, { name: '' }]); planDirectorySync([DIR]);
    planEnable(null, null); planEnable([DIR], null); planEnable([[]], [[]]);
    planEnable([DIR, null, undefined], [CO]);
  } catch (e) { threw = e.message; }
  check('rubbish input is survivable', threw === null, threw || '');
}
{
  // The catalogue arriving in a real workbook, and a tick being honoured, is
  // exercised end to end against a fake spreadsheet in src/gas/gas.test.js.
  // What is worth checking here is that the two planners compose: refresh,
  // then enable, then do both again and change nothing.
  const client = memoryClient({ directory: [DIR], companies: [CO] });
  const refresh = planDirectorySync(await client.getValues(readRange(TABS.directory)), cleanDirectory(DIRECTORY).entries);
  await client.applyOps(refresh.operations);
  check('a first sync fills an empty catalogue', refresh.added > 50, String(refresh.added));

  const before = planEnable(await client.getValues(readRange(TABS.directory)), await client.getValues(readRange(TABS.companies)));
  check('and enables nothing, because nothing is ticked', before.added === 0);

  client._set('directory', 1, 0, 'TRUE');
  const enabled = planEnable(await client.getValues(readRange(TABS.directory)), await client.getValues(readRange(TABS.companies)));
  await client.applyOps(enabled.operations);
  check('a tick then adds exactly one company', enabled.added === 1, String(enabled.added));
  check('and the companies tab has it',
    client._grid('companies').length === 2, String(client._grid('companies').length));

  const again = planDirectorySync(await client.getValues(readRange(TABS.directory)), cleanDirectory(DIRECTORY).entries);
  check('running again refreshes nothing', again.added === 0 && again.updated === 0,
    `${again.added} added, ${again.updated} updated`);
  const twice = planEnable(await client.getValues(readRange(TABS.directory)), await client.getValues(readRange(TABS.companies)));
  check('and adds nothing twice', twice.added === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
