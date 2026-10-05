# BotBoy — teammate setup

## Start here

You need:

- a Mac with **Google Chrome**
- **Node.js 20.16 or newer** (`node --version`; PDF reading needs 20.16)
- **Git**
- an AI model: the private BotBoy credential attachment sent to you by the
  owner, your own OpenAI API key, your own DeepSeek API key, or any mix of them

You do **not** need an AWS account or `aws login`.

### Install

1. If the owner sent you a credential attachment, download it from your 1:1
   Slack DM and leave it in **Downloads** or on your **Desktop**. BotBoy
   accepts the owner-issued `.env` file or ZIP automatically. Using only your
   own OpenAI or DeepSeek API key? Skip this step.
2. Open Terminal and run:

```bash
git clone https://github.com/ybhagaab/botboy-app.git ~/botboy-app
cd ~/botboy-app
npm install
./start.sh
```

3. Using your own API key: when the dashboard opens, go to
   **Settings → AI model**, paste a key from
   [platform.openai.com/api-keys](https://platform.openai.com/api-keys) or
   [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)
   into its card, and choose **Save and turn on**. BotBoy checks the key with
   the provider, then offers its models right away. No restart is needed.

Allow a few minutes on the first run. BotBoy imports any credential
attachment, builds itself, opens the dashboard, and attempts to install
`BotBoy.app` in Applications. Ask BotBoy a question to confirm it is working.

### Update

```bash
cd ~/botboy-app
./start.sh --update
```

Always use this updater instead of `git pull`. It keeps compatible BotBoy
customizations active and safely saves anything that overlaps a new release.
If it reports an unverified earlier shutdown, do not remove the guard or kill a
PID from its message. Run `./start.sh --doctor`, then follow the explicit
`./start.sh --recover-shutdown` recovery below.

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
3. connects the authenticated team gateway (GPT-5.6 Terra by default) plus
   any OpenAI or DeepSeek key saved in **Settings → AI model**;
4. loads the server-approved chat model catalog: GPT-5.6 Terra, Luna, and Sol
   plus GPT-6 Astra, Sol, and Luna on the team gateway, and each saved key's
   own models;
5. builds BotBoy when the build is missing or stale;
6. starts a provisional local boot page while connections and stores initialize;
7. opens `http://localhost:7778` only after the final dashboard endpoint is
   ready and the server remains alive through the window launch; and
8. best-effort installs `/Applications/BotBoy.app` when it is missing.

The gateway deployment name still contains `luna`; that is infrastructure
naming, not the selected default model. The default remains GPT-5.6 Terra.
Approved GPT-6 additions use the same Cognito token URL, OAuth scope, and
allowlisted client identity across the approved team gateways, so existing
teammates do not need a replacement credential attachment.

### Your own OpenAI or DeepSeek API key

**Settings → AI model** connects your own OpenAI and DeepSeek accounts next to
the team gateway. Any mix works at the same time:

- BotBoy verifies each key with its provider (model list plus one tiny
  request) before using it, so a mistyped or revoked key changes nothing.
- Keys are stored only on your Mac, in
  `~/.personal-productivity-tracker/ai-model.json` with permissions limited to
  you. BotBoy never shows them again (Settings shows their last four
  characters), and commands BotBoy's model runs cannot read them.
- Each key's card lists the models it offers. An OpenAI key offers every chat
  model the key can use; a DeepSeek key offers every model DeepSeek lists for
  it. The team gateway keeps its fixed list.
- The chat panel's model menu shows every connected provider's models under
  provider headings. You pick the model per message.
- **Background work** in Settings has two choices, each with its own
  Thinking level: **Organizing** (routing, project briefs, digests, planning,
  and reading images) and **Document writing** (product documents and email
  drafts, plus the review of documents written in chat). **Automatic** uses
  the team gateway's default when it is set up, otherwise your OpenAI key,
  otherwise your DeepSeek key.
- Pick an image-capable organizing model (for example DeepSeek Flash or
  GPT-5.6 Terra) if you want BotBoy to read screenshots and image
  attachments. A text-only model says so instead of guessing.
- **Remove key** stops chats on that provider's models; background work moves
  to another connected model.
- When one of your key's models does the work, what it reads (captured
  messages, documents, your chats, and query results) is sent to that
  provider under your account. Data Room table values are not: they stay on
  your Mac, so chat on an OpenAI or DeepSeek model cannot analyze Data Room
  datasets.
- New provider accounts have low rate limits. BotBoy waits and retries when
  the provider asks it to; limits rise as the account is used.

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
./start.sh --stop
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
- **Local folders** — BotBoy watches Downloads, Desktop, and Documents by
  default, and you can add more. Existing files import in the background after
  BotBoy is ready, so a big folder never delays startup. Data and code files
  (JSON, CSV, logs, model files, source code, config) are not read: BotBoy
  records each one's name, size, and a short outline, lists it on its
  project's **Files** tab, and opens the file only when you ask about it. After
  you update from an older release, BotBoy replaces the copies of these files
  it stored before with those records, once, in the background. Documents of
  25 MB or more wait for you: the folder shows **Needs your decision** with a
  list where you tick the files to import and exclude the rest, one by one or
  by subfolder. Documents over 200 MB are listed as too large to import yet.
  The **Storage** card
  on the same page shows where BotBoy's disk space goes. Imports pause below
  10 GB free; below 2 GB, new changes wait until space returns. Watching
  continues either way.

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

BotBoy reads the text of PDFs on every Mac: its pdf.js reader is installed by
`npm install`, and `./start.sh` installs it after an update if it is missing.
Xcode Command Line Tools also build BotBoy's native reader, which is faster
and adds OCR for scanned PDFs and images. Without them, BotBoy records scanned
pages and images as unread rather than guessing. To add the native reader,
run `xcode-select --install`, then:

```bash
cd ~/botboy-app
npm run bootstrap
./start.sh
```

Files recorded as unread are read the next time they change.

### Troubleshooting

BotBoy's runtime log is `/tmp/ppt.log`.

```bash
./start.sh --doctor       # environment, build, auth status, listener, UI, log tail
./start.sh --stop         # stop running BotBoy server processes
./start.sh                # start again
```

A normal Terminal start returns to the prompt only after printing
`✅ Dashboard ready: http://localhost:7778`. If startup fails, BotBoy does
not open a new dashboard window, exits nonzero, and names `--doctor` plus
`/tmp/ppt.log` as the next evidence; repeated refreshes cannot repair a
stopped local server.

Doctor never prints the credential or access token, but its log tail can
contain internal titles, paths, or error context. Review/redact it before
sharing. Running doctor can initialize the debug browser and import a pending
credential attachment before producing the report.

| Symptom | What to do |
|---|---|
| `node not found` | Install Node.js 20.16 or newer and rerun `./start.sh`. |
| Chat says it needs an AI model first | Open **Settings → AI model** and add an OpenAI or DeepSeek API key, or put the owner's credential attachment in Downloads and rerun `./start.sh`. |
| Settings → AI model says OpenAI or DeepSeek rejected the key | Copy a current key from platform.openai.com/api-keys or platform.deepseek.com/api_keys and save it again. |
| Settings → AI model says the account has no credit | Add credit in OpenAI Billing or top up the DeepSeek account. BotBoy resumes on its own once calls succeed. |
| Settings → AI model cannot reach api.openai.com or api.deepseek.com | Check your internet connection and any proxy or VPN rules for that host, then save again. `./start.sh --doctor` prints an `openai probe` / `deepseek probe` status. |
| Images are not inspected | The organizing model is text-only (for example DeepSeek V4 Pro). Choose an image-capable organizing model in **Settings → AI model → Background work**. |
| Build fails on a clean clone | Run `npm install`, then `./start.sh`. |
| `npm audit` lists vulnerabilities in an existing install | Run `npm install` once in `~/botboy-app`. `./start.sh --update` updates BotBoy but never reinstalls packages, so older ones stay until you do. |
| `Incomplete OAuth config` | Download the owner's credential attachment again and rerun `./start.sh`. |
| `invalid_client` / HTTP 400 | Ask the owner for a valid credential attachment. |
| Chat returns HTTP 401 | Ask the owner to check gateway access. |
| Dashboard does not open | Confirm Google Chrome is installed and inspect `/tmp/ppt.log`. |
| Chrome shows `ERR_CONNECTION_REFUSED` | Do not keep refreshing. Run `./start.sh --update`, then `./start.sh`; if startup reports failure, run `./start.sh --doctor` and share only the reviewed relevant output. |
| `Replacement start blocked` / `shutdown recovery: BLOCKED` | Do not delete the guard or kill its PID. Follow **Unverified shutdown recovery** below. |
| BotBoy.app is missing | Run `npm run app:bundle`; BotBoy itself can still run from Terminal. |
| A connection card is missing | Run `./start.sh --update`, then reopen BotBoy. |

### Unverified shutdown recovery

Use this only when BotBoy names `/tmp/ppt-startup-safety-block.json`. It covers
a legacy process that exited without the newer DB-last receipt; it is not a
normal update step.

If the installed launcher says `--recover-shutdown` is unknown or its helper is
missing, fetch the current release **without starting it**:

```bash
cd ~/botboy-app
BOTBOY_UPDATE_NO_START=1 ./start.sh --update
```

Then run:

```bash
./start.sh --doctor
./start.sh --recover-shutdown
./start.sh
./start.sh --doctor
```

Recovery refuses to proceed while any guarded PID, BotBoy process, port 7778
listener, or tracker DB/WAL/SHM handle remains. On a stopped system it creates a
private timestamped exact snapshot under
`~/.personal-productivity-tracker/recovery-backups/`, verifies a disposable
copy with SQLite `quick_check` and `foreign_key_check`, and archives the guard.
It never fabricates a receipt, calls the old shutdown clean, or starts BotBoy
automatically. Keep the snapshot; never restore `tracker.db` alone without its
matching WAL/SHM and related private state. If recovery refuses, share the
reviewed doctor line with the owner instead of bypassing it.

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
visual inputs when you ask BotBoy to inspect an image—goes to the model doing
that work: through the authenticated team gateway, or to OpenAI or DeepSeek
under your own account when one of your saved keys' models is chosen in chat or
in **Settings → AI model**. Connections communicate with
the services you enable. Any document publication, message draft, or production pipeline change
requires your explicit request and follows its own review/approval boundary.

### Lost laptop or suspected exposure

Tell the owner immediately so access can be disabled. Do not post credential
files or their contents in a channel.
