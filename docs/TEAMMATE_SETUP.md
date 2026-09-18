# BotBoy — teammate setup

## Start here

You need:

- a Mac with **Google Chrome**
- **Node.js 20 or newer** (`node --version`)
- **Git**
- the private BotBoy credential attachment sent to you by the owner

You do **not** need an AWS account or `aws login`.

### Install

1. Download the private BotBoy credential attachment from your 1:1 Slack DM.
   Leave it in **Downloads** or on your **Desktop**. BotBoy accepts the
   owner-issued `.env` file or ZIP automatically.
2. Open Terminal and run:

```bash
git clone https://github.com/ybhagaab/botboy-app.git ~/botboy-app
cd ~/botboy-app
npm install
./start.sh
```

Allow a few minutes on the first run. BotBoy imports the credential, builds
itself, opens the dashboard, and attempts to install `BotBoy.app` in
Applications. Ask BotBoy a question to confirm it is working.

### Update

```bash
cd ~/botboy-app
./start.sh --update
```

Always use this updater instead of `git pull`. It keeps compatible BotBoy
customizations active and safely saves anything that overlaps a new release.

### Need help?

```bash
cd ~/botboy-app
./start.sh --doctor
```

Review the report before sharing it because its recent log lines can contain
local paths or work context. Send the relevant output to the owner.

---

## Detailed setup and support reference

Most teammates can stop after **Start here**. The rest of this document is for
optional connections, troubleshooting, and unusual recovery cases.

### What first start does

`npm install` installs BotBoy's dependencies. `./start.sh` then:

1. imports the newest valid `botboy-credentials*` plaintext file or owner ZIP
   from Downloads/Desktop into
   `~/.personal-productivity-tracker/.env` with permissions limited to you;
2. deletes the downloaded credential attachment after a successful import;
3. selects the authenticated team gateway and Terra model automatically;
4. builds BotBoy when the build is missing or stale;
5. starts the local dashboard at `http://localhost:7778`; and
6. best-effort installs `/Applications/BotBoy.app` when it is missing.

The gateway deployment name still contains `luna`; that is infrastructure
naming, not the selected default model. The default model is Terra.

### Updating and customizations

`./start.sh --update` is the supported update path for `botboy-app`. Before
updating, it saves a full patch of tracked local customizations under
`~/.personal-productivity-tracker/update-backups/`. It fast-forwards to the
new release and reapplies each customized file independently. Clean merges
remain active. Overlapping files stay on the new release while their patches
are retained in a `-needs-reapply` directory for deliberate review. Untracked
files and everything under `~/.personal-productivity-tracker/` are untouched.

<details>
<summary>One-time transition from a release too old to support <code>--update</code></summary>

Use this only when an old checkout says a pull would overwrite local changes
and does not recognize `./start.sh --update`:

```bash
set -euo pipefail
cd ~/botboy-app
mkdir -p ~/.personal-productivity-tracker/update-backups
STAMP="$(date +%Y%m%d-%H%M%S)"
PATCH="$HOME/.personal-productivity-tracker/update-backups/pre-updater-$STAMP.patch"

git status --short
git diff --binary HEAD -- . > "$PATCH"
test -s "$PATCH"
git restore --source=HEAD --staged --worktree -- .
git pull --ff-only
./start.sh

echo "Saved pre-update customizations: $PATCH"
```

Do not run `--update` again in the same transition. Ask BotBoy or the owner to
review/reapply the saved patch if those old customizations are still needed.
Use `./start.sh --update` for every later release.

</details>

### Connect optional data sources

Open **Connections** in BotBoy. Each connection is opt-in and provides its own
guided setup.

- **Amazon Microsoft 365 through GRASP** — Outlook/calendar synchronization
  uses your own Amazon browser session. BotBoy stores no GRASP password.
- **Slack** — choose and configure the channels you want BotBoy to capture.
- **SharePoint** — install and authenticate from its connection card when you
  want document synchronization.

#### Datanet ETL

For Datanet/DataCentral work, open **Connections → Datanet ETL** and follow the
steps shown there:

1. Install Toolbox + AIM if needed.
2. Run `aim agents install A2AnalyticsAgent`.
3. Install the Python MCP library using the command shown by BotBoy.
4. Refresh Midway + Sentry with `mwinit -o -s`.
5. Choose **Start & test**.

Datanet requires Python 3.10 or newer. Stock Xcode Python can be 3.9; if BotBoy
cannot find a supported Python, install one (for example
`brew install python@3.12`) and repeat the guided step. Reads and result
downloads are autonomous. Submitting, restarting, prioritizing, or changing a
pipeline happens only after you explicitly ask.

### Optional local tools

- **Pandoc** is optional. Markdown downloads work without it. For Word, PDF,
  or HTML document export, BotBoy offers an in-app Homebrew installation, or
  you can run `brew install pandoc`.
- **BotBoy.app** is attempted automatically on first start. If it is missing,
  if you moved the checkout, or if you installed Xcode Command Line Tools
  later, run:

```bash
cd ~/botboy-app
npm run app:bundle
```

With Xcode Command Line Tools, the native launcher keeps the Dock icon present
while BotBoy runs. Without them, BotBoy still runs from Terminal.

### Troubleshooting

BotBoy's runtime log is `/tmp/ppt.log`.

```bash
./start.sh --doctor       # environment, build, auth status, listener, UI, log tail
./start.sh --stop         # stop running BotBoy server processes
./start.sh                # start again
```

Doctor never prints the credential or access token, but its log tail can
contain internal titles, paths, or error context. Review/redact it before
sharing. Running doctor can initialize the debug browser and import a pending
credential attachment before producing the report.

| Symptom | What to do |
|---|---|
| `node not found` | Install Node.js 20+ and rerun `./start.sh`. |
| Build fails on a clean clone | Run `npm install`, then `./start.sh`. |
| `Incomplete OAuth config` | Download the owner's credential attachment again and rerun `./start.sh`. |
| `invalid_client` / HTTP 400 | Ask the owner for a valid credential attachment. |
| Chat returns HTTP 401 | Ask the owner to check gateway access. |
| Dashboard does not open | Confirm Google Chrome is installed and inspect `/tmp/ppt.log`. |
| BotBoy.app is missing | Run `npm run app:bundle`; BotBoy itself can still run from Terminal. |
| A connection card is missing | Run `./start.sh --update`, then reopen BotBoy. |

### Safe reinstall

Your evidence database and credentials live outside the checkout under
`~/.personal-productivity-tracker/`. Preserve the old checkout until the new
one works, because it may contain untracked customizations:

```bash
cd ~/botboy-app
./start.sh --stop
cd ~
mv botboy-app "botboy-app-backup-$(date +%Y%m%d-%H%M%S)"
git clone https://github.com/ybhagaab/botboy-app.git ~/botboy-app
cd ~/botboy-app
npm install
./start.sh
npm run app:bundle
```

After verifying the replacement, review the timestamped backup with the owner
before deleting it. Do not delete `~/.personal-productivity-tracker/` unless
the owner explicitly asks for a factory reset; that directory contains local
evidence and credentials.

### Privacy and network boundaries

BotBoy is local-first. Its evidence database, document copies, generated files,
and credentials stay under `~/.personal-productivity-tracker/` on your Mac by
default. Content needed for an LLM request—including selected text and bounded
visual inputs when you ask BotBoy to inspect an image—is sent through the
authenticated team gateway. Connections communicate with the services you
enable. Any document publication, message draft, or production pipeline change
requires your explicit request and follows its own review/approval boundary.

### Lost laptop or suspected exposure

Tell the owner immediately so access can be disabled. Do not post credential
files or their contents in a channel.
