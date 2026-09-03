# Changelog

Versions are tagged `v1.2.3` and released on GitHub. Your copy's version is in
`package.json`, and every run writes it into the `log` tab of your sheet.

To move your copy to a newer version, see
[Updating](README.md#updating) — your configuration lives in the sheet, not in
the repository, so an update is an ordinary merge.

This project follows [Semantic Versioning](https://semver.org). For a job
watcher, that means:

- **Major** — something in your sheet needs changing by hand, or a run will
  behave differently in a way you would notice.
- **Minor** — new tabs, columns, settings or commands. Safe to take; you may
  need to run `setup` in `apply` mode to add what's new.
- **Patch** — fixes only. Always safe to take.

## 2.0.0 — 2026-09-01

The whole tool is now a Google Sheet. There is no repository to clone, no web
app to deploy, no credentials to copy, and no GitHub account.

### Setting it up

- Make a copy of the spreadsheet, open the menu, click **Start here**. Three
  steps, down from ten.
- Everything that could go wrong in the old setup — the deployment URL, the
  access setting, "Execute as", saving before deploying, a Workspace policy —
  is gone, because there is nothing deployed.

### Running it

- A daily run is a trigger the script owns. It fires whether or not the sheet
  is open, at your hour **in the spreadsheet's timezone** — the one under *File
  → Settings → Time zone* — so there is nothing to set in the script editor. It
  does not switch itself off after sixty days of quiet, which the previous
  schedule did.
- The schedule is one single-shot trigger armed for an exact moment, which arms
  the next when it fires. A moment has no timezone to misread, and recomputing
  daily means daylight saving is picked up on the day rather than approximated
  from a stored offset. A copy carrying the older daily trigger converts itself
  on that trigger's next fire; there is nothing to redo.
- Digests go to email or Discord, set from the menu rather than from a
  properties screen nobody opens.
- The menu says what each item does in the words the sheet uses. "The watch"
  was a word for this program that appeared nowhere a person could see; the
  menu offered to refresh a "catalogue" and filled a tab called `directory`;
  and "missing" meant job postings in one item and spreadsheet columns in
  another, four apart. A message also sent people to "Set up the workbook", an
  item that had not existed for some time.
- The 352 companies travel inside the file, so a first run works with no
  network beyond the job boards themselves. A refresh from upstream is an
  improvement on that, never a precondition.

### What it asks for

- The manifest pins four scopes: this spreadsheet only, outbound requests, send
  mail, and run on a schedule. Left to itself Apps Script infers them by
  scanning for service names, cannot follow the `globalThis` the bundler emits,
  and errs wide — which is why the consent screen used to ask for every
  spreadsheet in the account. Pinned scopes are a ceiling Google enforces.
- No `GmailApp` and no `DriveApp` anywhere: nothing can read a message or reach
  another file. `SECURITY.md` lists every host the program can contact, and the
  build is reproducible, so the claim is checkable rather than promised.

### What a job posting cannot do

Everything on the matches tab is text somebody else wrote. Four things it could
do, and no longer can:

- **Become a formula.** `setValues` evaluates a leading `=`, so a posting
  titled `=IMPORTXML(...)` became a live formula in the sheet of whoever
  watched that board — and IMPORTXML fetches with no click. Values are now
  quoted with Sheets' own force-to-text prefix at the last line before a cell.
- **Break out of the digest.** The mail escaper did not cover quotes, and sat
  inside an `href` attribute.
- **Choose the host.** Recruitee builds `https://<slug>.recruitee.com`, so an
  unchecked slug addressed wherever it liked. Slugs are validated in all six
  adapters; all 352 catalogue entries pass.
- **Relabel a link.** A title carrying `](` rewrote the Discord link it sat in.

### The sheet explains itself

- Every column header carries a note saying what the column is for. The help
  text existed all along and reached nobody: it was rendered by a function with
  no callers, so somebody wondering what a column did had nowhere to look.
- `title-hint` in particular now says the surprising part out loud — it gates
  your `body` rules and finds nothing on its own.

### Under it

- One engine, two runtimes: the matching, scoring and parsing are the same
  source the tests run on Node, flattened into a single Apps Script file by
  `src/bundle.js`.
- Updating is by hand now: paste the newer `Code.gs` over your script and
  run **Add anything missing**. The version you are running is in the `What
  ran` column of every log row.

## 1.0.0 — 2026-08-29

First public release.

### What it does

- Watches company job boards on six ATS platforms — Greenhouse, Lever, Ashby,
  Workable, SmartRecruiters and Recruitee — and writes matches to a Google
  Sheet.
- Everything you're looking for is defined in the sheet: companies, title and
  body rules, salary floor, locations, exclusions. No code is edited to
  configure a search.
- A catalogue of 352 companies, ticked on and off from a `directory` tab. Every
  entry answered a live request when it was built; a name that resolved nowhere
  is recorded in `unlisted` with the reason rather than listed and left to
  disappoint. None of the Fortune 50 made it — they run Workday and iCIMS,
  which this cannot read.
- Four starter rule sets — `data`, `gtm-revops`, `product-design`,
  `software-engineering` — to start from rather than a blank sheet.
- Scoring you can retune: every weight is a row in the `settings` tab.
- Long-open postings can be dropped rather than shown. A req open for months is
  often a pipeline posting rather than a real opening — but not always, so
  `stale postings` ships set to `keep` and the day count is yours to pick.
- Runs on GitHub Actions on whatever schedule you set, or on demand from a menu
  inside the spreadsheet itself.
- Optional Discord and email notifications.

### What it does not do

- No language model runs at any point. Matching, scoring and ranking are
  ordinary code, so a run costs nothing per posting and needs no API key.
- Nothing is written back to this repository. The sheet holds all state.

### Working with the results

- `Status` and `Note` columns are yours; nothing overwrites them. The one
  exception is a posting that disappears from its board, which is closed
  automatically — and only while the row still reads `Not reviewed`.
- A `dropped` tab records what was filtered out and why, so a search that
  returns nothing can be diagnosed.
- A `Changed` column reports what moved on a posting you have already seen.
- Diagnostics — `check`, `explain`, `suggest`, `learn` — answer "why did
  nothing match?" and "what am I missing?", and write their output into the
  `log` tab where you can read it.

### Keeping it current

- Versions are tagged and released. Your copy's version is in `package.json`,
  `check` prints it, and every run writes it into the `log` tab, so "how far
  behind am I?" has an answer a template copy's git history cannot give.
- Updating is an ordinary merge: no workflow writes to the repository and all
  configuration lives in the sheet, so your copy never diverges from upstream.
  See [Updating](README.md#updating).
