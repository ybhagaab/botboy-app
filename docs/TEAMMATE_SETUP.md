# BotBoy — teammate setup

## Start here

You need:

- a Mac with **Google Chrome**
- **Node.js 20.16 or newer** (`node --version`; PDF reading needs 20.16).
  Homebrew's current Node (`brew install node`, Node 26 with npm 12) works.
  On Node 20, `npm install` builds BotBoy's database module from source, which
  needs Xcode Command Line Tools (`xcode-select --install`).
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
If an earlier shutdown is still unverified, the updater brings the new code
but does not start BotBoy. Do not remove the guard yourself: run
`./start.sh --recover-shutdown`, then `./start.sh` (see **Unverified shutdown
recovery** below).

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
4. loads the server-approved chat model catalog: GPT-5.6 Terra, Luna, and Sol;
   GPT-6 Astra, Sol, and Luna; and GPT-6.1 Sol on the team gateway, plus each
   saved key's own models;
5. builds BotBoy when the build is missing or stale;
6. starts a provisional local boot page while connections and stores initialize;
7. opens `http://localhost:7778` only after the final dashboard endpoint is
   ready and the server remains alive through the window launch; and
8. best-effort installs `/Applications/BotBoy.app` when it is missing.

The gateway deployment name still contains `luna`; that is infrastructure
naming, not the selected default model. The default remains GPT-5.6 Terra.
Approved GPT-6 and GPT-6.1 additions use the same Cognito token URL, OAuth scope, and
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
- **Gmail** — for a Google account (personal Gmail or Google Workspace)
  instead of Amazon mail. You create a Google OAuth client once in your own
  Google Cloud project and choose its JSON file; see **Gmail** below.
- **Slack** — choose and configure the channels you want BotBoy to capture.
- **SharePoint** — install and authenticate from its connection card when you
  want document synchronization.
- **Other MCP servers** — ask BotBoy in chat; see **Add an MCP server** below.
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
production pipeline happens only after you explicitly ask.

ETL queries take minutes. When you ask for an analysis or a dashboard, BotBoy
runs its queries on its own scratch profile and keeps working on the request:
a line above the chat box shows **Working on: …** with the runs it waits for.
When a run finishes, BotBoy continues in the chat by itself (its reply starts
with ↻), so you never need to ask it to check. An automatic continuation only
does data work for that request; sending, publishing, or changing anything
else still waits for you. Press **Stop** on that line to end the job. Your own
message always goes first.

#### Gmail

For a Google account, open **Connections → Gmail**. BotBoy signs in with a
Google OAuth client from your own Google Cloud project, so you create one once:

1. In Google Cloud Console, create a project and enable the **Gmail API**.
2. In **Google Auth Platform → Branding**, enter an app name and your email.
   Under **Audience**, choose **Internal** for a Google Workspace account. For a
   personal Gmail account, choose **External** and then **Publish app**: while
   the app is in testing, Google ends its sign-in after 7 days.
3. Under **Clients**, choose **Create client → Desktop app**. You do not need
   a redirect address.
4. Download the client's JSON file (`client_secret_….json`) and choose it on
   the BotBoy Gmail page, or paste the client ID and secret and choose
   **Save client**.
5. Choose **Connect Gmail** and pick your Google account. Google says the app
   is unverified because your app has not been through Google's review: choose
   **Advanced**, then the **Go to … (unsafe)** link, then **Allow**. Google
   returns you to BotBoy.

**More than one Google account** (personal, work, a side project): choose
**Add another account** on the Gmail page and sign in to the next account. Your
one client works for every account; if its app is still in testing, add each
account under **Audience → Test users** first. Give each account a **label**
(Work, Personal…): briefs, routing, and chat use it to tell your mail apart,
and a reply goes from the account its thread is in. **Disconnect** removes one
account and keeps its captured mail unless you also choose to delete it. A work
Google Workspace account may refuse your client when its admin allows only
approved apps; BotBoy says so instead of failing silently.

BotBoy asks Google for two kinds of access: reading your mail
(`gmail.readonly`) and drafting and sending (`gmail.compose`). You can untick
drafting and sending on Google's screen; capture and search still work, and the
Gmail page offers **Reconnect** when you want to add it. A connection made
before this release has read access only, so the page shows **Reconnect to
allow drafting and sending**.

In chat, BotBoy can then search and read your live mailbox (any age, not only
what it captured), write drafts, and send mail. When you ask it to rewrite a
passage of a document, it can search and read your mail too, but not draft or
send. It sends when you tell it to
send, email, or reply. When you ask to see a message first, it saves a Gmail
draft and shows it in chat with **Send**, **Open in Gmail**, and **Discard**
buttons. BotBoy never marks mail read, labels, archives, moves, or deletes
anything, and an email can never make it send: only your own chat message can.

BotBoy can attach files to a draft or an email: a file you name, a file it made
for you, or an image you pasted into the chat. One email holds up to 10 files
and 25 MB, and the draft card lists each file. BotBoy does not attach
credential files, hidden files, app data in `~/Library` (iCloud Drive is
fine), text files that contain an API key, a token, or a private key, or its
own private data. When it
refuses a file, it tells you which one and why; you can still attach that file
yourself in Gmail.

The first sync reads the last 30 days of mail. After that, BotBoy checks for
new mail every 5 minutes and reads at most 100 messages per sync. To bring in
older mail, choose **Import the last 6 months** on the Gmail page: BotBoy works
through it in the background after new mail, about 100 messages a minute, and
shows its progress; **Stop import** ends it, and mail already captured stays.
The page shows how many emails BotBoy holds and how many reached a project.
Received mail is kept when your address is in To or Cc; sent mail is always
kept, including mail BotBoy sends for you. The client and your sign-in token stay in
`~/.personal-productivity-tracker/gmail.json`, which only your user account can
read; the BotBoy owner never sees your token or your mail. **Disconnect**
revokes the access at Google; mail that BotBoy already captured stays.

#### Add an MCP server

Ask BotBoy in chat, for example "add the DeepWiki MCP server". You can also
name a service, paste a link to its docs, or paste a config snippet. You
never edit a config file.

1. BotBoy looks the server up in the official MCP Registry and, if you use
   AIM, in Amazon's AIM registry. It picks the one the service itself
   publishes where it can.
2. It adds the server and shows a card in chat. The card says where it runs
   (a command on your Mac, or the remote host that receives every call), who
   publishes it, and what it needs from you.
3. If the server needs a key or token, type it into the field on the card.
   It is saved in your Mac's Keychain, and BotBoy never sees it. Do not paste
   a key into chat: chat messages are kept and go to the model. If you do,
   BotBoy does not put it into the server and points you to the card.
4. Press **Start** on the card. That press is your approval; BotBoy cannot
   press it for you. BotBoy then tests the server and lists its tools.

If a server needs a sign-in step, such as `mwinit` or `aim mcp install` for
an AIM server, BotBoy runs it in a terminal card in chat, and you type any
PIN there. Reads run freely. Tools that change data run only when you ask
in chat, and every call is audited. Later, BotBoy can fix the server on its
own; you press Start again only if the command, its arguments, or the
remote host change. Servers that sign in through a browser (OAuth) cannot
be added yet; BotBoy says so and offers a local or AIM version when there is
one. **Connections** lists every server, with **Edit** and **Delete**.

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
| `BotBoy did not start: its native modules do not work with Node …` | BotBoy already reinstalled them once and did not start, so nothing needs recovery. Run `npm install` in `~/botboy-app`, read the errors at its end, fix what they name, then `./start.sh`. On Node 20, install Xcode Command Line Tools first (`xcode-select --install`). |
| `npm audit` lists vulnerabilities in an existing install | Run `npm install` once in `~/botboy-app`. `./start.sh --update` updates BotBoy but never reinstalls packages, so older ones stay until you do. |
| `Incomplete OAuth config` | Download the owner's credential attachment again and rerun `./start.sh`. |
| `invalid_client` / HTTP 400 | Ask the owner for a valid credential attachment. |
| Chat returns HTTP 401 | Ask the owner to check gateway access. |
| Dashboard does not open | Confirm Google Chrome is installed and inspect `/tmp/ppt.log`. |
| Chrome shows `ERR_CONNECTION_REFUSED` | Do not keep refreshing. Run `./start.sh --update`, then `./start.sh`; if startup reports failure, run `./start.sh --doctor` and share only the reviewed relevant output. |
| `Replacement start blocked` / `shutdown recovery: BLOCKED` | Run `./start.sh --recover-shutdown`, then `./start.sh`. Do not delete the guard yourself; deleting and re-cloning `botboy-app` does not clear it. See **Unverified shutdown recovery** below. |
| BotBoy.app is missing | Run `npm run app:bundle`; BotBoy itself can still run from Terminal. |
| A connection card is missing | Run `./start.sh --update`, then reopen BotBoy. |
| Gmail shows **Reconnect needed** | Google ended BotBoy's access: you changed your Google password, you removed BotBoy from your Google account, or your app was in testing for 7 days. Open **Connections → Gmail** and choose **Reconnect**. To stop the 7-day sign-outs, publish the app (step 2 under **Gmail**). `./start.sh --doctor` prints a `gmail refresh probe` status; `400 invalid_grant` means Reconnect. |
| BotBoy says it may not draft or send, or the Gmail page shows **Reconnect to allow drafting and sending** | The connection has read access only. Choose **Reconnect** and leave **Manage drafts and send emails** ticked on Google's screen. |
| The Gmail page asks for a Google OAuth client although Gmail worked before, or the doctor says only the retired shared client is saved | BotBoy no longer uses a shared Google client. Create your own client (steps under **Gmail**), choose its JSON file, then choose **Connect Gmail**. |
| Google or the Gmail page shows `redirect_uri_mismatch` or `invalid_client`, or says the file is for a Web application client | The saved client is not a **Desktop app** client, or its ID or secret is wrong. Create a Desktop app client and choose its JSON file (or save its ID and secret) again. |
| Google shows `access_denied` when you connect Gmail | You chose Cancel, or a test-mode app admits only its listed test users. Connect again and choose **Allow**; or publish your app, or add your address under **Audience → Test users**. |

### Unverified shutdown recovery

Use this only when BotBoy names `/tmp/ppt-startup-safety-block.json`. It covers
an earlier BotBoy that exited without proving it closed its database (for
example an old release, or one that was running when its folder was deleted);
it is not a normal update step. The guard sits in `/tmp` and the database in
`~/.personal-productivity-tracker/`, both outside the checkout, so deleting
and re-cloning `botboy-app` does not clear it. Recovery does.

If the installed launcher says `--recover-shutdown` is unknown or its helper is
missing, fetch the current release first. While the guard exists, the updater
changes the code only and never starts BotBoy:

```bash
cd ~/botboy-app
./start.sh --update
```

If the updater answers **Update paused** (releases before October 7, 2026),
move the checkout aside and clone the current release instead; your data stays
in `~/.personal-productivity-tracker/`:

```bash
cd ~
mv botboy-app "botboy-app-backup-$(date +%Y%m%d-%H%M%S)"
git clone https://github.com/ybhagaab/botboy-app.git ~/botboy-app
cd ~/botboy-app
```

Then run:

```bash
./start.sh --doctor
./start.sh --recover-shutdown
./start.sh
./start.sh --doctor
```

Recovery refuses to proceed while the old BotBoy, any BotBoy process, a port
7778 listener, or an open tracker DB/WAL/SHM handle remains. If the old BotBoy
is still running, it says so and names the command that stops it
(`kill -INT <pid>`; wait 30 seconds, then `./start.sh`). A PID that now
belongs to another program is not BotBoy, and recovery leaves it alone. If you
removed `~/.personal-productivity-tracker/`, there is nothing to back up, and
recovery only clears the guard. On a stopped system it creates a
private timestamped exact snapshot under
`~/.personal-productivity-tracker/recovery-backups/`, verifies a disposable
copy with SQLite `quick_check` and `foreign_key_check`, and archives the guard.
It needs no `npm install`: when BotBoy's own SQLite module does not work, it
checks the copy with the `sqlite3` built into macOS. Without a guard it says
there is nothing to recover. A start that fails before BotBoy opens its
database no longer leaves a guard at all.
It never fabricates a receipt, calls the old shutdown clean, or starts BotBoy
automatically. Keep the snapshot; never restore `tracker.db` alone without its
matching WAL/SHM and related private state. If recovery refuses, share the
reviewed doctor line with the owner instead of bypassing it.

### Safe reinstall

Your evidence database and credentials live outside the checkout under
`~/.personal-productivity-tracker/`. Preserve the old checkout until the new
one works, because it may contain untracked customizations. If `--stop`
refuses because of an unverified earlier shutdown, skip it and run
`./start.sh --recover-shutdown` in the new checkout before `./start.sh`:

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
the services you enable; Gmail talks only to Google's sign-in and Gmail API
endpoints, and mail BotBoy reads for a chat answer goes to the chat model like
any other content. A remote MCP server you add receives the arguments of
every call BotBoy makes to it; BotBoy sends its saved keys only to that
server and never follows it to another site. When BotBoy looks up a server
for you, only the search words go to the official MCP Registry. Any document publication, message draft or send, or
production pipeline change requires your explicit request and follows its own
review/approval boundary.

### Lost laptop or suspected exposure

Tell the owner immediately so access can be disabled. Do not post credential
files or their contents in a channel.
