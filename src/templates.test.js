#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Tests every shipped template against realistic postings.
//
// The point isn't that these particular regexes are perfect — it's that the
// domain knowledge lives in the template files rather than in the engine. The
// same code, given a different template, matches a different job family.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileRules } from './rules.js';
import { matchJob } from './match.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const job = (title, over = {}) => ({
  id: 'x', title, location: 'Remote - US', url: '', postedAt: null, body: '', ...over,
});

// --- every template must be well-formed ------------------------------------
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
check('templates directory is not empty', files.length > 0, files.join(', '));

for (const file of files) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  check(`${file}: has a name`, Boolean(raw.name));
  check(`${file}: has a description`, Boolean(raw.description));
  check(`${file}: defines title rules`, Array.isArray(raw.title) && raw.title.length > 0);

  const rules = compileRules(raw);
  check(`${file}: compiles without problems`, rules.problems.length === 0, rules.problems.join('; '));
}

// --- software engineering --------------------------------------------------
console.log('\n--- software-engineering ---');
{
  const rules = compileRules(JSON.parse(fs.readFileSync(path.join(dir, 'software-engineering.json'), 'utf8')));

  const shouldMatch = [
    'Senior Software Engineer',
    'Staff Engineer, Payments',
    'Backend Engineer',
    'Front-End Developer',
    'Full Stack Engineer',
    'Principal Engineer, Distributed Systems',
    'Site Reliability Engineer',
    'SRE, Platform',
    'Infrastructure Engineer',
    'DevOps Engineer',
    'Senior iOS Engineer',
    'Security Engineer, Detection',
  ];
  const missed = shouldMatch.filter((t) => !matchJob(job(t), rules).matched);
  check('matches core engineering titles', missed.length === 0, missed.join(', ') || `${shouldMatch.length}/${shouldMatch.length}`);

  const shouldNotMatch = [
    'Marketing Operations Manager',
    'Account Executive',
    'Product Designer',
    'Recruiter, Technical',
    'Chief of Staff',
    'Customer Success Manager',
  ];
  const wrong = shouldNotMatch.filter((t) => matchJob(job(t), rules).matched);
  check('ignores unrelated job families', wrong.length === 0, wrong.join(', ') || `0/${shouldNotMatch.length}`);

  // Exclusions
  const excluded = ['Software Engineering Intern', 'Sales Engineer', 'Solutions Engineer', 'Engineering Manager'];
  const leaked = excluded.filter((t) => matchJob(job(t), rules).matched);
  check('drops adjacent-but-wrong roles', leaked.length === 0, leaked.join(', ') || `0/${excluded.length}`);

  // Body signals, with the title gate active
  const viaBody = matchJob(job('Systems Analyst', { body: 'You will own our Kubernetes and Terraform estate.' }), rules);
  check('a body signal can carry an adjacent title', viaBody.matched && viaBody.tier === 'body');

  const gated = matchJob(job('Office Manager', { body: 'Our team uses Kubernetes.' }), rules);
  check('but not an unrelated one', !gated.matched);

  // Location
  const onsite = matchJob(job('Staff Engineer', { location: 'Dublin, Ireland' }), rules);
  check('respects remote-only', !onsite.matched && onsite.stage === 'location');

  // The v1 bug this template would have tripped over
  const distributed = matchJob(job('Engineer, Distributed Systems', { location: 'Dublin, Ireland' }), rules);
  check('"Distributed Systems" in a title is not a remote signal', !distributed.matched);
}

// --- the engine carries no domain knowledge --------------------------------
console.log('\n--- separation of concerns ---');
{
  // The same postings, with no template loaded, match nothing.
  const blank = compileRules({});
  const engineeringRoles = ['Senior Software Engineer', 'SRE, Platform', 'Backend Engineer'];
  const matched = engineeringRoles.filter((t) => matchJob(job(t), blank).matched);
  check('engineering titles do not match without a template', matched.length === 0, matched.join(', '));
}

// --- each template catches its own family ----------------------------------
// Real titles, taken from live boards where possible. The pass cases are what
// the template exists for; the fail cases are the neighbouring families it
// must not drag in, which is the failure mode a preset actually has.
const FAMILIES = {
  'gtm-revops': {
    catches: [
      'Revenue Operations Manager',
      'Senior Manager, GTM Operations',
      'Director of Marketing Operations',
      'Business Systems Analyst, Revenue',
      'Salesforce Administrator',
      'Head of Sales Systems',
      'Deal Desk Manager',
    ],
    ignores: [
      'Enterprise Account Executive (EMEA)',
      'Business Development Representative',
      'Staff Backend Engineer',
      'Product Designer',
      'Social Media Intern For Growing Startup',
    ],
  },
  'product-design': {
    catches: [
      'Senior Product Designer',
      'Staff UX Designer',
      'Design Systems Lead',
      'UX Researcher',
      'Principal Designer',
      'Design Engineer',
    ],
    ignores: [
      'Graphic Designer',
      'Brand Designer',
      'Senior Backend Engineer',
      'Revenue Operations Manager',
      'Design Intern',
    ],
  },
  data: {
    catches: [
      'Senior Data Engineer',
      'Analytics Engineer',
      'Staff Machine Learning Engineer',
      'Data Scientist, Experimentation',
      'Business Intelligence Analyst',
      'Applied Scientist',
    ],
    ignores: [
      'Data Entry Clerk',
      'Sales Analyst',
      'Frontend Engineer',
      'Product Designer',
      'Data Science Intern',
    ],
  },
  'software-engineering': {
    catches: [
      'Staff Frontend Engineer',
      'Senior Software Engineer, Internally Deployed',
      'Site Reliability Engineer',
      'Principal Platform Engineer',
    ],
    ignores: [
      'Engineering Manager',
      'Sales Engineer',
      'Revenue Operations Manager',
      'Software Engineering Intern',
    ],
  },
};

for (const [id, { catches, ignores }] of Object.entries(FAMILIES)) {
  console.log(`\n--- ${id} ---`);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
  const rules = compileRules(raw);

  for (const title of catches) {
    check(`catches ${title}`, matchJob(job(title), rules).matched);
  }
  for (const title of ignores) {
    const verdict = matchJob(job(title), rules);
    check(`ignores ${title}`, !verdict.matched, verdict.stage);
  }
}

// --- and not each other's ---------------------------------------------------
// A preset that quietly matches a neighbouring family is worse than one that
// misses: the user sees plausible results and never learns the rule is wrong.
console.log('\n--- no cross-family bleed ---');
{
  const compiled = Object.fromEntries(Object.keys(FAMILIES).map((id) =>
    [id, compileRules(JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')))]));

  for (const [id, { catches }] of Object.entries(FAMILIES)) {
    for (const [other, rules] of Object.entries(compiled)) {
      if (other === id) continue;
      const bled = catches.filter((t) => matchJob(job(t), rules).matched);
      check(`${other} does not claim ${id}'s roles`, bled.length === 0, bled.join(', '));
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
