# Reporting a problem

If you have found a way to make this do something it should not, please report
it privately rather than opening an issue: **Security → Report a vulnerability**
on this repository. That reaches the maintainer without the report being public
while it is still exploitable.

Please include what you did and what happened. A job title, a slug or a
catalogue entry that misbehaves is enough — you do not need a working exploit.

## What counts

This runs inside a person's own spreadsheet, under their own Google account, so
the interesting question is always the same one: **can text that somebody else
wrote make the script do something its owner did not ask for?**

Everything on the `matches` tab came from a public job board that anybody can
post to. Job titles, locations, company names and URLs are all attacker-chosen
in the ordinary case. So these are in scope:

- A posting that makes something evaluate — a formula in a cell, markup in a
  digest, markdown that relabels a link
- A slug, ATS value or catalogue entry that sends a request somewhere other
  than the board it names
- Anything that reads or writes outside the spreadsheet the script is bound to
- Anything that discloses the digest destination or the webhook URL
- A run that can be made to hang or fail permanently by a crafted posting

Out of scope: the "unverified app" consent screen, which Google shows for every
script anybody writes for themselves; and what a person can do to their own
sheet, which is theirs to break.

## Known, and accepted

**A crafted posting can hang a run.** Rules on the `rules` tab are regular
expressions, and Apps Script has no way to run one with a timeout. A posting
written to trigger catastrophic backtracking in a rule you wrote can exhaust
the six-minute execution budget. The run fails, says so in the `log` tab, and
the next one is unaffected — no data is lost or disclosed — so this is recorded
rather than fixed.

**Anyone you give edit access to your sheet can read the script.** A bound Apps
Script belongs to the spreadsheet: an editor can open it, read the code, read
its stored properties — including your digest destination — and change it.
Share as **Viewer** unless you mean to hand somebody that. This is how Google
Sheets works and is not something this script can override.

## What this program sends, and where

Everything it can talk to, in full:

| Host | Why |
| --- | --- |
| `boards-api.greenhouse.io`, `api.lever.co`, `api.ashbyhq.com`, `apply.workable.com`, `api.smartrecruiters.com`, `*.recruitee.com` | Reading the job boards you listed |
| `raw.githubusercontent.com` | Refreshing the company catalogue, only when you ask |
| `discord.com` / `hooks.slack.com` / `api.telegram.org` | The digest, only to a destination you set |

There is no analytics, no telemetry, and no server belonging to anybody who
wrote this. Your rules, your companies and your results never leave your
spreadsheet. You can check that claim rather than take it: search `Code.gs` for
`http` and the list above is all of it.

## Verifying what you pasted

`Code.gs` is generated from `src/`, and the test suite fails if the committed
file is not what a fresh build produces. To confirm the file you are about to
paste is the code in this repository:

```bash
npm run build && git diff --exit-code Code.gs
```

Silence means the shipped file is the sources. No network access and no
dependencies are needed — there are none to install.
