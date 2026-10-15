# BotBoy — teammate setup

## Start here

You need:

- a Mac with **Google Chrome**
- **Git**, which comes with the Xcode Command Line Tools (a Mac without them offers to
  install them the first time you run `git`)
- an AI model: the private BotBoy credential attachment sent to you by the
  owner, your own OpenAI API key, your own DeepSeek API key, your own Anthropic
  (Claude) API key, or any mix of them

You do **not** need an AWS account or `aws login`, and you do **not** need to install
Node.js, Homebrew or npm first. `./start.sh` uses the Node your Mac already has when it
works. When it does not (none, older than 20.16, Node 20 on a Mac without the Command
Line Tools, or a Node 22 whose npm 10.9 cannot install BotBoy), `./start.sh` sets up
BotBoy's own copy of Node, once:

- it downloads Node 24.21.0 for your Mac's chip (about 50 MB) from nodejs.org, checks it
  against a SHA-256 kept in this folder (`node-runtime.pin`) **before** unpacking it, and
  unpacks it into `~/.personal-productivity-tracker/runtime`;
- only BotBoy uses it: your Terminal, your PATH and your other apps are not changed, and
  it needs no Homebrew and no Command Line Tools. BotBoy's chat commands, its terminal and the
  servers you add use it too, so `node`, `npx` and `npm` work there without installing anything. `npm install -g` from chat installs into
  `~/.npm-global` (BotBoy's own Node folder is read-only), and a server you add by its program name is looked
  up there too. `corepack enable` cannot write into BotBoy's Node; use `npx pnpm` or `npx yarn`;
- it needs about 1 GB of free disk and **macOS 13.5 or newer** (Node 24's own floor). On
  macOS 13.0 to 13.4, or older, update macOS first (System Settings > General > Software
  Update; on macOS 13 Ventura, 13.5 or newer is a free update); `./start.sh` says so and
  stops. Only if your Mac cannot update: install Node 22 from nodejs.org, run
  `sudo npm install -g npm@11` once in Terminal (it asks for your Mac password; Node 22's
  own npm 10.9 cannot do BotBoy's first install), then run `./start.sh`;
- every later start downloads nothing, and `./start.sh --update` fetches a newer pinned
  Node only when a release changes the pin;
- to remove it: `rm -rf ~/.personal-productivity-tracker/runtime`. It comes back at the next
  start if your Mac still has no usable Node. `./start.sh --doctor` shows which Node BotBoy
  uses (`node source:`) and whether a download would be needed (`node runtime:`);
- prefer your own Node? Install Node 24 or newer from nodejs.org (the LTS download; its
  installer needs no other tools). `BOTBOY_NODE_RUNTIME=system ./start.sh` never uses or
  downloads a private copy, and `BOTBOY_NODE_RUNTIME=private ./start.sh` always does.

You do not need Python or uv either. `./start.sh` uses your Mac's own Python 3.10 or newer and
uv when they work. When it has none (macOS's own `python3` is 3.9, or only the Xcode stand-in),
`./start.sh` sets up BotBoy's own Python, once, in the background while it builds:

- it downloads uv 0.13.0 and CPython 3.13.16 for your Mac's chip (about 40 MB) from github.com
  (the astral-sh/uv and astral-sh/python-build-standalone releases), checks both against SHA-256
  values kept in this folder (`python-runtime.pin`) **before** unpacking them, and puts them in
  `~/.personal-productivity-tracker/runtime` (about 95 MB);
- only BotBoy uses them: your Terminal and your PATH are not changed. Chat's `python3`, `pip`,
  `uv` and `uvx`, and the Python MCP servers you add (`uvx …`, `uv run …`, `python3 -m …`, or a
  program installed with `uv tool install` or `pip install`), use them. What they install goes to
  `~/.botboy-python` (BotBoy's own Python folder is read-only): a plain `pip install` in chat
  works, and a virtual environment works as usual;
- on a slow or blocked network BotBoy waits for its Python at most about 3 minutes on a first
  start (or any start that installs or builds BotBoy, other than `./start.sh --update`) and at
  most about 20 s on later starts. After that it starts without Python, and the next
  `./start.sh` continues the download;
- to remove it, with what an interrupted download left behind:
  `sh -c 'rm -rf ~/.personal-productivity-tracker/runtime/uv-* ~/.personal-productivity-tracker/runtime/python ~/.personal-productivity-tracker/runtime/.download/uv-* ~/.personal-productivity-tracker/runtime/.download/cpython-* ~/.personal-productivity-tracker/runtime/.python.lock ~/.botboy-python'`
  (run it as written: through `sh -c` it also works when some of these are missing, where zsh would refuse it).
  It comes back at the next start if your Mac still has no usable Python or uv. `./start.sh --doctor`
  shows `python source:`, `uv source:`, `python runtime:` and `python files:`;
- `BOTBOY_PYTHON_RUNTIME=system ./start.sh` never uses or downloads it, and
  `BOTBOY_PYTHON_RUNTIME=private ./start.sh` always does.

### What works on a Mac with only macOS, Chrome and Git

- **Works without anything else** (macOS 13.5 or newer): capture, chat, text PDFs,
  scanned PDFs and images (BotBoy ships its own reader), Office files, the BotBoy.app
  Dock icon, BotBoy's own Node, and BotBoy's own Python and uv (after one start while online).
  Nothing is compiled on your Mac.
- **Needs the Xcode Command Line Tools:** `git` (so the first `git clone`, `./start.sh --update`
  and the in-app Update button), Node 20's database module if you use your own Node 20,
  and building BotBoy's readers from source on macOS 12.
- **Needs something else:** optional extras such as pandoc, ffmpeg, jq or LibreOffice (Homebrew).

### Install

1. If the owner sent you a credential attachment, download it from your 1:1
   Slack DM and leave it in **Downloads** or on your **Desktop**. BotBoy
   accepts the owner-issued `.env` file or ZIP automatically. Using only your
   own OpenAI, DeepSeek or Anthropic (Claude) API key? Skip this step.
2. Open Terminal and run:

```bash
git clone https://github.com/ybhagaab/botboy-app.git ~/botboy-app
cd ~/botboy-app
./start.sh
```

`./start.sh` installs BotBoy's packages itself (with the Node described above); you do
not run `npm install` by hand.

3. Using your own API key: when the dashboard opens, go to
   **Settings → AI model**, paste a key from
   [platform.openai.com/api-keys](https://platform.openai.com/api-keys),
   [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) or
   [platform.claude.com/settings/keys](https://platform.claude.com/settings/keys)
   into its card, and choose the card's save button (**Save and turn on**, or
   **Check and save key** on the Anthropic (Claude) card). BotBoy checks the key
   with the provider, then offers its models right away. No restart is needed.

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

`./start.sh` first makes sure a working Node exists (this Mac's own, or BotBoy's
own pinned copy, downloaded once; see **Start here**) and installs BotBoy's
dependencies with it. Then it:

1. imports the newest valid `botboy-credentials*` plaintext file or owner ZIP
   from Downloads/Desktop into
   `~/.personal-productivity-tracker/.env` with permissions limited to you;
2. deletes the downloaded credential attachment after a successful import;
3. connects the authenticated team gateway (GPT-5.6 Terra by default) plus
   any OpenAI, DeepSeek or Anthropic (Claude) key saved in **Settings → AI model**;
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

### Your own OpenAI, DeepSeek or Claude API key

**Settings → AI model** connects your own OpenAI, DeepSeek and Anthropic
(Claude) accounts next to the team gateway. Any mix works at the same time:

- BotBoy verifies each key with its provider (model list plus one tiny
  request) before using it, so a mistyped or revoked key changes nothing.
- Keys are stored only on your Mac, in
  `~/.personal-productivity-tracker/ai-model.json` with permissions limited to
  you. BotBoy never shows them again (Settings shows their last four
  characters), and commands BotBoy's model runs cannot read them.
- Each key's card lists the models it offers. An OpenAI key offers every chat
  model the key can use; a DeepSeek key offers every model DeepSeek lists for
  it; a Claude key offers every active Claude model Anthropic lists for it.
  The team gateway keeps its fixed list.
- The chat panel's model menu shows every connected provider's models under
  provider headings. You pick the model per message.
- **Background work** in Settings has two choices, each with its own
  Thinking level: **Organizing** (routing, project briefs, digests, planning,
  and reading images) and **Document writing** (product documents and email
  drafts, plus the review of documents written in chat). **Automatic** uses
  the team gateway's default when it is set up, otherwise your OpenAI key,
  otherwise your DeepSeek key, otherwise your Claude key.
- Pick an image-capable organizing model (for example DeepSeek Flash,
  GPT-5.6 Terra or a Claude model) if you want BotBoy to read screenshots and
  image attachments. A text-only model says so instead of guessing.
- **Remove key** stops chats on that provider's models; background work moves
  to another connected model.
- When one of your key's models does the work, what it reads (captured
  messages, documents, your chats, query results, and Data Room tables) is
  sent to that provider under your account.
- New provider accounts have low rate limits. BotBoy waits and retries when
  the provider asks it to; limits rise as the account is used.

#### Claude (an Anthropic API key)

- **Where the key comes from:** create a regular API key in the Anthropic
  Console at
  [platform.claude.com/settings/keys](https://platform.claude.com/settings/keys).
  It starts with `sk-ant-`. Admin keys (they start `sk-ant-admin`) are for
  Anthropic's Admin API: BotBoy refuses them, so create a regular key instead.
  Use a key that belongs to one workspace: if Settings says the key is not
  tied to one workspace, create a new key, choose a workspace when you create
  it, and save that one (BotBoy has no field for a workspace ID).
- **Steps:** open **Settings → AI model**, paste the key into the
  **Anthropic (Claude)** card and choose **Check and save key**. BotBoy asks
  Anthropic for the models the key can use and sends one tiny request (about
  16 tokens) to prove the key works. The models then appear in the chat model
  menu under **Anthropic (Claude)** and in the **Background work** choices. No
  restart is needed. **Remove key** stops chats on Claude models and moves
  Automatic background work to another connected model; saving the key again
  brings them back.
- **Defaults:** Claude comes last in the **Automatic** order, so adding a Claude
  key changes nothing that was automatic unless it is your only connection.
  Then **Organizing** starts on the newest Haiku-line model (quick and low
  cost, because it runs on every captured item), and **Document writing** and
  the chat default start on the newest Sonnet-line model. Choose any other
  Claude model in the chat menu or in **Background work**.
- **Thinking:** some Claude models always think a little. Their rows in
  Settings carry a small badge that says what **Off** does on that model.
- **What leaves your Mac:** when a Claude model does the work, what it reads
  (captured messages, documents, your chats, tool results, files BotBoy reads
  for you, and Data Room tables) and any image it inspects is sent to
  Anthropic under your account, exactly as it is for OpenAI and DeepSeek.
- **Credit and limits:** a new Anthropic account starts with low rate limits
  and may have a spend limit. BotBoy waits and retries when Anthropic asks it
  to. If Settings reports that the account has no credit, add credit at
  [platform.claude.com/settings/billing](https://platform.claude.com/settings/billing).
- **Check it:** `./start.sh --doctor` prints
  `ai-model: Anthropic (Claude) key …abcd saved in Settings` (the last four
  characters only) and `anthropic probe: HTTP 200`. `401` means Anthropic
  rejected the key, and `000` means a network, proxy or VPN blocks
  api.anthropic.com.
- **Going back to an older release:** an older BotBoy does not know the Claude
  key. It ignores it, and drops it the next time it saves its Settings file, so
  after going back to an older release paste the Claude key again.

#### When a provider call fails

Read the error first: Settings and the chat message now say what the provider
answered (for example `HTTP 503: Server Overloaded`), or what Node found when
nothing answered (for example `fetch failed (ETIMEDOUT+EHOSTUNREACH)`, or a note
that a proxy or security product replaced the provider's certificate).
`./start.sh --doctor` prints the same cause beside `HTTP 000` on its
`openai probe`, `deepseek probe` and `anthropic probe` rows. `/tmp/ppt.log`
keeps the provider's own words for a failed key check
(`grep 'key check failed' /tmp/ppt.log`) and the cause behind a failed chat
turn (`grep 'Stream error' /tmp/ppt.log`). A provider outage shows up as an
`HTTP 5xx` answer or a timeout: check the provider's status page or its emails
before changing anything on your Mac. If it still fails, send the owner those
lines and the `./start.sh --doctor` output.

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

### Amazon Employee setting

**Settings → Workplace → Amazon Employee** decides whether BotBoy offers its
Amazon internal paths: Slack through AI Community MCP, Outlook through GRASP,
SharePoint, Datanet ETL, AIM servers, Amazon writing style, and Harmony
dashboard sharing. BotBoy turns it on by itself when it finds Amazon sign-in
or tools on your Mac (for example a Midway sign-in or Toolbox). Turn it off if
you do not work at Amazon: those connections are hidden, their setup and
captured data are kept, and the change applies right away with no restart.
Slack then works with your own Slack user token. The same page sets the text
printed in the center of every page footer of exported documents (blank by
default; you can also ask BotBoy in chat).

### Connect optional data sources

Open **Connections** in BotBoy. Each connection is opt-in and provides its own
guided setup.

- **Amazon Microsoft 365 through GRASP** (Amazon Employee only) — Outlook/calendar synchronization
  uses your own Amazon browser session. BotBoy stores no GRASP password.
- **Gmail** — for a Google account (personal Gmail or Google Workspace)
  instead of Amazon mail. You create a Google OAuth client once in your own
  Google Cloud project and choose its JSON file; see **Gmail** below.
- **Slack** — choose **Sign in with Slack** (your own Slack app; see **Slack**
  below) or paste a user token, then pick the channels you want BotBoy to capture.
- **SharePoint** (Amazon Employee only) — install and authenticate from its connection card when you
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
  continues either way. The Knowledge folder (see **Your knowledge folder**) is
  never watched or captured, even though it sits inside Documents by default.

#### Datanet ETL

Amazon Employee only. For Datanet/DataCentral work, open **Connections → Datanet ETL** and follow the
steps shown there:

1. Install Toolbox + AIM if needed.
2. Run `aim agents install A2AnalyticsAgent`.
3. Install the Python MCP library using the command shown by BotBoy.
4. Refresh Midway + Sentry with `mwinit -o -s`.
5. Choose **Start & test**.

Datanet requires Python 3.10 or newer. BotBoy uses your Mac's own Python when it has
one, otherwise its own Python 3.13, which `./start.sh` sets up (see Start here). If
the guided step says no Python 3.10+ was found, run `./start.sh` while online and
repeat the step. Reads and result
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

#### Google Drive

Drive rides on a connected Gmail account. On **Connections → Gmail**, choose
**Connect Google Drive** on the account card and allow both Drive boxes on
Google's screen. First enable the **Google Drive API** in the same Google Cloud
project as your Gmail client (Cloud Console → APIs & Services → Enable APIs);
without it Drive capture warns "Enable the Google Drive API in your Cloud
project". BotBoy asks for `drive.readonly` (read the files you choose) and
`drive.file` (create files and update only files it created); never full Drive
access. A Cloud project left in **Testing** ends the sign-in after 7 days (as
for Gmail); publish the app for personal use.

Then pick what BotBoy captures: **Files I own**, **Shared with me**, and
folders (paste a folder link). The first run reads the last 30 days; after that
BotBoy follows Drive's change feed every minute. Docs, Sheets, Slides, PDFs,
and Office files become text; credential-named files and text with a secret
are withheld; files of 25 MB or more are listed, not downloaded.

A BotBoy document can be published to Drive from its **Publish** panel: choose
the Drive destination (My Drive › BotBoy by default), approve, then **Sync**.
Word files are checked byte for byte ("exact file verified"); a Google Doc is
checked by its text ("text verified"). If an upload's outcome is unknown,
BotBoy never sends it again on its own: choose **Check Drive**.

#### Slack

Without Amazon's Slack connection, BotBoy reads Slack with your own Slack
app (BotBoy ships none):

1. At api.slack.com/apps, choose **Create New App → From scratch** in your
   workspace.
2. Under **OAuth & Permissions**, add the **Redirect URL** and the **User Token
   Scopes** shown on BotBoy's Slack page (copy buttons). Add no bot scopes.
   Leave **token rotation** off.
3. Under **Basic Information**, copy the **Client ID** and **Client Secret**
   into BotBoy's Slack page and choose **Save app**.
4. Choose **Sign in with Slack** and allow. Capture starts with no restart.

If Slack refuses the `http://127.0.0.1` address, tick **My Slack app uses the
https address**, register the https address shown instead, sign in, and paste
the address of the error page your browser shows into **Finish sign-in**. You
can still paste a user token (`xoxp-…`) instead of signing in. When Slack ends
the sign-in, the capture warning says to sign in with Slack again.

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

### Your knowledge folder

BotBoy can keep your own reference notes in one visible folder and read the right
ones when a question needs them. Put there what BotBoy cannot learn from your
mail, chats and documents alone: how your data tables fit together, how a
product you work on behaves, the rules you follow, a method you want applied the
same way every time.

**What it is.** The folder holds *sets*. A set is a folder of reference or
how-to files plus a `GUIDE.md` that says what each file is for, how to change
it and what to avoid. BotBoy does not read the folder on every message. Each chat
carries one short line that names your sets. When a message matches a set's
topic, BotBoy adds that set's file table (names and one-line purposes) and then
opens exactly the file it needs, whole. Files it does not open are never sent
anywhere. A file it opens goes to the AI model you picked for that chat, like any
other message. You can add and edit files yourself, in Finder or any editor, and
BotBoy can also write to your sets under each set's guide (see **BotBoy writes
to your sets**). Generated analytics presets and lessons you adopt are written
for you, into the `analytics` set.

**First step: Settings → Knowledge → Create folder.** Nothing is created until
you click it. The default place is `~/Documents/BotBoy Knowledge`; type another
folder first if you prefer. macOS may ask once whether BotBoy can use your
Documents folder: choose **Allow**. If you chose Don't Allow, open System
Settings → Privacy & Security → Files and Folders, allow BotBoy (or the app that
starts it), then press **Rescan** on the page. **Change location** moves to
another place: it copies your sets across, checks every file, and only then
switches. The old folder is left exactly as it was; BotBoy never deletes it.
The `GUIDE.md` that Create folder puts at the top of the folder shows the
layout and the optional header (name, description, keywords, kind).

**Add a set.** Make a folder inside the Knowledge folder, put your `.md`,
`.txt`, `.yaml`, `.json` or `.sql` files in it (each up to 4 MB), and press
**Rescan**. Without a guide the set is listed as "No guide yet" and its files
are still usable. A `GUIDE.md` in the set's folder makes it a full set: BotBoy
reads its file table, the one-line summary of each file, and its rules ("Do NOT
…"). You can write a guide by hand in any editor; it needs a title and a table
of files. Keep secrets out: BotBoy refuses to load a file that contains a
recognizable key or token.

**Analytics knowledge.** If you already keep data-table notes for BotBoy's
analytics work (notes in the analytics knowledge folder, generated presets,
adopted lessons), Settings → Knowledge offers to move them into the `analytics`
set. The move copies first, checks every file, and switches only if all of them
match; your old folder stays untouched and **Revert** switches back. Until you
move them nothing changes.

**BotBoy writes to your sets, under the set's guide.** Ask in chat ("add a note
about refunds to the shop reference", "make a set for my garden notes") and BotBoy
reads the set's guide first: the rules in it ("Do NOT …") are handed to the model
before it drafts, and a second model call (your *Document writing* model,
Settings → AI model) checks the result against the same guide. Only a clear
breach of a rule stops a change: BotBoy gets a short list of what to fix and
tries again, at most three times. If it still does not fit, the change waits for
you as a card with the open items, and you choose **Apply anyway**, **Dismiss** or
**Ask BotBoy to fix**; you stay the authority over your own guides. If the check
cannot run (no model, a timeout), the change waits as a card with **Retry
check**; BotBoy never applies a change unchecked.
**When it applies, and when it asks.** A change you asked for in your current
message is applied at once and recorded. Anything BotBoy thinks of itself while
it works (a fact it verified, a correction you gave, a new column it found, a
failure it worked around) arrives as a **card** in the chat and under **Settings →
Knowledge → Waiting for your decision**, and nothing is written until you press
**Apply**. Changes to a `GUIDE.md`, and anything BotBoy read in an email, a
message, a web page or a document before proposing it, never apply by
themselves: the card names where the text came from and shows the whole change,
and you apply it with **Review and apply**. A new set starts from a guide that
BotBoy drafts from the closest template for its kind (analytics, product,
research, memory or general); you read it and approve it before anything is
created. Automatic follow-up runs and background work can only propose.
**History and Undo.** Every change BotBoy makes is listed under **Settings →
Knowledge → History** with a diff, and **Undo** takes back the latest one (Undo
refuses if you edited the same file by hand afterwards, so it never erases your
edit). An edit you make in Finder or an editor is listed there too, as "Edited
outside BotBoy". History is kept on this Mac, outside the Knowledge folder, in
`~/.personal-productivity-tracker/`: it is included in a Time Machine backup of
your home folder, it is not synced by iCloud, and it is not part of the folder you
share or move. Where the Mac's developer tools provide git, the same history is
also browsable with git from the command shown on that page; without it BotBoy
keeps plain copies and Undo works the same. BotBoy has no delete: a file leaves a
set by being **archived** into the set's `_archive` folder, and removing a file for
good is yours to do in Finder. The only thing BotBoy removes is a folder that
archiving, moving or Undo has just left empty (so a set you undid or archived can
be created again); a folder that still holds anything stays.
**What BotBoy can and cannot do to the folder.** BotBoy never watches this
folder: its files do not become captures, project evidence or Today items. The
commands BotBoy runs for you (the `run_command` tool, the chat terminal and MCP
servers you added with a command) can read the folder but cannot change it: its
own writes go through the checked, recorded path above.
Built-in connections and the browser BotBoy drives are not covered by that
protection. Whatever is in a guide or a file is untrusted text to BotBoy: it can
describe how files are organized, but it can never change what BotBoy is allowed
to do (approvals, the sandbox, sending).

**Backup and sync.** These are plain files. Time Machine backs them up, and
iCloud Drive syncs them if it syncs your Documents folder. If you do not want
that, use **Change location** before you add anything private. BotBoy itself
syncs nothing, and `./start.sh --update` never touches this folder or its History.

**Reset or removal.** Deleting `~/.personal-productivity-tracker/` (a factory
reset) does not delete the Knowledge folder, but it does delete its History.
Afterwards press **Create folder** with the same location and confirm that it
already holds files. To remove the folder, delete it in Finder; nothing else
depends on it, except the `analytics` set if you moved your analytics knowledge
into it (Revert first, or keep a copy).
**History keeps older copies.** Taking text out of a file, or removing the whole
folder, does not remove the copies History made before. It keeps the older version
of every file BotBoy changed (the newest 200 changes, within 100 MB) in
`~/.personal-productivity-tracker/knowledge-history/` and, where git is available,
every version in `~/.personal-productivity-tracker/knowledge-history.git`. To erase
something for good (a personal fact in a memory set, say), remove the text, quit
BotBoy, and delete those two items; History then starts empty.

### Optional local tools

- **Pandoc** is optional. Markdown downloads work without it. For Word, PDF,
  or HTML document export, BotBoy offers an in-app Homebrew installation, or
  you can run `brew install pandoc`.
- **BotBoy.app** is installed automatically on first start. It is a small
  prebuilt launcher that ships with BotBoy: nothing is compiled on your Mac, and
  no developer tools are needed on macOS 13 or newer (macOS 12 gets a simpler
  launcher without the persistent Dock icon, or a built one if the Command Line
  Tools are installed). The app has no folder built in: it opens the BotBoy
  folder recorded in `~/.personal-productivity-tracker/app-checkout.v1`, and
  `./start.sh` keeps that file current. If you move the BotBoy folder, open
  Terminal, go to the folder and run `./start.sh`: it points the app at the folder
  you ran it from. If the app is missing, run `./start.sh` (it installs the app when
  it is missing); if you use your own Node, `npm run app:bundle` in `~/botboy-app`
  rebuilds it by hand.


`./start.sh` also upgrades an older BotBoy.app to this launcher by itself the next
time it runs from the same folder (the old one is kept in
`~/.personal-productivity-tracker/app-launcher-backup`), and it never takes the app
from another BotBoy folder that still exists. The new launcher is a different program
from the old one, so the first time you open BotBoy from its icon after the upgrade,
macOS may ask again for access to files and folders or to automation: allow it, as
before.

On a Mac with Apple silicon, BotBoy, its Node server, and its debug Chrome run
natively, not under Rosetta. If Terminal or an older `BotBoy.app` starts
`./start.sh` under Rosetta, it relaunches itself natively. It also adds the
architecture setting to `/Applications/BotBoy.app` by itself, without
developer tools. That change reaches the app the next time it opens: quit and
reopen BotBoy. `./start.sh --doctor` shows each of these on its `hardware`,
`this shell`, `chrome arch`, `node arch`, and `app launcher` lines.

BotBoy reads the text of PDFs on every Mac: its pdf.js reader is installed by
`npm install`, and `./start.sh` installs it after an update if it is missing.
The reader for text inside images and scanned PDFs (OCR) also ships prebuilt, for
Apple silicon and Intel Macs on macOS 13 or newer: nothing is built on your Mac and
no developer tools are needed. `./start.sh --doctor` shows it on its `ocr helper:`
row (which reader is in use and, when it is off, why and what to do) and on its
`pdf readers` row. Only a Mac that cannot use the prebuilt reader (macOS 12, or a
file macOS refuses to run) builds one, in the background after the BotBoy window is
open and only when the Command Line Tools are installed; the build gets two minutes
at most (`BOTBOY_OCR_BUILD_TIMEOUT_SECONDS` changes that), and BotBoy remembers the
outcome instead of trying again at every start. Without any reader BotBoy records
scanned pages and images as unread rather than guessing, reads them the next time
they change, and still reads text PDFs. To check again now, install the macOS
updates under **System Settings > General > Software Update**, then run:

```bash
cd ~/botboy-app
./start.sh --rebuild-ocr
```

If you downloaded BotBoy as a ZIP in a browser, macOS marks every file as
downloaded. `./start.sh` clears that mark on BotBoy's `native` folder before anything
runs, and never runs a reader or launcher whose mark it cannot clear; if the doctor
says the mark is still there, run:

```bash
xattr -r -d com.apple.quarantine ~/botboy-app/native
```

(`git clone` and `./start.sh --update` never set that mark.)

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
| `node not found` | You ran `--stop`, `--doctor`, `--recover-shutdown`, `--open-window` or `--rebuild-ocr` on a Mac with no Node yet: those never download. Run `./start.sh` first; it sets up BotBoy's own Node (see **Start here**). With `BOTBOY_NODE_RUNTIME=system` set, install Node 24 or newer from nodejs.org (the LTS download; its installer needs no other tools) and rerun `./start.sh`. |
| `Could not reach nodejs.org to download Node`, `Your network is replacing secure connections`, or `The download of Node was interrupted` | BotBoy needs one 50 MB download from nodejs.org. Check your internet connection, VPN or proxy, or try another network (a phone hotspot works), then run `./start.sh` again; it resumes an interrupted download. Or install Node 24 or newer from nodejs.org yourself (the LTS download) and run `./start.sh`. |
| `BotBoy deleted the Node download: its checksum does not match` | The file was damaged on the way or a network altered it; nothing was unpacked or run. Try another network and run `./start.sh` again. If it repeats, tell the owner. |
| `BotBoy's Node v… needs macOS 13.5 or newer` | BotBoy's own Node needs macOS 13.5 or newer. Update macOS in System Settings > General > Software Update (on macOS 13 Ventura, 13.5 or newer is a free update), then run `./start.sh` again. Only if your Mac cannot update: install Node 22 from nodejs.org, run `sudo npm install -g npm@11` once in Terminal (it asks for your Mac password; Node 22's own npm 10.9 cannot do BotBoy's first install), then run `./start.sh`. |
| `Not enough free disk space to set up BotBoy's Node` | Free about 1 GB, then run `./start.sh` again. |
| `npm install` fails with `Cannot read properties of null (reading 'edgesOut')` | A Node 22 you installed yourself comes with npm 10.9.x, which cannot do the first install of BotBoy's packages (an npm bug). Install Node 24 or newer from nodejs.org (the LTS download), or update npm with `npm install -g npm@11`. On a Mac with no Node, or whose Node cannot install BotBoy, `./start.sh` already uses its own and needs none of this. |
| A server you added in BotBoy starts with `npx`, `npm` or a `#!/usr/bin/env node` script | Nothing to install. When BotBoy uses its own Node, the servers you add use it too: they can read BotBoy's Node folder (`~/.personal-productivity-tracker/runtime`) and nothing else in BotBoy's private folder, so `npx`, `npm` and node scripts run there. If one still fails with `Operation not permitted`, run `./start.sh --doctor` and send its `node source:` and `node runtime:` lines to the owner. |
| In a BotBoy chat command or the chat terminal, `nvm` says it is not compatible with the `npm_config_prefix` environment variable | Expected when BotBoy uses its own Node: its chat commands set `npm_config_prefix` so that `npm install -g` lands in `~/.npm-global`, and nvm refuses to run beside it. Run nvm in your own Terminal instead, outside BotBoy; chat commands already have BotBoy's Node. |
| A server you added in BotBoy by its program name says `Command not found` | The message says the next step. For an npm program, ask BotBoy in chat to install it (`npm install -g`; on a Mac that uses BotBoy's own Node it lands in `~/.npm-global`, which BotBoy looks in last), then press Start again. For a Python program, ask BotBoy to install it with `uv tool install` (or `pip install`): it lands in `~/.botboy-python/bin`, which BotBoy also looks in last. `Command not found: uvx` (or `uv`, `python3`) means BotBoy has not set up its own uv and Python on this Mac yet: run `./start.sh` while online (`./start.sh --doctor`, rows `uv source:` and `python source:`), or install them yourself, then press Start. |
| A server you added in BotBoy starts with `uvx`, `uv run` or `python3` | Nothing to install. When BotBoy uses its own uv and Python, the servers you add use them too: they can read BotBoy's Python folders and nothing else in BotBoy's private folder, and what they install goes to `~/.botboy-python`. |
| `Could not reach github.com to download BotBoy's Python`, `BotBoy's Python is still downloading`, or `The download of BotBoy's Python was interrupted` | BotBoy started without Python; nothing is lost. Run `./start.sh` again while online: it resumes the download in the background. Chat's Python and Python servers work from that start on. |
| `Your network is replacing secure connections to github.com` | A company proxy inspects HTTPS. Try another network (for example a phone hotspot) and run `./start.sh` again, or ask IT. Once BotBoy's Python is set up, Python work behind such a proxy may need the proxy's root certificate: `UV_SYSTEM_CERTS=1` makes uv use the certificates macOS trusts (uv 0.11 or newer), and `SSL_CERT_FILE=<a PEM file with that root>` does the same for Python's own HTTPS requests (set either in chat, or in a server's environment). |
| `BotBoy deleted a download of its Python: its checksum does not match` | The file was damaged on the way or a network altered it; nothing was unpacked or run, and BotBoy started without Python. Try another network and run `./start.sh` again. If it repeats, tell the owner. |
| `Not enough free disk space to set up BotBoy's Python` | Free about 1 GB, then run `./start.sh` again. BotBoy runs without Python until then. |
| `No interpreter found for Python 3.14` (or another version) in chat | BotBoy's uv uses only BotBoy's Python 3.13. For another version: `uv python install 3.14 --install-dir ~/.botboy-python/python`, then pass `--python ~/.botboy-python/bin/python3.14` (asked for by version, that Python is not found). |
| `pip` says `externally-managed-environment` and `BotBoy keeps its own Python read-only` | That pip runs outside BotBoy's chat. Use a virtual environment: `python3 -m venv .venv && .venv/bin/pip install <package>` (or `uv venv`, then `uv pip install <package>`). In BotBoy's chat a plain `pip install` works. |
| Chat says it needs an AI model first | Open **Settings → AI model** and add an OpenAI, DeepSeek or Anthropic (Claude) API key, or put the owner's credential attachment in Downloads and rerun `./start.sh`. |
| Settings → AI model says OpenAI, DeepSeek or Anthropic rejected the key | Copy a current key from platform.openai.com/api-keys, platform.deepseek.com/api_keys or platform.claude.com/settings/keys and save it again. |
| Settings → AI model says the account has no credit | Add credit in OpenAI Billing, top up the DeepSeek account, or add credit at platform.claude.com/settings/billing. BotBoy resumes on its own once calls succeed. |
| Settings → AI model says the Claude key is an Admin key, or is not tied to one workspace | Create a regular API key in the Anthropic Console (Settings → API keys → Create key), choose a workspace when you create it, and save that key in the **Anthropic (Claude)** card. |
| Settings → AI model cannot reach api.openai.com, api.deepseek.com or api.anthropic.com | Check your internet connection and any proxy or VPN rules for that host, then save again. `./start.sh --doctor` prints an `openai probe` / `deepseek probe` / `anthropic probe` status. The message names the cause in brackets (for example `ETIMEDOUT`); **When a provider call fails** above says what to read and run next. |
| Images are not inspected | The organizing model is text-only (for example DeepSeek V4 Pro). Choose an image-capable organizing model in **Settings → AI model → Background work**. |
| Build fails on a clean clone | Run `./start.sh` again; it installs the packages itself, with the Node `./start.sh --doctor` names under `node source:`. The errors are at the end of `/tmp/ppt.log`. |
| `BotBoy did not start: its native modules do not work with Node …` | BotBoy already reinstalled them once and did not start, so nothing needs recovery. Read the errors at the end of `/tmp/ppt.log` (BotBoy ran `npm install` with the Node `./start.sh --doctor` names under `node source:`), fix what they name, then `./start.sh`. On your own Node 20, install Xcode Command Line Tools first (`xcode-select --install`). |
| BotBoy took a long time to open, `/tmp/ppt.log` is full of Swift messages, the doctor says `OCR helper build failed`, or its `ocr helper:` row says `OFF` | Older releases built the optional reader for images and scanned PDFs on your Mac. It now ships prebuilt and BotBoy never waits for it: run `./start.sh --update`. If the `ocr helper:` row of `./start.sh --doctor` still says `OFF`, it names the reason and the next step: usually macOS older than 13 (install the updates in **System Settings > General > Software Update**), a damaged or edited `native` folder (`./start.sh --update`), or a download mark on the reader (next row). Then run `./start.sh --rebuild-ocr`. BotBoy works without the reader; only text inside images and scanned PDFs is missing. |
| macOS says a BotBoy file was "downloaded from the internet" or "can't be opened", or the doctor's `ocr helper:` row says the download mark is still on the reader | You downloaded BotBoy as a ZIP in a browser. Run `xattr -r -d com.apple.quarantine ~/botboy-app/native`, then `./start.sh`. A `git clone` never has this problem. |
| BotBoy.app says "BotBoy launcher is stale", or opens the wrong BotBoy folder | You moved the BotBoy folder, or you have more than one. Open Terminal, go to the folder you want and run `./start.sh`: it points the app at that folder (it never takes the app from another folder that still exists; remove `/Applications/BotBoy.app` and run `./start.sh` there if you want to switch on purpose). `./start.sh --doctor` shows the folder on its `app launcher:` row. |
| `npm audit` lists vulnerabilities in an existing install | Run `npm install` once in `~/botboy-app` (with your own Node; if BotBoy uses its own, `./start.sh --doctor` names the folder whose `bin/npm` to run). `./start.sh --update` updates BotBoy but only installs packages that are missing or re-pinned, so older ones stay until you do. |
| `Incomplete OAuth config` | Download the owner's credential attachment again and rerun `./start.sh`. |
| `invalid_client` / HTTP 400 | Ask the owner for a valid credential attachment. |
| Chat returns HTTP 401 | Ask the owner to check gateway access. |
| Dashboard does not open | Confirm Google Chrome is installed and inspect `/tmp/ppt.log`. |
| Chrome shows `ERR_CONNECTION_REFUSED` | Do not keep refreshing. Run `./start.sh --update`, then `./start.sh`; if startup reports failure, run `./start.sh --doctor` and share only the reviewed relevant output. |
| `Replacement start blocked` / `shutdown recovery: BLOCKED` | Run `./start.sh --recover-shutdown`, then `./start.sh`. Do not delete the guard yourself; deleting and re-cloning `botboy-app` does not clear it. See **Unverified shutdown recovery** below. |
| BotBoy.app is missing | Run `./start.sh` (it installs the app when it is missing); with your own Node, `npm run app:bundle` rebuilds it by hand. BotBoy itself can still run from Terminal. |
| Activity Monitor shows BotBoy, `node`, or Chrome as **Intel**, the Mac feels slow, or the doctor says `this shell: translated (Rosetta)`, `chrome arch: x86_64 only`, or `architecture priority: missing` | Run `./start.sh --update` in `~/botboy-app`, then quit and reopen BotBoy. Starting from `./start.sh` relaunches BotBoy and its Chrome natively and fixes the app's architecture setting by itself, but a Chrome that is already running as Intel is never restarted for you: quit it once (⌘Q), then start BotBoy again. If the doctor still reports an Intel-only Chrome (Migration Assistant can copy the Intel build), install **Chrome for Mac with Apple chip** from google.com/chrome and replace the app. An Intel-only Node needs an Apple-silicon Node (the nodejs.org installer, or Homebrew in `/opt/homebrew`). Terminal set to **Open using Rosetta** is handled, but you can clear that box in its Get Info. This was verified on macOS 26 only. |
| BotBoy.app still starts under Rosetta after the update | Start BotBoy once from Terminal with `./start.sh` so it can patch the app, then quit and reopen BotBoy. Without developer tools you can apply the same change by hand: `/usr/libexec/PlistBuddy -c "Delete :LSArchitecturePriority" /Applications/BotBoy.app/Contents/Info.plist` (an error is fine), then `/usr/libexec/PlistBuddy -c "Add :LSArchitecturePriority array" -c "Add :LSArchitecturePriority:0 string arm64" -c "Add :LSArchitecturePriority:1 string x86_64" /Applications/BotBoy.app/Contents/Info.plist`, then `touch /Applications/BotBoy.app`. Deleting the app (`rm -rf /Applications/BotBoy.app`) and running `npm run app:bundle` only helped Macs with developer tools before this update; after it, BotBoy patches the app itself, and a regenerated app carries the setting on every Mac. |
| BotBoy slows its browser capture, or the doctor shows `memory pressure: warn` or `swap used` | The Mac is short of memory. BotBoy polls less often until pressure drops, then returns to normal on its own. Close other apps, or choose **Pause** on **Connections → Browser capture** to stop reading your tabs until you resume. |
| A connection card is missing | Run `./start.sh --update`, then reopen BotBoy. |
| Gmail shows **Reconnect needed** | Google ended BotBoy's access: you changed your Google password, you removed BotBoy from your Google account, or your app was in testing for 7 days. Open **Connections → Gmail** and choose **Reconnect**. To stop the 7-day sign-outs, publish the app (step 2 under **Gmail**). `./start.sh --doctor` prints a `gmail refresh probe` status; `400 invalid_grant` means Reconnect. |
| BotBoy says it may not draft or send, or the Gmail page shows **Reconnect to allow drafting and sending** | The connection has read access only. Choose **Reconnect** and leave **Manage drafts and send emails** ticked on Google's screen. |
| The Gmail page asks for a Google OAuth client although Gmail worked before, or the doctor says only the retired shared client is saved | BotBoy no longer uses a shared Google client. Create your own client (steps under **Gmail**), choose its JSON file, then choose **Connect Gmail**. |
| Google or the Gmail page shows `redirect_uri_mismatch` or `invalid_client`, or says the file is for a Web application client | The saved client is not a **Desktop app** client, or its ID or secret is wrong. Create a Desktop app client and choose its JSON file (or save its ID and secret) again. |
| Google shows `access_denied` when you connect Gmail | You chose Cancel, or a test-mode app admits only its listed test users. Connect again and choose **Allow**; or publish your app, or add your address under **Audience → Test users**. |
| Connecting Gmail, Google Drive, or Slack says BotBoy couldn't reach the service (a timeout such as `ETIMEDOUT`) while your browser reaches it fine | BotBoy waits up to 2 seconds for each connection attempt; Node's own limit is 0.25 seconds, which is too short on some networks. `./start.sh --doctor` prints the `node connect timeout:` and `connect probe:` lines. To wait longer or shorter (250 to 10000 ms), start BotBoy with `BOTBOY_NET_ATTEMPT_TIMEOUT_MS=5000 ./start.sh`. |

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
./start.sh
```

`./start.sh` installs the packages and BotBoy.app itself. After verifying the replacement, review the timestamped backup with the owner
before deleting it. Do not delete `~/.personal-productivity-tracker/` unless
the owner explicitly asks for a factory reset; that directory contains local
evidence and credentials.

### Privacy and network boundaries

BotBoy is local-first. Its evidence database, document copies, generated files,
and credentials stay under `~/.personal-productivity-tracker/` on your Mac by
default. Content needed for an LLM request—including selected text and bounded
visual inputs when you ask BotBoy to inspect an image—goes to the model doing
that work: through the authenticated team gateway, or to OpenAI, DeepSeek or
Anthropic (Claude) under your own account when one of your saved keys' models is
chosen in chat or in **Settings → AI model**. Connections communicate with
the services you enable; Gmail talks only to Google's sign-in and Gmail API
endpoints, and mail BotBoy reads for a chat answer goes to the chat model like
any other content. A remote MCP server you add receives the arguments of
every call BotBoy makes to it; BotBoy sends its saved keys only to that
server and never follows it to another site. When BotBoy looks up a server
for you, only the search words go to the official MCP Registry. Any document publication, message draft or send, or
production pipeline change requires your explicit request and follows its own
review/approval boundary.

Your Knowledge folder (**Settings → Knowledge**) follows the same rule: its files stay
on this Mac and are never watched or captured, and a file leaves only when a chat
or job opens it, to the model doing that work (see **Your knowledge folder**).

### Lost laptop or suspected exposure

Tell the owner immediately so access can be disabled. Do not post credential
files or their contents in a channel.
