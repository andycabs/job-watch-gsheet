#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Offline tests for the phrase counter.
//
// The titles below are verbatim from the first live run against ClickUp,
// Apollo.io and the SmartRecruiters board that turned out to belong to a
// different Gong. 101 of 117 postings matched nothing; this is the pile.
import { tokenise, phrases, countPhrases, alreadyCovered, tally } from './phrases.js';
import { compileRules } from './rules.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const MISSED = [
  'Staff Backend Engineer, Hierarchy',
  'Senior Backend Engineer',
  'Backend Engineer, Platform',
  'Engineering Manager (Frontend)',
  'Engineering Manager',
  'Engineering Manager',
  'Technical Account Manager',
  'Account Executive, Mid-Market (London)',
  'Account Executive, New Business (Mid-Market)',
  'Account Executive, SMB',
  'Account Executive, SMB',
  'Staff Social Strategy & Operations Manager',
  'Weekend Content Producer',
  'Weekend Content Manager',
];

// --- tokenising ------------------------------------------------------------
console.log('--- tokenising ---');
check('splits a plain title', tokenise('Senior Backend Engineer').join('|') === 'senior|backend|engineer');
check('drops punctuation', tokenise('Engineering Manager (Frontend)').join('|') === 'engineering|manager|frontend');
check('keeps a slash apart', tokenise('writing/journalism internship').join('|') === 'writing|journalism|internship');
check('keeps + and # for c++ and c#', tokenise('C++ and C# Engineer').includes('c++'));
check('keeps hyphenated words whole', tokenise('Mid-Market Account Executive')[0] === 'mid-market');
check('nothing in, nothing out', tokenise('').length === 0 && tokenise(undefined).length === 0);

console.log('\n--- phrases ---');
{
  const t = ['senior', 'backend', 'engineer'];
  check('bigrams', phrases(t, 2).join(' / ') === 'senior backend / backend engineer');
  check('trigrams', phrases(t, 3).join(' / ') === 'senior backend engineer');
  check('nothing longer than the title', phrases(t, 4).length === 0);
}

// --- counting --------------------------------------------------------------
console.log('\n--- counting the miss pile ---');
{
  const groups = countPhrases(MISSED, { rules: compileRules({}) });
  const two = groups.find((g) => g.n === 2).ranked;
  const top = two.map((r) => r.phrase);

  check('finds the cluster the rules are missing', top.includes('backend engineer'),
    top.slice(0, 5).join(', '));
  check('and the other big one', top.includes('account executive'));
  check('counts them right',
    two.find((r) => r.phrase === 'account executive').count === 4,
    String(two.find((r) => r.phrase === 'account executive').count));
  check('carries an example title to judge by',
    two.find((r) => r.phrase === 'backend engineer').example.includes('Backend Engineer'));
  check('ranked most common first', two[0].count >= two.at(-1).count);
}
{
  // A phrase in one posting is not a pattern.
  const groups = countPhrases(MISSED, { rules: compileRules({}) });
  check('a one-off is not suggested',
    !groups.some((g) => g.ranked.some((r) => r.count < 2)));
  check('a lone title yields nothing at all',
    countPhrases(['Staff Backend Engineer'], { rules: compileRules({}) })
      .every((g) => g.ranked.length === 0));
}
{
  // Noise words alone say nothing; inside a phrase they carry meaning.
  const groups = countPhrases(['Remote Engineer US', 'Remote Engineer US'], { rules: compileRules({}) });
  const ones = groups.find((g) => g.n === 1).ranked.map((r) => r.phrase);
  check('a bare noise word is not suggested', !ones.includes('remote') && !ones.includes('us'), ones.join(','));
  check('but a real word is', ones.includes('engineer'));
  const twos = groups.find((g) => g.n === 2).ranked.map((r) => r.phrase);
  check('and a phrase containing one survives', twos.includes('remote engineer'), twos.join(','));
}
{
  const groups = countPhrases(['Engineer II', 'Engineer II'], { rules: compileRules({}) });
  check('a roman numeral alone is not a suggestion',
    !groups.find((g) => g.n === 1).ranked.some((r) => r.phrase === 'ii'));
}

// --- not suggesting what is already covered --------------------------------
console.log('\n--- what the rules already say ---');
{
  const rules = compileRules({ title: ['account executive'], exclude: ['intern'] });
  check('a phrase a rule already matches is covered', alreadyCovered('account executive', rules));
  check('an excluded phrase counts as covered too', alreadyCovered('intern', rules));
  check('an unrelated phrase does not', !alreadyCovered('backend engineer', rules));

  const groups = countPhrases(MISSED, { rules });
  const all = groups.flatMap((g) => g.ranked.map((r) => r.phrase));
  check('a covered phrase is not suggested back', !all.includes('account executive'));
  check('while the uncovered cluster still is', all.includes('backend engineer'));
}
{
  // A regex rule covers everything it matches, not just its literal text.
  const rules = compileRules({ title: ['/backend.*engineer/'] });
  check('a regex rule covers the phrases it would match',
    alreadyCovered('backend engineer', rules));
  const all = countPhrases(MISSED, { rules }).flatMap((g) => g.ranked.map((r) => r.phrase));
  check('so it is not suggested again', !all.includes('backend engineer'));
}

// --- tallies ---------------------------------------------------------------
console.log('\n--- tallies ---');
{
  const counted = tally(['Canada (Remote)', 'Poland (Remote)', 'Canada (Remote)', 'Canada (Remote)']);
  check('most common first', counted[0][0] === 'Canada (Remote)' && counted[0][1] === 3);
  check('and the rest follow', counted[1][0] === 'Poland (Remote)');
  check('an empty tally is empty', tally([]).length === 0);
}

// --- robustness ------------------------------------------------------------
console.log('\n--- robustness ---');
{
  let threw = null;
  try {
    countPhrases([undefined, null, '', '   ', '###'], { rules: compileRules({}) });
    countPhrases([], {});
  } catch (e) { threw = e.message; }
  check('rubbish titles are survivable', threw === null, threw || '');
  check('no rules given is fine', countPhrases(MISSED, {}).some((g) => g.ranked.length > 0));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
