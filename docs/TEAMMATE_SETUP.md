# BotBoy — Teammate Setup (Luna, no AWS access needed)

BotBoy runs entirely on your Mac. LLM calls (Luna, `openai.gpt-5.6-luna`) go
through an authenticated team gateway — you do not need an AWS account,
`aws login`, or any cloud setup. Your only credential is a personal client
id/secret pair the owner sends you privately.

## Prerequisites

- macOS (Apple Silicon or Intel)
- Node.js 20+ (`node --version`)
- Google Chrome installed
- git

## Install

```bash
git clone https://github.com/ybhagaab/botboy-app.git
cd botboy-app
npm install
npm run build
```

(If you skip `npm install` / `npm run build`, the first `./start.sh` runs
them for you automatically — the first launch just takes a few minutes
longer.)

## Configure + run (download, then start — that's it)

The owner DMs you a **personal, expiring download link** (a private S3
presigned URL — opens in any browser, no AWS login). Grab it before it
expires (~1 hour; ask for a fresh link if you miss it):

1. Click the link — `botboy-credentials.env` lands in your Downloads.
2. Run `./start.sh`.

The launcher finds the downloaded file, installs the credentials into
`~/.personal-productivity-tracker/.env` (permissions locked to you), and
deletes the copy from Downloads. No dotfile editing. BotBoy then selects the
team gateway automatically — endpoint, model, and auth flow are built in, and
it mints and refreshes its own 24-hour access tokens.

First start takes ~30-50s; a standalone dashboard window opens when ready.
Chat lives in the dashboard — ask it anything to confirm Luna responds.

Credential rotation works the same way: download the new file the owner
sends, restart BotBoy, done.

<details>
<summary>Manual alternative (no auto-import)</summary>

Put the two lines from the downloaded file into
`~/.personal-productivity-tracker/.env` yourself:

```bash
mkdir -p ~/.personal-productivity-tracker
cat ~/Downloads/botboy-credentials.env >> ~/.personal-productivity-tracker/.env
chmod 600 ~/.personal-productivity-tracker/.env
rm ~/Downloads/botboy-credentials.env
```
</details>

## Connect your data sources (after first launch)

BotBoy ships with managed connections on the **Connections** page. Two are
worth setting up on day one:

- **Amazon Microsoft 365 through GRASP** (Outlook mail + calendar, read-only,
  synced every 30 min). This is per-person by design — GRASP uses your own
  Amazon account (Midway + browser login), and BotBoy stores no GRASP
  credentials. Open the connection and follow the guided steps on the page:
  Install (Toolbox command), Initialize, `mwinit`, Authorize, then Start &
  test. One-time, about 5 minutes.
- **Slack** — same idea: open the connection and follow the on-page steps.

If a connection card is missing, `git pull` and restart — your clone predates
it.

## Optional — BotBoy icon in Applications / Dock

`./start.sh` runs the tracker and opens the dashboard window, but it does
not install an app icon. To get a real BotBoy app in `/Applications`
(Finder, Spotlight, Launchpad, Dock), run once from the `botboy-app/`
folder:

```bash
npm run app:bundle
```

From then on launch BotBoy like any Mac app — the Dock icon stays while it
runs, and quitting the app stops the tracker gracefully.

Note: with Xcode Command Line Tools installed (`xcode-select --install`)
the bundle gets a native launcher that keeps the Dock icon pinned while
BotBoy runs. Without them you still get the app and icon in Applications,
just no persistent Dock presence.

## Troubleshooting

First move for any problem: run `./start.sh --doctor` and send the whole
output to the owner. It checks your Node, Xcode CLT, build, native modules,
credentials, port, and the served UI, and includes the last log lines —
almost every issue is identifiable from that one paste.

Also useful: `./start.sh --stop` stops every BotBoy process cleanly (use it
if you started BotBoy several times or things look stuck), then `./start.sh`
starts one fresh instance.

| Symptom | Fix |
|---|---|
| Startup error: `Incomplete OAuth config` | One of the two .env lines is missing or misspelled |
| Startup/chat error mentioning `invalid_client` (HTTP 400) | Credentials wrong or revoked — re-paste from 1Password, or ask the owner to reissue |
| Chat errors with HTTP 401 | Your client isn't on the gateway allowlist — ask the owner to run their audit |
| Dashboard never opens | Check `/tmp/ppt.log` for the first error; Chrome must be installed |
| No BotBoy icon in Applications after `./start.sh` | Expected — the app icon is a separate step: `npm run app:bundle` (see above) |

## Clean reinstall

If your install is wedged (for example `EMFILE: too many open files`, or
repeated launches left things in a bad state), reinstall the app. Your
captured data and credentials live outside the repo in
`~/.personal-productivity-tracker/`, so they survive this:

```bash
cd ~/botboy-app
./start.sh --stop       # older checkout without --stop? use:
                        #   pkill -9 -f 'node dist/index.js'; rm -f /tmp/ppt.pid
cd ~ && rm -rf ~/botboy-app
git clone https://github.com/ybhagaab/botboy-app.git
cd botboy-app
npm install
./start.sh              # first launch compiles automatically (~1 min)
```

(Still on the old `~/botboy` clone from before the repo move? Same steps —
just `rm -rf ~/botboy` and clone `botboy-app` instead.)

If you built the `/Applications/BotBoy.app` icon earlier, it lives outside
the repo — but it points at the path it was built from. After moving from
the old `~/botboy` clone to `~/botboy-app`, re-run `npm run app:bundle` once
so the icon points at the new location.

Factory reset (only if the owner tells you to): additionally run
`rm -rf ~/.personal-productivity-tracker ~/.chrome-debug-profile`. This
deletes your local evidence database AND your LLM credentials — you will
need a fresh credential link from the owner before starting again.

## Privacy note

BotBoy's monitors (clipboard, browser, folders, Slack) capture only on your
machine into a local SQLite database under `~/.personal-productivity-tracker/`.
Nothing is uploaded anywhere except the text of LLM requests to the team
gateway, which serves the model and returns the response.

## Losing access / offboarding

Access is per-person and revocable at any time by the owner. If your laptop
is lost or you suspect your secret leaked, tell the owner immediately — they
rotate your credentials in under a minute and old ones stop working instantly.

(Owner side — issuing, delivering, rotating, and revoking credentials — is
documented in `CREDENTIALS_RUNBOOK.md` in the owner's development repo.)
