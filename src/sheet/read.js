// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// Reading configuration back out of the spreadsheet.
//
// This is the direction that has to be forgiving. Everything here was typed by
// a person into a grid, so it arrives with stray capitals, trailing spaces,
// "7 days" where a number was wanted, and columns dragged into a new order.
//
// Two rules hold throughout:
//
//   Never crash on input. A value that can't be understood becomes a reported
//   problem and a documented fallback. A typo in one settings row must not
//   stop the run that would have surfaced today's jobs.
//
//   Never invent a rule. A blank sheet compiles to a rule set that matches
//   nothing. If a fallback ever produced a pattern, the engine would have
//   opinions its user never expressed.
//
// Columns are located by header text rather than by position, so inserting a
// column doesn't silently shift every field one to the left.
// ---------------------------------------------------------------------------
import { TABS, SETTINGS, RETIRED_SETTINGS, RULE_KINDS, readRange } from './schema.js';
import { compileRules } from '../rules.js';
import { ATS_NAMES } from '../boards.js';

/** Where each column actually is, by header text, with schema order as backup. */
export function indexColumns(tab, headerRow = []) {
  const seen = headerRow.map((h) => String(h ?? '').trim().toLowerCase());
  const index = {};
  const problems = [];

  tab.columns.forEach((col, position) => {
    const found = seen.indexOf(col.header.toLowerCase());
    if (found !== -1) {
      index[col.key] = found;
    } else {
      // Falling back to the schema position keeps a sheet with a renamed
      // heading working, which matters more than being strict about it.
      index[col.key] = position;
      if (seen.length) problems.push(`${tab.name}: no "${col.header}" column — assuming column ${position + 1}`);
    }
  });

  return { index, problems };
}

const cell = (row, i) => String(row?.[i] ?? '').trim();
const isOff = (v) => /^(false|no|off|0)$/i.test(String(v).trim());

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

/**
 * Turns rule rows into the input shape `compileRules` takes. Location is not
 * read here — it lives in settings, so there's one place to look for it.
 */
export function parseRules(values) {
  const [header, ...rows] = Array.isArray(values) ? values : [];
  const { index, problems } = indexColumns(TABS.rules, header);
  const input = { title: [], body: [], exclude: [], bodyRequiresTitleHint: [] };
  let active = 0;

  rows.forEach((row, i) => {
    const line = i + 2;
    const pattern = cell(row, index.pattern);
    const kind = cell(row, index.kind).toLowerCase();
    if (isOff(cell(row, index.active))) return;      // switched off, not a problem
    if (!pattern && !kind) return;                   // an empty row is just an empty row

    if (!pattern) {
      problems.push(`rules row ${line}: a "${kind}" rule with no pattern — ignored`);
      return;
    }
    const target = RULE_KINDS[kind];
    if (!target) {
      problems.push(
        `rules row ${line}: unknown kind "${kind || '(blank)'}" for "${pattern}" — ` +
        `expected ${Object.keys(RULE_KINDS).join(', ')}`
      );
      return;
    }
    input[target].push({ pattern, label: pattern, note: cell(row, index.note), row: line });
    active++;
  });

  return { input, problems, active };
}

// ---------------------------------------------------------------------------
// companies
// ---------------------------------------------------------------------------

export function parseCompanies(values) {
  const [header, ...rows] = Array.isArray(values) ? values : [];
  const { index, problems } = indexColumns(TABS.companies, header);
  const all = [];

  rows.forEach((row, i) => {
    const name = cell(row, index.name);
    if (!name) return;

    const ats = cell(row, index.ats).toLowerCase();
    const slug = cell(row, index.slug);
    const line = i + 2;

    if (ats && !ATS_NAMES.includes(ats)) {
      problems.push(
        `companies row ${line}: "${name}" has ATS "${ats}", which isn't one of ` +
        `${ATS_NAMES.join(', ')} — clear the cell and let discovery fill it in`
      );
    }

    all.push({
      row: line,
      name,
      category: cell(row, index.category),
      note: cell(row, index.note),
      ats: ATS_NAMES.includes(ats) ? ats : '',
      slug,
      verified: cell(row, index.verified),
      active: !isOff(cell(row, index.active)),
    });
  });

  const usable = all.filter((c) => c.active);
  return {
    all,
    problems,
    ready: usable.filter((c) => c.ats && c.slug),
    needsDiscovery: usable.filter((c) => !c.ats || !c.slug),
  };
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

/**
 * Reads the settings tab against the spec the seed rows carry. A row the
 * schema doesn't know about is reported rather than ignored — it's usually a
 * typo in the setting name, and silently defaulting would look like the
 * setting simply had no effect.
 */
export function parseSettings(values) {
  const [header, ...rows] = Array.isArray(values) ? values : [];
  const { index, problems } = indexColumns(TABS.settings, header);

  const settings = {};
  for (const spec of Object.values(SETTINGS)) settings[spec.key] = coerce(spec, spec.value).value;

  const seen = new Set();
  rows.forEach((row, i) => {
    const label = cell(row, index.setting);
    if (!label) return;
    const line = i + 2;

    const spec = SETTINGS[label.toLowerCase()] || SETTINGS[label];
    if (!spec) {
      const retired = RETIRED_SETTINGS[label.toLowerCase()];
      problems.push(retired
        ? `settings row ${line}: "${label}" is no longer used — ${retired}`
        : `settings row ${line}: unknown setting "${label}" — it has no effect`);
      return;
    }
    if (seen.has(spec.key)) {
      problems.push(`settings row ${line}: "${label}" appears twice — using the later value`);
    }
    seen.add(spec.key);

    const raw = cell(row, index.value);
    const { value, problem } = coerce(spec, raw);
    settings[spec.key] = value;
    if (problem) problems.push(`settings row ${line}: ${problem}`);
  });

  // Weights are relative, so any positive total works — but a total of zero
  // would make every score zero, which reads as "the scorer is broken".
  const weights = Object.values(SETTINGS).filter((s) => s.weight);
  const total = weights.reduce((n, s) => n + (settings[s.key] || 0), 0);
  if (total <= 0) {
    problems.push('settings: every scoring weight is zero or blank — restoring the defaults');
    for (const s of weights) settings[s.key] = Number(s.value);
  }

  return { settings, problems };
}

function coerce(spec, raw) {
  const text = String(raw ?? '').trim();

  if (spec.type === 'number') {
    if (!text) return { value: spec.value === '' ? null : Number(spec.value) };
    // "$180,000" and "180k" are what people actually type into a salary floor.
    const cleaned = text.replace(/[$,\s]/g, '').replace(/k$/i, '000');
    const n = Number(cleaned);
    if (!Number.isFinite(n)) {
      return {
        value: spec.value === '' ? null : Number(spec.value),
        problem: `"${text}" is not a number — using ${spec.value === '' ? 'no limit' : spec.value}`,
      };
    }
    return { value: n };
  }

  if (spec.type === 'enum') {
    if (!text) return { value: spec.value };
    const lower = text.toLowerCase();
    if (!spec.options.includes(lower)) {
      return {
        value: spec.value,
        problem: `"${text}" is not one of ${spec.options.join(', ')} — using ${spec.value}`,
      };
    }
    return { value: lower };
  }

  if (spec.type === 'list') {
    return {
      value: text.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    };
  }

  return { value: text };
}

// ---------------------------------------------------------------------------
// the whole configuration
// ---------------------------------------------------------------------------

/**
 * Reads every tab and compiles it. The result is everything a run needs and
 * nothing it doesn't — no file on disk contributes.
 */
export async function readConfig(client) {
  const wanted = ['rules', 'companies', 'settings'];
  const values = {};
  for (const name of wanted) {
    values[name] = await client.getValues(readRange(TABS[name]));
  }

  const rulesPart = parseRules(values.rules);
  const companiesPart = parseCompanies(values.companies);
  const settingsPart = parseSettings(values.settings);

  const rules = compileRules({
    ...rulesPart.input,
    location: {
      mode: settingsPart.settings.locationMode,
      allowlist: settingsPart.settings.locationAllowlist,
    },
  });

  return {
    rules,
    companies: companiesPart,
    settings: settingsPart.settings,
    activeRules: rulesPart.active,
    problems: [
      ...rulesPart.problems,
      ...companiesPart.problems,
      ...settingsPart.problems,
      ...rules.problems,
    ],
  };
}


