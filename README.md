# BotBoy

**Stop assembling your own context. Start every day already caught up.**

BotBoy is a private productivity brain that lives on your Mac. It watches the
work you choose to share with it — Slack, Outlook, SharePoint, DataCentral
ETL jobs, local folders, your browser — and turns the noise into organized
projects, living briefs, and a chat assistant that genuinely knows what you
are working on. Nothing leaves your machine: captures, database, and
documents stay local, always.

## Why teams use it

**The context tax is real.** Every week you re-read threads to remember where
a decision landed, re-open documents to check what changed, and re-download
the same report outputs to build the same deck. BotBoy pays that tax for you:
it captures as work happens, files evidence into the right project, keeps
each project's brief current, and hands you the receipts when you ask.

## Product tour

The screenshots use synthetic demo labels and obfuscated counts — no captured
workspace content, private messages, or personal data.

### Your day, prioritized

One screen to start from: what needs your attention, who is waiting on a
reply from you, and what changed while you were away — ranked, sourced, and
current.

![BotBoy Today overview with a prioritized attention brief](docs/screenshots/today-overview.png)

### Documents that know your projects

BotBoy syncs the SharePoint documents you work in — revisions, comments, open
threads — renders them in a built-in reader, and drafts or edits documents on
request. Every change is staged for your explicit approval before anything
touches SharePoint. When someone comments on your doc, BotBoy surfaces it in
minutes, not hours.

![BotBoy document workspace](docs/screenshots/documents.png)

### Your ETL jobs, without the tab-juggling

Analysts live in DataCentral. BotBoy speaks it natively: ask about a Datanet
job run, paste a run URL, or just say "grab this week's report cuts" — BotBoy
checks the run, diagnoses failures, downloads the output, and assembles the
final report file. The weekly ritual of downloading each SQL output by hand
is over. Submitting, restarting, or creating ETL work happens only when you
explicitly ask — and heavyweight warehouse SQL always runs on its dedicated,
read-only analytics connection.

### Connections and pipeline, in the open

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/connections.png" alt="BotBoy connection management" /></td>
    <td width="50%"><img src="docs/screenshots/pipeline-health.png" alt="BotBoy pipeline health" /></td>
  </tr>
  <tr>
    <td align="center"><strong>Connections</strong><br />Slack channels, Outlook/SharePoint, Datanet ETL, warehouse SQL, local folders, and browser capture — each one opt-in, configured from the dashboard with guided setup.</td>
    <td align="center"><strong>Pipeline health</strong><br />Read-only visibility into capture, extraction, organization, and synthesis, so you always know what BotBoy is doing.</td>
  </tr>
</table>

## What you get

- **Capture without note-taking** — Slack messages in channels you pick,
  Outlook mail and calendar, SharePoint revisions and comments, files in
  watched folders, pages you visit. All opt-in, all local.
- **Projects that assemble themselves** — captured evidence routes itself
  into project briefs that stay current as work happens, receipts one click
  away.
- **A chat assistant with your context** — "what needs my attention?",
  "what changed in the HLD?", "check my ETL jobs and pull yesterday's
  output", "draft the status update" — answered from your own evidence,
  with links back to sources.
- **Analytics on tap** — governed, read-only SQL against your team's
  warehouse, dashboards you can refresh and share deliberately, and Datanet
  job outputs fetched straight into your workspace.
- **Writes you approve, always** — BotBoy never edits a document, posts
  anything, or touches a production pipeline without your explicit request.
  Reads are free; changes are yours to authorize.
- **Authentication that heals itself** — Amazon sessions expire; BotBoy
  notices, silently re-establishes what it can, and when it truly needs you,
  opens a terminal card with the one command to run.

## Prerequisites

- macOS (Apple Silicon or Intel)
- Node.js 20+ (`node --version`)
- A personal credentials file from the owner (one download link — no AWS
  account or cloud setup needed)

## Install

```bash
git clone https://github.com/ybhagaab/botboy-app.git
cd botboy-app
./start.sh
```

First launch installs dependencies and builds automatically (a few minutes),
then opens the dashboard at `http://localhost:7778`. Full steps — credentials,
connecting your data sources, the optional Dock app — are in
**[docs/TEAMMATE_SETUP.md](docs/TEAMMATE_SETUP.md)**.

## Update

```bash
git pull
./start.sh
```

The launcher detects the new version and rebuilds on its own.

## Privacy

BotBoy is single-user and local-first. Your evidence database, document
copies, and credentials live in `~/.personal-productivity-tracker/` on your
Mac — not in this repository, and not on any shared server. The only network
calls are to the sources you connect and to the team's authenticated LLM
gateway for synthesis. Deleting that folder removes everything.

## Help

Run `./start.sh --doctor` and send the output to the owner. It checks Node,
build state, native modules, credentials, the port, and the served UI, and
includes the recent log lines.

---
*This repository is the app distribution. It receives release snapshots; development happens elsewhere.*
