# job-watch

Find your next job. All from a Google Sheet.

You select what you're looking for - titles, salary, remote or not - and what 
companies you'd work for.

Every day it reads the companies' job boards and writes what it found into your 
sheet: scored, ranked, salary pulled out of the posting, and 
a note when something changes on a job that's still open.

**Now, you can easily track openings at specific companies and get alerts 
when they're hiring for your dream role.**

**It is a spreadsheet.** No account to make, no service to sign up for, no
subscription. Nothing runs on anybody's server but Google's, and no language
model runs at any point — matching and scoring are ordinary code, so a run
costs nothing and needs no API key.

- 352 built-in companies to pick from to get started,
  every one checked against a live board (and you can add as many as you want)
- Six job board platforms: Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee
- Runs itself daily, in your timezone
- Digests/alerts sent to you email or Discord, if you want them

---

## What's in this repository

This repository has more than everything you need.

Simplest setup, you can just copy a Google Sheet template, which includes the App Script built-in, and be off and running.

But if you want to go wild, I've included everything 

### Easy Setup

Open the Google Sheets template link, choose *File → Make a copy*, and skip to *Setting it up* below.
The code is already inside the copy.

https://docs.google.com/spreadsheets/d/17eJWRWQrl2MsuWSmGX5WzVvfxNdjlTZsU6fGHZNGHFA/edit

See further details below in the **Setting it up** section.

Note - if you're not signed into a Google account at the time, you won't be able to save a copy to your Google Drive.

### Harder Setup

If you are here to set the sheet up yourself, one file matters:

| | |
| --- | --- |
| **`Code.gs`** | **The whole tool.** Paste this into *Extensions → Apps Script* in a blank Google Sheet, save, then reload the sheet. |
| **`appsscript.json`** | **The permissions.** Paste this over the script's manifest so it asks for four narrow scopes instead of the wide ones Apps Script guesses at. See *What it asks for*. |

Those two files are the whole install. Nothing else here has to be
downloaded, installed or run.

The rest is what that file is built from, kept here so it can be read, checked
and rebuilt:

| | |
| --- | --- |
| `src/` | The engine — job board adapters, matching, scoring, the sheet client — plus its tests. `npm run build` flattens it into `Code.gs`. |
| `data/` | The company catalogue: 352 employers with a verified board, and a record of the ones that were checked and didn't have one. |
| `templates/` | The starter rule sets *Start here* offers — the titles and keywords a role tends to use. |
| `build/` | Scratch output from `npm run build`. Not committed. |

`Code.gs` is generated: edit `src/`, run `npm run build`, and commit the
result. Editing `Code.gs` by hand means the next build overwrites you.

---

## Setting it up

**1. Make your own copy.** Open the Google Sheet template link and choose
*File → Make a copy*. The whole tool comes with it.

**2. Open the menu.** Reload the copy and a **Job watch** menu appears next to
Help. The first thing you click will ask for permission. Read *What it asks
for* below before you agree — the short version is that it can touch this one
spreadsheet and nothing else in your account, and that it can send mail but
cannot read any. The warning that the app is unverified is Google saying
nobody has reviewed a script that belongs to you, which is true of every
script anyone writes for themselves.

**3. Click *Start here — set everything up*.** Pick the starter rules closest
to what you do — `software-engineering`, `gtm-revops`, `product-design`,
`data`, or `none` to write your own. It builds the tabs, loads the rules,
fills the catalogue, and tells you what to do next.

That's it. There is no fourth step.

---

## What it asks for

Authorising a script means handing it part of your Google account, so here is
the whole of what this one gets. The four lines below are pinned in the
script's manifest, which means Google *enforces* them: a call to anything
outside this list fails, whatever the code tries.

| Google shows you | What it is | What it is not |
| --- | --- | --- |
| See, edit, create and delete **only the specific spreadsheet** you use with this app | `spreadsheets.currentonly` — the copy the script lives in | Not your other sheets. The script has no way to name another workbook. |
| **Connect to an external service** | `script.external_request` — fetching the job boards | Nothing is sent anywhere. The requests are plain public reads of career pages. |
| **Send email as you** | `script.send_mail` — the digest, to the address you give it | **Not inbox access.** Reading mail is a different permission (`GmailApp`), and this script does not contain it. |
| **Run when you are not present** | `script.scriptapp` — the daily scheduled run | Only the schedule you set from the menu, and *Stop the daily run* removes it. |

The scopes, if you want to check them against the manifest yourself:

```
https://www.googleapis.com/auth/spreadsheets.currentonly
https://www.googleapis.com/auth/script.external_request
https://www.googleapis.com/auth/script.send_mail
https://www.googleapis.com/auth/script.scriptapp
```

Two things worth being clear about, because they are the reason a wide prompt
would be worth worrying about elsewhere and is not here:

**There is no other party.** The script runs inside your copy, under your
account, on your data. It is not talking to a server anyone operates. Nobody
who wrote it, distributed it or copied it can see your sheet, your rules or
your results, because there is nowhere for that to go.

**You can read every line before you agree.** *Extensions → Apps Script* shows
the entire program. That is a stronger guarantee than any job site gives you,
and the reason the permissions are worth reading rather than clicking past.

*Seeing a wider prompt than the table above?* Then the manifest is missing —
see *Updating* for how to put it back.

---

## Tabs overview

There are 7 tabs in the Google Sheet template:

| Item | What it does |
| --- | --- |
| **rules** | What kinds of job titles are you looking for and not looking for? |
| **companies** | Which companies' job boards do you want to search? |
| **matches** | Here are the relevant job postings we found for you |
| **dropped** | Here are the job postings that are not relevant for you because they don't meet your rules |
| **directory** | Here are 352 companies that you can add to your companies list easily if you want |
| **log** | Here's a log of the app's runs so you can troubleshoot and track if need be |
| **settings** | What are your job search parameters - salary, location, remote, etc. |

---

## Picking who to watch

Now that you're set up, let's go to the companies tab and figure out what companies we want to monitor.

**Start with the companies you already know.** Before opening the catalogue,
type some names into the `companies` tab off the top of your head — where
your friends work, your employer's competitors, the vendors you deal with,
anyone whose product you like. Leave ATS and Slug blank and run **Find boards
for new companies**; it works out where each one posts.

Expect around half to resolve. The largest employers run recruiting systems
this can't read, and it will tell you which ones.

**Then top up from the catalogue.** The `directory` tab lists 352 companies
whose boards were answering when the list was built, with a line on what each
one does. Tick `Add` on any row and the next run starts following it.

That list is better than any catalogue, because the reasons behind it are
yours.

---

## What are you looking for

Once you have some companies in the Companies section that are found, and, optionally, some other companies chosen
from the directory, now you need to set your preferences and settings.

Once you've gotten this part done, you can just straight-up run the watch by going to the job watch menu > **Run the watch now**.

### Rules tab

The `rules` tab is a list of patterns. A plain phrase matches whole words in
order, so `staff engineer` will **not** match "Staff Software Engineer". Wrap a
pattern in slashes for a regular expression when you want the wider net.

| Active | Kind | Pattern | Note |
| --- | --- | --- | --- |
| TRUE | title | `head of revenue operations` | |
| TRUE | title | `/staff.*engineer/` | regex, for a wider net |
| TRUE | exclude | `intern` | never show these |

### Settings tab

The `settings` tab holds everything else — salary floor, what to do with
postings that state no salary, remote-only, a location allowlist, how long
before a long-open posting counts as stale and whether to drop it, and the four
scoring weights. Each row explains itself; the middle column is the answer.

The "weight" options are how the app scores different job openings for you.

---

## The menu

| Item | What it does |
| --- | --- |
| **Start here — set everything up** | Tabs, starter rules, the catalogue, in one go. Safe to re-run |
| **Run the watch now** | The daily run, on demand |
| **Find boards for new companies** | Resolves companies you typed in by hand |
| **Refresh the company catalogue** | Updates the list and follows anything newly ticked |
| **Check my configuration** | Prints what your sheet says, as understood. Writes nothing |
| **What am I missing?** | Phrases recurring in postings no rule matched |
| **What have I been passing on?** | What your own Status choices say about your rules |
| **Schedule the daily run…** | Sets the hour, in your spreadsheet's timezone |
| **Stop the daily run** | Turns it off |
| **Send me a digest…** | Email or Discord, or nothing |
| **Add anything missing (after an update)** | Adds tabs, columns and settings a newer version introduced |

**What am I missing?** is the one worth knowing. "No matches" has half a dozen
indistinguishable causes — rules too narrow, a location filter, a salary floor,
an exclusion firing wide, a board with nothing on it — and it names which,
instead of leaving you to guess.

---

## When it runs

You can make it run whenever you want by going to the menu and selecting **Run the watch now**. The results you'll get will be only
the new results that you have not seen before.

*What about a daily scheduled run?*

Nothing runs on a schedule until you say so. **Schedule the daily run…** asks
for an hour and sets it in your spreadsheet's own timezone, so it follows
daylight saving and the hour you pick stays the hour you get. It fires within
that hour rather than on the minute, and it runs whether or not the sheet is
open.

---

## Digests

**Send me a digest…** takes an email address or a Discord webhook URL, and
works out which is which. Leave it empty to stop.

A digest goes out after a run that found something new, best first. Nothing is
sent on a quiet morning.

Email is sent by the script in your own copy, running as you — no mail service,
no API key, nobody in between. A Discord webhook comes from *Channel → Edit →
Integrations → Webhooks*, and takes about thirty seconds to make.

---

## Knowing what happened

Every run appends a row to the `log` tab:

```
When                 What ran        Outcome  Summary
2026-08-31 08:00:04  watch 1.0.0     ok       10 matched from 12 companies · 2 new, 1 changed
2026-08-31 08:14:11  discover 1.0.0  ok       3 of 5 resolved
2026-09-01 08:00:02  watch 1.0.0     failed   no companies with a resolved board
```

The `Detail` column holds everything the run printed — click the cell and read
it in the formula bar. That's where the answers from the diagnostics end up, so
running one gives you something in the sheet rather than a message that
vanishes.

---

### What you can and can't edit

Some columns are protected — you'll get a warning if you type in them. It's a
warning, not a lock: it's your sheet, and you can always click through. It
stops the accident, not you.

| Tab | Protected | Why |
| --- | --- | --- |
| `settings` | the names and the help | It's a form — the middle column is the answer |
| `directory` | everything but `Add` | Shipped content; edits get overwritten, deletions undone |
| `matches` | `Key` only | Clearing it orphans the row and loses your triage |
| `rules`, `companies`, `dropped` | nothing | Those are yours |

If your sheet predates this, run **setup** with mode `reformat` to apply it.

### What lands in the sheet

`matches` gets a row per posting, keyed so a later run updates rather than
duplicates.

**Status and Note are yours.** The sync never writes to them, with one
exception: a row is marked `Closed` once its posting has been gone longer than
`close after days`, and only ever while it still reads `Not reviewed`. Anything
you've triaged is left alone regardless of age.

Rows are never deleted. A posting that leaves a board simply stops having its
`Last seen` advanced.

Salary is one band — the OTE where a posting states one, the base otherwise —
and `Salary basis` says which, so a figure that looks wrong can be traced.
`Pay rank` places it against every priced posting the watch has seen, once it
has seen enough to say anything.

`Changed` says what moved since the last run — a salary going up on a live
posting, a retitle, a move, a repost. You are the only one with a daily
snapshot of these boards, so it is the one signal nobody else can give you.

`dropped` lists postings a filter cost you — matched a rule, then rejected on
location, on salary, or by an exclusion — with the reason in each case. Read it
when results feel thin. Postings no rule matched aren't here; `suggest` covers
those.

---

## Updating

Your copy carries its own code, so a newer version arrives by hand:

1. Get the latest `Code.gs` from the top of this repository
2. In your sheet, *Extensions → Apps Script*, select everything, paste over it
3. **Save** — Apps Script does not save on its own
4. Run **Add anything missing (after an update)**

### The manifest

If the permission prompt asks for more than the four lines in *What it asks
for* — most visibly *all* your spreadsheets rather than this one — the
manifest is missing or has been overwritten. To put it back:

1. In the Apps Script editor, *Project Settings*, tick **Show `appsscript.json`
   manifest file in the editor**
2. Back in *Editor*, open `appsscript.json`
3. Copy the `oauthScopes` block from this repository's `appsscript.json` into
   it, leaving your own `timeZone` alone — that is what the daily run is
   scheduled against
4. **Save**, then reload the sheet

Google re-asks for consent when the scopes change, so expect one more prompt —
a narrower one.

Your tabs, rules, companies and history are untouched. The version you are
running is written into the `What ran` column of every log row.

The company catalogue updates on its own: **Refresh the company catalogue**
fetches the current list, and falls back to the one built into your copy if it
cannot reach it.

---

## Running it from a terminal instead

There is no terminal version of the tool — it is a spreadsheet. But the engine
inside it is ordinary JavaScript, developed and tested on Node:

```bash
npm test                                   # the suite, offline, no credentials
npm run build                              # regenerate Code.gs
npm run diagnose greenhouse grafanalabs    # inspect a live board
```

`src/gas/` holds the two ends that differ from Node — a sheet client over
`SpreadsheetApp` and a fetch shim over `UrlFetchApp`. Everything between them
is shared, and `src/bundle.js` flattens it into one file for Apps Script, which
has no modules and nothing to await. The tests run against the *built* file,
not the sources, because a build step that rewrites control flow is exactly
where a program quietly becomes a different one.

`src/gas/fake.js` is a fake `SpreadsheetApp` — enough of it to run the real
code against, including the detail that an unticked checkbox reads `FALSE`
rather than empty, which is a bug this shipped once.

Job boards are unreachable from many sandboxed environments. If every request
fails, that is the sandbox rather than the board.

### Maintaining the catalogue

`npm run prospect` probes `data/candidates.json` against live boards and
`npm run catalogue` merges the results into `data/directory.json`. A name that
resolves nowhere is dropped and recorded in `unlisted` with the reason;
anything that answered but belongs to a different company goes in
`data/rejected.json` so the same false positive is not rediscovered.

Slugs are first come, first served, so a board answering is not proof it is the
company you meant. Every probe records sample job titles for that reason, and
the review is a person's job.

---

## Licence

[GNU General Public License v3.0 or later](COPYING).

You may use, study, change and share this. If you distribute it, or anything
built on it, your users get the same rights — which means shipping your source
under the GPL too. Modify it privately for your own job search and you owe
nothing: the obligation triggers on distribution, not on use.

Note that the GPL permits commercial use. What it forbids is taking the code
closed.

```
job-watch — watches company job boards for postings worth your attention
Copyright (C) 2026 Andy Cabasso

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.

This program is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with
this program. If not, see <https://www.gnu.org/licenses/>.
```
