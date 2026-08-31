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

## 2.0.0 — 2026-08-31

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
  is open, in the spreadsheet's timezone, so it follows daylight saving. It
  does not switch itself off after sixty days of quiet, which the previous
  schedule did.
- Digests go to email or Discord, set from the menu rather than from a
  properties screen nobody opens.
- The 352 companies travel inside the file, so a first run works with no
  network beyond the job boards themselves. A refresh from upstream is an
  improvement on that, never a precondition.

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
