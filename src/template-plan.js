// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// Turning a starter template into rows.
//
// Separated from where the templates come from: on the command line they are
// files in the repository, inside the spreadsheet they are baked into the
// build. What they become — which rules are new, which are already there,
// where they go — is the same either way.
// ---------------------------------------------------------------------------
import { compileRules } from './rules.js';
import { TABS, colLetter, RULE_KINDS, usedRows } from './sheet/schema.js';

/** Which template file feeds which rules column. */
const KIND_FOR = Object.fromEntries(
  Object.entries(RULE_KINDS).map(([kind, key]) => [key, kind])
);

export function planTemplateRows(template, existingRows = [], { note } = {}) {
  const tab = TABS.rules;
  const index = Object.fromEntries(tab.columns.map((c, i) => [c.key, i]));

  const present = new Set(
    existingRows.slice(1)
      .map((row) => String(row?.[index.pattern] ?? '').trim())
      .filter(Boolean)
  );

  const rows = [];
  const skipped = [];
  const label = note || `from the ${template.name} template`;

  for (const [key, kind] of Object.entries(KIND_FOR)) {
    for (const pattern of template[key] || []) {
      const text = String(pattern).trim();
      if (!text) continue;
      if (present.has(text)) { skipped.push(text); continue; }
      present.add(text);           // a template listing a pattern twice adds it once
      rows.push(tab.columns.map((c) => {
        if (c.key === 'active') return 'TRUE';
        if (c.key === 'kind') return kind;
        if (c.key === 'pattern') return text;
        if (c.key === 'note') return label;
        return '';
      }));
    }
  }

  // The rules tab's Active column is a checkbox, so untouched rows read FALSE
  // and would otherwise be counted as existing ones. Plus two, not one: the
  // count is of body rows and the header sits above them.
  return { rows, skipped, firstRow: usedRows(existingRows.slice(1), index.pattern) + 2 };
}

/** The write that appends those rows, or nothing when there are none. */
export function planTemplateWrite(plan) {
  if (!plan.rows.length) return [];
  const tab = TABS.rules;
  const last = colLetter(tab.columns.length - 1);
  const start = Math.max(plan.firstRow, 2);
  return [{
    op: 'writeRange',
    range: `${tab.name}!A${start}:${last}${start + plan.rows.length - 1}`,
    values: plan.rows,
  }];
}

// ---------------------------------------------------------------------------
