#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Offline tests for reading configuration back out of the sheet.
//
// The fixture below is not invented: it is the workbook this repo actually
// created, read back from a live spreadsheet. Every parser in this project
// that was written against imagined input has had a bug in it, so the first
// case here is the real thing.
import { memoryClient } from './memory.js';
import { readConfig, parseRules, parseCompanies, parseSettings, indexColumns } from './read.js';
import { TABS, SETTINGS, headers } from './schema.js';
import { matchJob } from '../match.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

// The workbook as it stands in the live sheet, with one real company typed in.
const LIVE = {
  rules: [
    ['Active', 'Kind', 'Pattern', 'Note'],
    ['TRUE', 'title', 'staff engineer', 'Example — edit or delete'],
    ['FALSE', 'exclude', 'intern', 'Example — set Active to TRUE to use'],
  ],
  companies: [
    ['Active', 'Name', 'Category', 'Note', 'ATS', 'Slug', 'Verified'],
    ['TRUE', 'ClickUp', '', 'Leave ATS and Slug blank, then run discovery', '', '', ''],
  ],
  settings: [headers(TABS.settings), ...TABS.settings.seed.map((s) => [s.setting, s.value, s.note])],
  matches: [headers(TABS.matches)],
  dropped: [headers(TABS.dropped)],
};

const job = (over = {}) => ({
  id: '1', title: 'Staff Engineer', company: 'ClickUp', location: 'Remote',
  body: '', compensation: '', url: 'https://x', ...over,
});

// --- the live workbook -----------------------------------------------------
console.log('--- the sheet as it actually is ---');
{
  const config = await readConfig(memoryClient(LIVE));

  check('reads it without complaint', config.problems.length === 0, config.problems.join('; '));
  check('one active rule', config.activeRules === 1);
  check('the switched-off exclusion is left out', config.rules.exclude.length === 0);
  check('the title rule compiled', config.rules.title.length === 1);
  check('ClickUp needs discovery', config.companies.needsDiscovery.length === 1);
  check('and nothing is ready to watch yet', config.companies.ready.length === 0);
  check('it knows which row to write the slug back to',
    config.companies.needsDiscovery[0].row === 2);

  check('defaults survive the round trip: close after 7 days', config.settings.closeAfterDays === 7);
  check('stale after 60', config.settings.stalePostingDays === 60);
  check('no salary floor', config.settings.salaryFloor === null);
  check('location is unrestricted', config.rules.location.mode === 'any');
  check('weights come through', config.settings.weightTitle === 40 && config.settings.weightFreshness === 15);

  check('the rule matches what it says on the tin',
    matchJob(job(), config.rules).matched);
  check('and does not match something else',
    !matchJob(job({ title: 'Account Executive' }), config.rules).matched);
}

// --- a blank sheet matches nothing -----------------------------------------
console.log('\n--- an empty configuration ---');
{
  const blank = {
    rules: [headers(TABS.rules)],
    companies: [headers(TABS.companies)],
    settings: [headers(TABS.settings)],
  };
  const config = await readConfig(memoryClient(blank));
  check('no rules', config.activeRules === 0 && config.rules.title.length === 0);
  check('no complaints either', config.problems.length === 0, config.problems.join('; '));

  const titles = [
    'Staff Engineer', 'VP of Marketing', 'Head of Revenue Operations',
    'Product Designer', 'Data Scientist', 'Chief of Staff', 'Barista',
  ];
  check('matches nothing at all',
    titles.every((t) => !matchJob(job({ title: t }), config.rules).matched),
    titles.filter((t) => matchJob(job({ title: t }), config.rules).matched).join(', '));
}

// --- what people actually type ---------------------------------------------
console.log('\n--- forgiving what people type ---');
{
  const rows = [
    headers(TABS.rules),
    ['TRUE', 'Title', '  Head of Growth  ', 'stray spaces and a capital'],
    ['', 'body', 'product-led growth', 'blank Active counts as on'],
    ['TRUE', 'exclude', '', 'no pattern'],
    ['TRUE', 'titel', 'vp marketing', 'typo in the kind'],
    ['FALSE', 'title', 'intern', 'switched off'],
    ['', '', '', ''],
  ];
  const { input, problems, active } = parseRules(rows);
  check('trims and lowercases the kind', input.title[0].pattern === 'Head of Growth');
  check('a blank Active means on', input.body.length === 1);
  check('two usable rules survive', active === 2, String(active));
  check('an empty row is not an error', !problems.some((p) => p.includes('row 7')));
  check('a rule with no pattern is reported', problems.some((p) => /row 4.*no pattern/.test(p)),
    problems.join(' | '));
  check('a mistyped kind is reported with the pattern',
    problems.some((p) => /row 5.*"titel".*vp marketing/.test(p)), problems.join(' | '));
  check('and names the kinds that would have worked',
    problems.some((p) => p.includes('title-hint')));
}
{
  const rows = [
    headers(TABS.settings),
    ['salary floor', '$180,000', ''],
    ['close after days', '14', ''],
    ['location mode', 'Remote-Only', ''],
    ['seniority target', 'Director, VP, Head of ', ''],
  ];
  const { settings, problems } = parseSettings(rows);
  check('reads a salary written the way people write it', settings.salaryFloor === 180000);
  check('an override is taken', settings.closeAfterDays === 14);
  check('an enum is case-insensitive', settings.locationMode === 'remote-only');
  check('a list is split and normalised',
    JSON.stringify(settings.seniorityTarget) === '["director","vp","head of"]');
  check('none of that is a problem', problems.length === 0, problems.join('; '));
}
{
  const rows = [
    headers(TABS.settings),
    ['salary floor', 'about two hundred', ''],
    ['location mode', 'hybrid', ''],
    ['salery basis', 'ote', ''],
    ['close after days', '', ''],
  ];
  const { settings, problems } = parseSettings(rows);
  check('nonsense in a number falls back and says so',
    settings.salaryFloor === null && problems.some((p) => /not a number/.test(p)));
  check('an unsupported enum names the options',
    settings.locationMode === 'any' && problems.some((p) => /any, remote-only/.test(p)),
    problems.join(' | '));
  check('a misspelled setting is reported rather than ignored',
    problems.some((p) => /unknown setting "salery basis"/.test(p)));
  check('and it explains the consequence', problems.some((p) => /no effect/.test(p)));
  check('a blank value means the default', settings.closeAfterDays === 7);
}
{
  const rows = [
    headers(TABS.settings),
    ['salary floor', '180k', ''],
    ['close after days', '7', ''],
    ['close after days', '30', ''],
  ];
  const { settings, problems } = parseSettings(rows);
  check('180k is 180000', settings.salaryFloor === 180000);
  check('a duplicated setting takes the later value', settings.closeAfterDays === 30);
  check('and says which one won', problems.some((p) => /appears twice/.test(p)));
}
{
  const rows = [headers(TABS.settings), ...Object.values(SETTINGS)
    .filter((s) => s.weight).map((s) => [s.setting, '0', ''])];
  const { settings, problems } = parseSettings(rows);
  check('all-zero weights are restored rather than scoring everything zero',
    settings.weightTitle === 40, String(settings.weightTitle));
  check('and the restoration is reported', problems.some((p) => /every scoring weight/.test(p)));
}

{
  // A sheet is never rewritten, so a row for a setting that has since been
  // retired outlives the version that used it. Telling someone a row they
  // were once told to fill in is "unknown" is not helpful.
  const rows = [headers(TABS.settings), ['salary basis', 'both', 'stale note from an older version']];
  const { problems } = parseSettings(rows);
  check('a retired setting is named as retired, not unknown',
    problems.some((p) => /no longer used/.test(p)) && !problems.some((p) => /unknown setting/.test(p)),
    problems.join(' | '));
  check('and says it is safe to delete', problems.some((p) => /delete this row/.test(p)));
}

// --- columns moved around --------------------------------------------------
console.log('\n--- a rearranged sheet ---');
{
  const rows = [
    ['Note', 'Pattern', 'Kind', 'Active'],
    ['reordered by hand', 'head of revenue', 'title', 'TRUE'],
  ];
  const { input, problems } = parseRules(rows);
  check('columns are found by heading, not position', input.title[0]?.pattern === 'head of revenue');
  check('with nothing to report', problems.length === 0, problems.join('; '));
}
{
  const rows = [
    ['Active', 'Kind', 'Pattern', 'Mine', 'Note'],
    ['TRUE', 'title', 'staff engineer', 'a column someone inserted', 'the real note'],
  ];
  const { input } = parseRules(rows);
  check('an inserted column does not shift the fields',
    input.title[0]?.pattern === 'staff engineer' && input.title[0]?.note === 'the real note');
}
{
  const { index, problems } = indexColumns(TABS.rules, ['Active', 'Kind', 'Sample', 'Note']);
  check('a renamed heading falls back to its usual position', index.pattern === 2);
  check('and is reported', problems.some((p) => /no "Pattern" column/.test(p)));
}

// --- companies -------------------------------------------------------------
console.log('\n--- companies ---');
{
  const rows = [
    headers(TABS.companies),
    ['TRUE', 'Grafana Labs', 'infra', '', 'greenhouse', 'grafanalabs', '2026-08-01'],
    ['TRUE', 'ClickUp', '', '', '', '', ''],
    ['FALSE', 'Somewhere I passed on', '', '', 'lever', 'somewhere', ''],
    ['TRUE', 'Typo Inc', '', '', 'greenhosue', 'typo', ''],
    ['TRUE', '', '', 'a row with only a note', '', '', ''],
  ];
  const { ready, needsDiscovery, all, problems } = parseCompanies(rows);
  check('a fully resolved company is ready', ready.length === 1 && ready[0].slug === 'grafanalabs');
  check('a blank slug needs discovery',
    needsDiscovery.map((c) => c.name).join(',') === 'ClickUp,Typo Inc');
  check('an inactive company is kept but not watched',
    all.length === 4 && !ready.concat(needsDiscovery).some((c) => c.name.startsWith('Somewhere')));
  check('a nameless row is skipped', !all.some((c) => !c.name));
  check('a misspelled ATS is reported', problems.some((p) => /"greenhosue"/.test(p)));
  check('and lists the ones that exist', problems.some((p) => /smartrecruiters/.test(p)));
  check('the bad value is not passed through as if it were real',
    needsDiscovery.find((c) => c.name === 'Typo Inc').ats === '');
}

// --- location comes from settings, not rules -------------------------------
console.log('\n--- location ---');
{
  const sheet = memoryClient({
    ...LIVE,
    settings: [headers(TABS.settings), ['location mode', 'remote-only', ''],
               ['location allowlist', 'united states, americas', '']],
  });
  const config = await readConfig(sheet);
  check('the mode reaches the compiled rules', config.rules.location.mode === 'remote-only');
  check('so does the allowlist',
    config.rules.location.allowlist.map((p) => p.label).join(',') === 'united states,americas',
    config.rules.location.allowlist.map((p) => p.label).join(','));
}

// --- nothing here throws ---------------------------------------------------
console.log('\n--- robustness ---');
{
  const nasty = [
    [], [[]], [['Active']], [undefined, [null, undefined]],
    [headers(TABS.rules), ['TRUE', 'title', '/unclosed(/', 'a broken regex']],
  ];
  let threw = null;
  for (const rows of nasty) {
    try { parseRules(rows); parseCompanies(rows); parseSettings(rows); }
    catch (e) { threw = `${JSON.stringify(rows)}: ${e.message}`; }
  }
  check('malformed input is survivable', threw === null, threw || '');

  const config = await readConfig(memoryClient({
    rules: [headers(TABS.rules), ['TRUE', 'title', '/unclosed(/', 'broken regex']],
    companies: [headers(TABS.companies)],
    settings: [headers(TABS.settings)],
  }));
  check('a broken regex is reported, not thrown',
    config.problems.some((p) => /unclosed/.test(p)), config.problems.join(' | '));
  check('and the run still has a usable rule set', Array.isArray(config.rules.title));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
