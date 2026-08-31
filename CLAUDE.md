# job-watch-gsheet

This repository is the spreadsheet. The engine is ordinary JavaScript tested on
Node, and `src/bundle.js` flattens it into the single Apps Script file people
paste into a Google Sheet.

**The rules that matter most here**

- `dist/Code.gs` is generated. Never edit it; run `npm run build` and commit the
  result. A test rebuilds and compares, because a committed artefact that has
  drifted from its sources is worse than none.
- The tests run against the built file, not the sources. A build step that
  flattens scopes and strips async is exactly where a program quietly becomes a
  different one.
- `src/gas/fake.js` must keep agreeing with Google. It returned empty strings
  where Sheets returns `FALSE` for an unticked checkbox, and that one difference
  put 352 rows below row 1000 of a tab that looked empty. When a real run
  disagrees with the fake, fix the fake first so it reproduces the bug, then fix
  the code.
- Apps Script has one global scope. Two files declaring the same top-level name
  collide, and the bundler refuses the build — that has caught three real
  duplications, and each time the answer was to share one definition rather than
  rename.
- Never lower `REQUEST_DELAY_MS`. It protects somebody else's API.
- Never regenerate `data/directory.json` by hand. `npm run prospect` probes and
  `npm run catalogue` merges; a board that answers is not proof it is the
  company you meant, which is what `data/rejected.json` records.

---

## Design rules

- **No LLM at runtime, ever.** Scoring, the feedback loop and the debugger are
  arithmetic and pattern matching. Nobody who installs this should pay tokens to
  run it. Building it with an LLM is fine; shipping one inside it is not.
- **The sheet is the only source of truth for configuration.** JSON files exist
  solely as opt-in starter templates. Never treat one as live state — v1 had two
  sources and the merge rules needed a page of documentation.
- **The engine must produce zero matches on empty config.** That's the test that
  no domain assumptions have crept back in. If a preset is required to get
  results, something is hardcoded that shouldn't be.
- **User-owned spreadsheet columns come first, structurally.** Put them at the
  left so every script write targets a contiguous range starting to their right.
  The sync should be physically unable to clobber a user's edits, not merely
  careful about it.
- **Zero dependencies is deliberate.** Sheets auth is a hand-rolled
  service-account JWT rather than `googleapis`. Don't add a dependency without
  asking.
- **Nothing in this codebase clears or deletes a cell.** The transports accept
  exactly three operations — `addTab`, `writeRange`, `formatTab` — and refuse
  anything else by name. Where a tab needs replacing wholesale (`dropped` is
  rewritten each run), do it by writing over the range and padding the tail
  with blanks. Don't add a clear operation to make that tidier: the refusal is
  what makes "setup is safe to re-run" true rather than merely intended.

## Where a job is done

Ashby, Lever, Workable, Recruitee and SmartRecruiters all carry a structured
remote flag beside a location string, and the two disagree constantly — a
ClickUp posting reads "San Diego" with `isRemote: true`, meaning a remote role
owned by that office.

v1 and early v2 both read that flag only when the location string was empty
(`j.location || (j.isRemote ? 'Remote' : '')`), which threw away the
authoritative answer exactly when it mattered. A remote-only filter then
dropped every remote job at any company with an address. v1 hid it by watching
ninety companies, most on Greenhouse, whose location text says "Remote" in
words.

Adapters now publish `remote` as a tri-state — true, false, or null where the
board doesn't say — and `place()` makes the location text agree with it. The
matcher takes the flag first and falls back to text, so Greenhouse still works
and a posting whose flag is unset can still get in on its location.

`getJSON` takes an injectable `fetchImpl` so an adapter can be run against a
captured payload. Before that, the mapping from a board's JSON to our shape was
the only layer here with no offline test, which is precisely where this bug
lived.

## The location allowlist

Entries compile through `compileList`, the same path as every other rule, so a
phrase matches whole words and `/us|usa/` works. Plain substring matching was
quietly wrong in both directions: `us` is inside Australia and Austria.

A location naming no geography — "Remote", "Anywhere", or nothing at all —
passes any allowlist. There is nothing there for it to reject, and an
unrestricted remote role is the one most worth seeing. `statesAPlace` decides
by stripping the remote vocabulary and seeing what survives.

A city is still outside a country allowlist: "San Diego (Remote)" does not
match "united states". That is inherent to matching free text, and the fix is
the user's list, not a built-in gazetteer — `npm run explain` shows exactly
which postings the filter is costing them.

## Before touching extraction code

**Run `npm run diagnose` against a real board first.** Job boards serve markup
in shapes their docs don't mention. Two live examples, both of which silently
produced "no salary listed" on postings that plainly stated a range:

- **Greenhouse** entity-encodes the markup itself — a paragraph arrives as
  `&lt;p&gt;`, and some fields are escaped twice. A tag-stripping regex finds no
  literal `<`, does nothing, and then entity replacement shreds `$100,000` into
  `$ span data-sheets-root= 1 100,000`.
- **Lever** splits a posting across `description`, `descriptionBody`, `lists[]`
  and `additional`. Compensation lives in `additional`. Reading only
  `description` captures company marketing and no pay data.

Both are pinned by fixtures in `src/boards.test.js`. The lesson generalises:
dump one real payload and read it before building anything on a parser. In v1
five features were built on an extraction layer that had never been fed a real
input, and the bug was months old before anyone looked.

## The two backends must store a value identically

`escapeCell` in `transport.js` and `writeRange_` in `apps-script/Code.gs` are
the same rule written twice, and they have to stay that way. The REST API's
RAW mode keeps everything as text; Apps Script's `setValues` parses what it is
given. Left alone, that divergence corrupts data rather than merely looking
untidy: a date coerced to a real date cell reads back through
`getDisplayValues` in the sheet's locale, so `2026-08-01` returns as
`01/08/2026` on a non-US sheet, which `Date` parses as 8 January — a row seen
last week looks 200 days gone and gets closed.

So: numbers are left to parse (a Score column sorting as text puts 9 above
62), dates are forced to text, and anything starting with `=` is forced to
text — a job title beginning with one is otherwise a formula, and on a shared
sheet, an injection. A test reads `Code.gs` and checks the two copies have not
drifted.

## Talking to the sheet

Two backends behind four verbs (`listTabs`, `headRows`, `getValues`,
`applyOps`) in `src/sheet/transport.js`. Nothing above that file knows which is
in play.

- **Apps Script** — a container-bound web app (`apps-script/Code.gs`). Four
  steps, all inside the spreadsheet. This is the recommended path: v1 lost a
  session to `iam.disableServiceAccountKeyCreation`, an org policy that follows
  the *project*, so switching Google accounts doesn't clear it — the project has
  to be recreated outside the org. Apps Script never touches Cloud at all.
- **Service account** — the Sheets REST API. Access scoped to one file, at the
  cost of six steps across three consoles. The Sheets API must be enabled on the
  *same* project that owns the key.

`src/sheet/memory.js` is a third implementation of the same interface: an
in-memory spreadsheet, deliberately strict (writing to a tab that doesn't exist
throws, as it would against the API). It's what makes the round trip testable —
`npm run setup -- --demo` builds the whole workbook with no account and no
network, and the tests assert the properties that only exist across the full
loop, like "a re-run leaves a triaged row alone".

## Reading the sheet back

`src/sheet/read.js` is the forgiving direction. Everything it parses was typed
by a person into a grid, so it holds two rules:

- **Never crash on input.** A value that can't be understood becomes a reported
  problem plus a documented fallback. A typo in one settings row must not stop
  the run that would have surfaced today's jobs.
- **Never invent a rule.** Fallbacks fill in numbers and modes, never patterns.
  A blank sheet still matches nothing.

Columns are found by header text, falling back to schema position, so inserting
a column doesn't shift every field one to the left.

The settings spec lives on the seed rows in `schema.js`: each row carries its
own `key`, `type` and default next to the help text the sheet displays.
`seedRow` reads only the column keys, so the extra fields never reach the
spreadsheet — which is what keeps the parser and the documentation from
drifting apart.

`npm run check` prints the whole compiled configuration and every problem
found. It's the first thing to run when a sheet edit doesn't seem to have
taken.

## Salary

`src/salary.js` returns one band per posting: OTE where the posting states it,
base otherwise, with `kind` and `basis` recording which and how it was read. A
figure nobody can trace is a figure nobody can correct.

- **An unqualified range is base.** Postings that mean OTE nearly always say
  so, because the number flatters them. Under-promising is the right failure
  direction for a filter.
- **Two unqualified ranges: take the lower.** Guessing that the higher one is
  the OTE reads well in a test and inflates every posting in production.
- **Figures are labelled by their clause, not by a window.** A fixed window
  either side of a figure reads markers belonging to the next one: in
  "$120k–150k, and with commission $200k–240k" a 90-character window swallows
  "with commission" and labels the base range as OTE. `clauseAt` is the fix and
  `src/salary.test.js` pins the regression.
- **`unknown` is a verdict, not a failure.** Whether an unpriced posting is
  worth seeing is the user's call — the settings tab asks them.

The base path is verified against a real payload (the Grafana fixture is
verbatim from the live board v1 failed on). **OTE labelling is not** — those
cases are constructed from how postings are written, which is the kind of test
that passed in v1 while the parser returned nothing on real input. `npm run
diagnose` prints what the parser read, the ranges it found, and the clause each
was labelled from; run it against a posting quoting both before trusting a
figure marked OTE.

## Discovery

`src/discover.js` probes boards to turn a typed company name into an ATS and
slug. Everything decision-shaped in it — which candidates, in what order, what
to write back — is a pure function, and the probe is injected. A real run is
minutes long by design, so a logic bug found by running it for real costs a
minute per attempt.

- **A board that exists but has no postings is a miss, not a hit.** An empty
  response is indistinguishable from a wrong slug, and recording it would
  quietly retire a company that is hiring.
- **A board belonging to someone else cannot be detected here.** Slugs are
  first-come-first-served: `gong` on SmartRecruiters is a media startup in New
  York, not the revenue-intelligence company, and it returns a healthy list of
  jobs that looks exactly like a correct hit. No heuristic available offline
  separates them — comparing the board's own name fails too, because the wrong
  company is often genuinely called that. So discovery prints three sample
  titles and the board URL on every resolve, and asks the person to look. Don't
  replace that with a cleverer guess.
- **A failed probe is a miss, not an error.** An outage and a wrong slug look
  identical from here. The row stays unresolved and the next run tries again,
  rather than a blip writing a wrong answer into the sheet.
- **Don't lower `REQUEST_DELAY_MS`.** It walks up to six boards per company;
  the delay is what keeps a free API from blocking the runner's IP.

## Reads and writes must agree about where a column is

Reads locate columns by header name. Writes must too, or the two disagree the
moment someone inserts a column of their own — and the sync then overwrites it.
`resolveWriteRange` derives the write range from the sheet's actual header row
and refuses when no safe range exists (a script column missing, or a user
column sitting inside the block). Refusing beats writing to the wrong place,
and `planSync` returns that refusal as a problem the watch prints.

`readRange` reads wider than the schema for the same reason. Reading exactly
the declared width meant one inserted column pushed `Key` outside the read,
every row then looked keyless, and every posting re-appended on every run. A
sheet created here starts with 26 columns, so Z is safe to ask for and roomy.

Both bugs are the same mistake in two directions: trusting the schema's column
order to describe a spreadsheet a person can edit.

## The run log

Every command appends a row to the `log` tab: when, what ran, how it went, and
everything it printed. `recorded()` wraps each entry point and `teeConsole`
captures the output without swallowing it, so the Actions log still works —
which is where you go when the sheet itself is the problem.

Two silences it removes. A scheduled run that fails is otherwise invisible
from the sheet: you would have to visit another website to learn that this
morning's watch never happened. And the diagnostics — check, explain, suggest,
learn — exist entirely for what they print, so a menu item that sent their
answer to GitHub was a button that appeared to do nothing.

- **Logging never throws and never fails a run.** A record of what happened is
  worth less than the thing that happened.
- **`check` and `explain` were restructured to return rather than
  `process.exit`.** An early exit would skip the row that carries the output
  into the sheet, which is the whole point.
- Detail is truncated at 45,000 characters and says so — a cell holds 50,000
  and rejects more.
- The log only grows; nothing here deletes rows. A few rows a day is the
  intended volume.

## Protection

`protectedBlocks` marks the columns nobody should be typing into, and
`formatTab` carries them. Applied when a tab is created; `npm run setup --
--reformat` re-applies them to a sheet an earlier version made.

**Warning-only, always.** On a sheet you own, a protected range cannot stop
you — you click through. A lock that pretends otherwise is worse than a
warning that doesn't, because it teaches people the tool is lying. What it
does stop is the accident: a select-all-delete, a stray paste, and anyone the
sheet is shared with.

What is protected, and why each:

- `settings` — the names and the help, not the values. It is a form: the left
  and right columns are the question, the middle is the answer.
- `directory` — everything but `Add`. The catalogue is shipped content the
  tool refreshes, so editing it is work that gets overwritten and deleting a
  row is undone on the next sync.
- `matches` — `Key` alone. It is the one cell where a stray delete costs work
  silently.
- `rules`, `companies`, `dropped` — nothing. Those are the user's own.

Protections are replaced rather than added, keyed on a `job-watch`
description, so re-running setup does not stack a duplicate range each pass —
and a protection somebody set themselves is left alone.

## What a deleted cell costs

Nothing here breaks permanently, but two edits cost work and one of them used
to say nothing.

Deleting a row from `matches` loses the triage on it — the posting re-appends
as new. That is inherent: the sheet has no memory of a row that is not there.

Clearing the `Key` cell is worse, because it is silent. The row can no longer
be recognised, so the posting re-appends as a *second* row while the original
sits unchanging with someone's status and note on it, looking live. `planSync`
now reports it with the row number and what to do, the same way it reports a
duplicated key.

Note the asymmetry between the two catalogues: deleting a row from `directory`
is undone on the next sync, because it is shipped content the tool owns.
Deleting one from `companies` is permanent, because that list is the user's.
The two look like the same action and are not.

## The one place a user column is written

Everywhere else, script writes start to the right of every user column, so
clobbering typed text is impossible rather than avoided. Closing a stale row
breaks that: Status is the leftmost column, user-owned, and "mark it Closed
after 7 days unseen" cannot be done without writing it.

`planClosures` in `src/sync.js` is that exception and the only one. It writes
one cell, `A{row}`, never a range, and only when the cell currently reads
exactly the untriaged default — so a row anyone has touched is never written
to, whatever its age. The guard reads the sheet's current value rather than
what the last run wrote, so a row triaged between two runs is still safe.
`src/sync.test.js` asserts that exactly one operation in a full plan touches a
user column, and that it is that one.

Don't add a second exception. If something else needs to write a user column,
the column is in the wrong place.

## The directory

A catalogue of companies that hire remotely, shipped in `data/directory.json`
and seeded into its own tab. `Add` is the only cell in it anyone types into,
and it is the leftmost column, so a refresh writes B onwards and cannot reach
it. A tick survives every update, including one that rewrites every other cell
on its row.

- **Rows are matched by company name, never by position.** Someone sorting or
  filtering the tab must not cause a row to be rewritten with another
  company's details.
- **Enabling copies; it does not link.** Once a company reaches the companies
  tab it is an ordinary row the user owns — rename it, switch it off, correct
  its slug, and nothing here argues. Un-ticking `Add` later does not remove it,
  because by then it may be a row they have edited.
- **The catalogue carries no personal flags.** v1's list marked companies
  excluded or disabled; those are one person's choices, not facts about the
  company, and whether to watch one is what `Add` is for.
- **Descriptions describe the company, not the board.** v1's notes mixed the
  two ("Remote-first infrastructure software — no supported ATS found
  (acquired by IBM…)"). The board half is compressed to a parenthetical and
  the ATS left blank, which is what a reader needs.

The watch enables ticked rows before it fetches anything, so a tick takes
effect on the next run rather than the one after. A failure there is caught:
the catalogue is a convenience and must not cost the run.

## Importing companies

`src/import.js` reads CSV or JSON and appends to the companies tab. Matching is
on the name, case-insensitively and with punctuation stripped, because
"Apollo.io" and "Apollo io" are the same company to everyone except a string
comparison.

- **Entries a file marks excluded or disabled are dropped, not imported.** A
  company someone deliberately switched off should not reappear because they
  changed tools. v1's `companies.json` is one of the shapes this reads, and it
  carries seventeen of them.
- **Verified is left blank.** An import has not verified anything; only
  discovery reaching a live board earns that column.
- **An unsupported ATS is blanked and reported**, not carried across, so
  discovery gets a clean run at it rather than inheriting a value nothing can
  use.

## Templates

A template is a starting point, not a configuration. `src/template.js` appends
its rules to the rules tab as ordinary rows and stops. There is no "applied
template" state anywhere and nothing remembers which was used — a preset that
lives on as a hidden layer is a second source of truth, and v1's two sources
needed a page of documentation to explain.

- **Appending only.** A template never overwrites or removes a rule. A pattern
  already in the sheet is skipped, so running one twice is a no-op and running
  two is a union.
- **Comparison is on the pattern text as written.** Two rules that happen to
  match the same postings are still two rules; deciding otherwise would mean
  silently dropping something someone typed.
- **Templates add rules and nothing else.** A template file may state a
  location mode, but importing it does not change settings. Rules are additive
  and reversible by deleting a row; settings are neither.

`src/templates.test.js` checks each template against the roles it exists for,
the neighbouring families it must not drag in, and every other template's
catches. A preset that quietly claims another family's roles is worse than one
that misses: the user sees plausible results and never learns the rule is
wrong.

## The dropped tab

It answers one question: are the filters too tight? So everything a filter
*cost* belongs in it — a posting rejected for its location as much as one under
the salary floor, and an exclusion that killed a would-be match as much as
either.

Only salary drops used to land there. A run that rejected five postings on
location left the tab empty, which reads as "the filters are fine" when the
opposite is true.

A posting no rule matched is **not** dropped: nothing filtered it out, it
simply wasn't wanted. Those are `npm run suggest`'s business, and putting them
here would bury the handful of rows that matter under everything the board
happens to be advertising.

`matchJob` collects signals before checking exclusions for this reason. The
exclusion still wins — a user who excludes "account executive" sees it gone,
not demoted — but the verdict can now say `matched "staff engineer", then
excluded by "contract"`, which is the only way an over-broad exclusion ever
becomes visible.

## Suggesting rules

`src/suggest.js` counts recurring phrases in the postings no rule matched. The
first live run had 101 of 117 postings matching nothing — the matcher was
seeing six times more than it said anything about, with no way to find out
what.

- **It proposes, never applies.** A phrase recurring twelve times might be the
  role the user wants or the one they would never take, and nothing in a
  frequency table separates those. Printing a suggested rule is the whole
  feature; writing one would be a guess wearing a decision's clothes.
- **Phrases are grouped by length, not merged.** Overlapping n-grams cannot be
  ranked against each other honestly: "engineer" outnumbers "backend
  engineer", which outnumbers "senior backend engineer", and every scheme for
  collapsing them buries either the general phrase or the specific one. Three
  short lists say more than one clever one.
- **A phrase already covered by a rule is never suggested back**, including by
  a regex rule — coverage is tested by running the rule against the phrase, so
  `/backend.*engineer/` suppresses "backend engineer".
- **One posting is not a pattern.** Nothing below two occurrences is shown.

## What changed

The watch sees the same posting every day and used to silently overwrite
yesterday's row with today's. `describeChange` compares the fields worth being
told about — title, salary, location, posted date — before the row is
rewritten. A band going up on a live req exists nowhere else: only someone
holding a daily snapshot of that board can see it.

`lastSeen` and `age` are deliberately not compared. They move every run and
reporting them would bury the ones that matter. A field appearing for the
first time is not a change either — a posting becoming priced is news, but it
is not a movement from blank.

A change is worth a notification even though the posting is not new. Arguably
more so: it is already known to be real.

## Where the pay sits

`payRank` returns null below eight samples. A percentile drawn from four
postings is a number pretending to be information, and a blank cell is better
than a confident wrong one. The population is every priced posting the sheet
has ever held, not just today's — one day is too few to say anything.

## Learning from triage

`src/learn.js` counts the difference between what the user kept and what they
passed on. Like everything else here it is arithmetic, and like `suggest` it
proposes and never applies.

- **It refuses below five judgements on each side.** A rule drawn from three is
  superstition with a percentage attached, and the refusal is the feature.
- **A phrase appearing on both sides is not reported.** Only one that appears
  in what someone passed on and never in what they kept says anything.
- **Counts, not scores.** "6 of 8 you passed on, none of the 9 you kept" is the
  evidence; a single number would hide how thin it might be.
- **A salary floor is only suggested if it would actually have cut something**
  — and the report says so plainly when pay is not what separates them.

## Notifications

Optional, and silent when unconfigured. A tool that refuses to run because
nobody set a webhook has confused its output with its purpose — the sheet is
the record, this is a convenience.

- **Only genuinely new postings.** `planSync` returns `addedRecords` for this
  reason. A digest that re-lists everything still open gets muted within a
  week, and a muted notification is worse than none: it trains the reader to
  ignore it.
- **Sent after the sheet is written**, never before. Announcing something that
  then failed to save is worse than staying quiet.
- **Nothing here throws, and one dead channel does not stop the others.** A
  broken webhook must not cost a run that already fetched every board and
  wrote the sheet.
- **Email goes through the Apps Script**, which is already bound to the sheet
  and already runs as its owner. That means no mail service, no second
  credential, and nobody else holding the user's job search. `MailApp` allows
  roughly 100 sends a day on consumer Gmail.
- **Telegram uses HTML, not MarkdownV2.** MarkdownV2 needs fifteen characters
  escaped and a stray bracket in a job title fails the entire send.
- **A half-configured channel is named, not skipped.** A bot token with no chat
  id is a mistake someone made, and silence would look like the feature not
  existing.
- **Ranked by score**, because a digest that ignores the ranking is the sheet
  in a worse format.
- Discord rejects the entire POST past 2000 characters, so the message sheds
  postings from the end until it fits. The headline and the sheet link always
  survive.
- `allowed_mentions.parse` is empty: a job title containing `@everyone` must
  not be able to ping a server.

## Scoring

Arithmetic, never a model. A score nobody can reproduce by hand is a score
nobody can argue with, and the weights live in the settings tab so disagreeing
with one is a spreadsheet edit rather than a commit.

A signal the user hasn't configured scores 0.5 — neither rewarded nor
punished. Scoring it 0 would push every posting down over a setting nobody
filled in; scoring it 1 would make the number meaningless. `scoreJob` returns
the parts alongside the total, and they sum to it, so the debugger can show
its working.

## Nothing is scheduled by default

There are two ways to run the watch daily — the workflow's cron and an Apps
Script trigger — and they cannot see each other. Shipping either one on would
mean the other silently doubles it, and a template repository's schedule is
live from the moment someone creates from it, since a template is not a fork.
So `watch.yml` ships with its `schedule:` block commented out, and turning on
either is a deliberate act. A test asserts no schedule is active.

## Triggering from the sheet

`Code.gs` carries a menu that starts the workflows through GitHub's
workflow-dispatch API, and a time-based trigger that owns the schedule.

- **The schedule belongs in Apps Script, not in cron.** GitHub's cron has no
  timezone, so a fixed UTC time drifts an hour twice a year when the clocks
  change. Apps Script triggers run in the spreadsheet's timezone and follow
  DST. Only one of the two should be active or the watch runs twice.
- **Dispatching must never be reachable from `doPost`.** The web app is
  deployed to "Anyone with the link" and the token it would use has
  Actions: write. It is a menu action, run as the sheet's owner from the
  editor, and there is no case for it in the request handler. A test asserts
  that.
- The menu names workflow files, so renaming one breaks a button with no error
  until someone clicks it. A test checks every name it references exists and
  accepts a manual dispatch.

## Running out of room, and running twice

Google's default grid is 1000 rows and 26 columns, and both backends throw
rather than growing when a write passes either. `Code.gs` grows the sheet to
fit; the REST path turns the grid-limit error into something that says what to
do. A watch running for a year reaches this.

Every workflow that writes shares a `sheet-write` concurrency group. Two runs
would otherwise both read first and then both append from the same row, and
the second would overwrite the first. Read-only workflows are deliberately
outside the group so a diagnostic never waits on a watch.

## `node --check` is not a test

It validates syntax and nothing else. It accepts a reference to a variable
that was never declared, which is how `ReferenceError: REFORMAT is not
defined` reached a live workflow — the edit that added the flag matched
nothing, the check passed, and the unit tests never execute the top of a
script.

`src/commands.test.js` runs every command for real, with no credentials, in a
mode that touches nothing. That exercises argument parsing, constants and the
whole startup path, which is where this class of mistake lives. The command
list is discovered from the directory rather than written out, so a new
command cannot skip the check by not being added to an array.

It also asserts every command exits non-zero when it cannot do its job.
Wrapping the commands for the run log replaced their `process.exit(1)` calls
with a returned outcome, so `check` and `explain` began exiting 0 while
reporting a broken configuration — a workflow going green over a run that did
nothing is the exact silence the log was added to remove. `recorded()` sets
`process.exitCode` instead, which lets the log write finish first.

## A green local suite is not a green build

`data/directory.json` is content the code reads at runtime, and a `data/`
rule in `.gitignore` — inherited from v1, where that directory held runtime
state — kept it out of four commits. The tests passed here the whole time,
because the file was on one machine and not in the repository, and CI was red
for all four. Don't re-add that rule.

**Check the test workflow after pushing.** `npm test` locally proves the code
works where it was written. It says nothing about what actually reached the
repo, which is the only thing anyone else runs. `src/edge.test.js` now asserts
that the files the code reads are tracked by git, but a habit would have
caught it four commits earlier than a test did.

## Workflow

- `npm test` after any change to `src/`.
- `npm run check -- --demo` and `npm run setup -- --demo` exercise the full
  round trip with no account;
  `-- --dry-run` against a live sheet to list operations before applying them.
- `npm run explain` when a run returns less than expected. It reports where
  each posting was rejected and names the largest cause. "No matches" has half
  a dozen indistinguishable causes; guessing between them wastes a day.
- `npm run diagnose <ats> <slug> [jobId]` to inspect a live board.
  `RAW=1` dumps the untouched API object.
- ATS hosts are blocked from many sandboxed environments. If every request
  fails, run on CI rather than concluding the board is down.
