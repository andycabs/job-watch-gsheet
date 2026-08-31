#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Tests for flattening the engine into one file.
//
// Apps Script has one global scope and no import statement. The risk in a
// bundler is not that it fails — it is that it succeeds and produces a file
// that is subtly a different program, which no test of the original catches.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importsOf, orderFiles, stripModuleSyntax, refuseUnsupported, bundle, withSubstitutes } from './bundle.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
};

const files = {
  'a.js': "import { b } from './b.js';\nimport { c } from './sub/c.js';\nexport const a = b + c;\n",
  'b.js': "export const b = 1;\n",
  'sub/c.js': "import { b } from '../b.js';\nexport function c() { return b; }\nexport const c2 = 2;\n",
};
const read = (f) => {
  if (!(f in files)) throw new Error(`no such file ${f}`);
  return files[f];
};

console.log('--- reading imports ---');
check('local imports are found', String(importsOf(files['a.js'])) === './b.js,./sub/c.js');
check('a file with none returns none', importsOf('const x = 1;\n').length === 0);
check('the word import inside a string is not an import',
  importsOf(['const s = ', String.fromCharCode(34), 'import { x } from y',
    String.fromCharCode(34), ';\n'].join('')).length === 0);

console.log('\n--- ordering ---');
{
  const order = orderFiles('a.js', read);
  check('dependencies come before dependents',
    order.indexOf('b.js') < order.indexOf('sub/c.js') && order.indexOf('sub/c.js') < order.indexOf('a.js'),
    order.join(' → '));
  check('a shared dependency appears once', order.filter((f) => f === 'b.js').length === 1);
  check('relative paths resolve across directories', order.includes('sub/c.js'));
}
{
  // const is not hoisted, so order is correctness here, not tidiness.
  let threw = '';
  const cyclic = { 'x.js': "import './y.js';\n", 'y.js': "import './x.js';\n" };
  try { orderFiles('x.js', (f) => cyclic[f]); } catch (e) { threw = e.message; }
  check('a cycle is refused by name', /import cycle/.test(threw), threw);
}
{
  let threw = '';
  try { orderFiles('n.js', () => "import { readFileSync } from 'node:fs';\n"); } catch (e) { threw = e.message; }
  check('a node: import is refused', /does not exist in Apps Script/.test(threw), threw);
}

console.log('\n--- stripping ---');
{
  const out = stripModuleSyntax(files['sub/c.js']);
  check('the import line goes', !/^import/m.test(out));
  check('but the declaration stays', /function c\(\)/.test(out) && /const c2 = 2/.test(out));
  check('and the export keyword does not', !/\bexport\b/.test(out), out);
}
check('async functions keep their async',
  /^async function f/m.test(stripModuleSyntax('export async function f() {}\n')));
check('a trailing export block is removed',
  !/export/.test(stripModuleSyntax('const a = 1;\nexport { a };\n')));
check('the word export inside code is untouched',
  /exportSomething/.test(stripModuleSyntax('const exportSomething = 1;\n')));

console.log('\n--- refusing what it cannot do ---');
for (const [src, why] of [
  ['export default function f() {}\n', 'export default'],
  ['const m = await import("./x.js");\n', 'dynamic import()'],
  ['const u = import.meta.url;\n', 'import.meta'],
  ["export * from './x.js';\n", 'export *'],
]) {
  check(`${why} is refused rather than mishandled`,
    refuseUnsupported('f.js', src).some((p) => p.includes(why)));
}
check('ordinary code is not refused', refuseUnsupported('f.js', files['a.js']).length === 0);

console.log('\n--- substitutes ---');
{
  const sub = withSubstitutes(read, { 'b.js': 'export const b = 99;\n' });
  const out = bundle('a.js', sub);
  check('a substituted file replaces the original', /const b = 99/.test(out) && !/const b = 1;/.test(out));
  check('and its imports are the substitute\'s, not the original\'s',
    orderFiles('a.js', withSubstitutes(read, { 'sub/c.js': 'export const c = 3;\n' })).length === 3,
    'the substitute has no import of b.js, but a.js still does');
}

console.log('\n--- the real engine ---');
{
  const root = fileURLToPath(new URL('.', import.meta.url));
  const disk = (f) => readFileSync(path.join(root, f), 'utf8');
  const ENTRY = '__engine.js';
  const parts = ['match.js', 'sync.js', 'score.js', 'salary.js', 'rules.js',
    'boards.js', 'sheet/read.js', 'sheet/schema.js', 'log.js'];
  const sub = withSubstitutes(disk, {
    [ENTRY]: parts.map((f) => `import './${f}';`).join('\n'),
    // What a build for Apps Script substitutes: none of these is logic, they
    // are all "where does this come from", which has a different answer there.
    'version.js': "export const VERSION = '0.0.0';\n",
  });

  let out = '';
  let threw = '';
  try { out = bundle(ENTRY, sub); } catch (e) { threw = e.message; }
  check('the engine flattens without error', Boolean(out) && !threw, threw);
  check('nothing module-shaped survives', out && !/^\s*(import|export)\s/m.test(out));
  check('nothing reaches for Node', out && !/require\(|node:/.test(out));

  // One scope means one namespace. A collision would silently shadow.
  const names = [...out.matchAll(/^(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  check('no two files declare the same top-level name', dupes.length === 0, [...new Set(dupes)].join(', '));

  check('the whole engine is there', out.length > 50000, `${Math.round(out.length / 1024)}KB`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
