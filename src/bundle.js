#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// Flattening the engine into one file.
//
//   node src/bundle.js            write build/engine.gs
//   node src/bundle.js --check    report what would happen, write nothing
//
// Apps Script has no module system: every file shares one global scope and
// `import` is a syntax error. This resolves the import graph, drops the module
// syntax, and concatenates in dependency order.
//
// It is deliberately not a general bundler. It handles the subset this
// codebase uses and refuses anything else by name, because a bundler that
// quietly mishandles a construct produces a file that looks right and behaves
// differently — the worst possible failure for a build step nobody reads the
// output of.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const IMPORT = /^import\s+(?:[\w*\s{},$]+\s+from\s+)?['"]([^'"]+)['"];?\s*$/gm;

/** Local imports only — anything from node: has no business in the bundle. */
export function importsOf(source) {
  const found = [];
  for (const m of String(source).matchAll(IMPORT)) found.push(m[1]);
  return found;
}

/**
 * Files in an order where nothing is used before it is defined.
 *
 * `const` is not hoisted, so a file whose top level reads another file's
 * constant has to come after it. Function declarations would survive any
 * order; constants are why this sorts at all.
 */
export function orderFiles(entry, read) {
  const seen = new Set();
  const order = [];

  const visit = (file, stack = []) => {
    if (seen.has(file)) return;
    if (stack.includes(file)) {
      throw new Error(`import cycle: ${[...stack.slice(stack.indexOf(file)), file].join(' → ')}`);
    }
    const source = read(file);
    for (const spec of importsOf(source)) {
      if (spec.startsWith('node:')) {
        throw new Error(`${file} imports ${spec} — Node's library does not exist in Apps Script`);
      }
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)), [...stack, file]);
    }
    seen.add(file);
    order.push(file);
  };

  visit(entry);
  return order;
}

/**
 * A reader that serves replacements for files that cannot cross over.
 *
 * Three files on the watch path reach for things Apps Script does not have:
 * the sheet transport (HTTP and crypto), the catalogue loader (the file
 * system), and the version (package.json). None of them is logic — they are
 * all "where does this come from", which is exactly the question that has a
 * different answer on the other side. Substituting them is how the same engine
 * runs in both places without a fork.
 */
export function withSubstitutes(read, substitutes = {}) {
  return (file) => (file in substitutes ? substitutes[file] : read(file));
}

/** One file's source with its module syntax removed. */
export function stripModuleSyntax(source) {
  return String(source)
    .replace(IMPORT, '')
    // `export function f` / `export const C` — the declaration stays, the
    // keyword goes. In one scope everything is already visible to everything.
    .replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/gm, '')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
    .trimEnd();
}

/**
 * Removes async and await.
 *
 * Apps Script is synchronous: UrlFetchApp.fetch returns a response rather than
 * a promise, and Utilities.sleep blocks. Given that, `await` on a plain call
 * is a no-op and `async` only wraps the return value in a promise nobody
 * unwraps — so taking both out is not an approximation, it is the same program
 * with the ceremony removed.
 *
 * This is only true because the engine has no real promises in it: one
 * `new Promise` for a sleep, no Promise.all, no .then, no for-await. Anything
 * else has to be substituted rather than stripped, which is what
 * refuseUnsupported is for.
 */
export function stripAsync(source) {
  return String(source)
    // `async function f`, `async (a) =>`, `async a =>`, and — the one this
    // missed the first time — `async f()` as an object method. The adapters
    // are all written that way, so every board fetch came back a promise the
    // stripped code then used as if it were data.
    .replace(/\basync\s+(?=function\b)/g, '')
    .replace(/\basync\s*(?=\()/g, '')
    .replace(/\basync\s+(?=[A-Za-z_$][\w$]*\s*(?:\(|=>))/g, '')
    .replace(/\bawait\s+/g, '');
}

/** Constructs this deliberately does not handle, rather than mishandling. */
export function refuseUnsupported(file, source) {
  const problems = [];
  if (/^export\s+default\b/m.test(source)) problems.push('export default');
  if (/\bimport\s*\(/.test(source)) problems.push('dynamic import()');
  if (/\bimport\.meta\b/.test(source)) problems.push('import.meta');
  if (/^export\s+\*/m.test(source)) problems.push('export *');
  return problems.map((p) => `${file}: ${p} is not supported by this bundler`);
}

/**
 * Promises that stripping async cannot honour.
 *
 * Removing `await` is safe only where the thing awaited was never really
 * asynchronous. A Promise.all or a .then is a real one, and dropping the await
 * in front of it would leave a pending promise being used as a value — code
 * that runs, produces nonsense, and fails nowhere near the cause.
 */
export function refuseRealPromises(file, source) {
  const found = [];
  if (/\bPromise\s*\.\s*(all|race|allSettled|any)\b/.test(source)) found.push('Promise combinator');
  if (/\bnew\s+Promise\b/.test(source)) found.push('new Promise');
  if (/\.then\s*\(/.test(source)) found.push('.then()');
  if (/\bfor\s+await\b/.test(source)) found.push('for await');
  return found.map((p) => `${file}: ${p} cannot survive the synchronous build — substitute this file`);
}

export function bundle(entry, read, { banner = '', sync = false } = {}) {
  const files = orderFiles(entry, read);
  const problems = [];
  const parts = [];

  for (const file of files) {
    const source = read(file);
    problems.push(...refuseUnsupported(file, source));
    if (sync) problems.push(...refuseRealPromises(file, source));
    const stripped = stripModuleSyntax(source);
    parts.push(`// ===== ${file} ${'='.repeat(Math.max(0, 66 - file.length))}\n${sync ? stripAsync(stripped) : stripped}`);
  }

  if (problems.length) throw new Error(problems.join('\n'));
  return `${banner}${parts.join('\n\n')}\n`;
}

// --- command line -----------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const read = (file) => readFileSync(path.join(root, file), 'utf8');
  const entry = process.argv.find((a) => a.endsWith('.js') && !a.includes('bundle.js')) || 'watch.js';

  const banner = [
    '// Generated by src/bundle.js — do not edit.',
    `// Entry: ${entry}`,
    '',
    '',
  ].join('\n');

  const out = bundle(entry, read, { banner });
  const files = orderFiles(entry, read);

  console.log(`${files.length} files, ${out.split('\n').length} lines`);
  for (const f of files) console.log(`  ${f}`);

  if (process.argv.includes('--check')) {
    console.log('\nCheck only — nothing written.');
  } else {
    const dir = fileURLToPath(new URL('../build/', import.meta.url));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'engine.gs'), out);
    console.log(`\nWrote build/engine.gs`);
  }
}
