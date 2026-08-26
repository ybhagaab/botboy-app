#!/bin/bash
# BotBoy — Personal Productivity Tracker Launcher
#
# Modes:
#   ./start.sh               background: start server detached, open the
#                            dashboard window, exit (CLI use)
#   ./start.sh --stop        stop every running BotBoy server and exit
#   ./start.sh --doctor      print a diagnostic report (paste it when asking
#                            for help) and exit; changes nothing
#   ./start.sh --foreground  stay in the foreground for the lifetime of the
#                            server. Used by /Applications/BotBoy.app so the
#                            app owns the tracker's lifecycle: its dock icon
#                            persists while running and quitting it shuts the
#                            server down gracefully.
#                            Regenerate that bundle with: npm run app:bundle

FOREGROUND=0
OPEN_WINDOW_ONLY=0
STOP_ONLY=0
DOCTOR=0
[ "$1" = "--foreground" ] && FOREGROUND=1
# --open-window: just focus/open the dashboard window (used when BotBoy.app's
# dock icon is clicked while the tracker is already running).
[ "$1" = "--open-window" ] && OPEN_WINDOW_ONLY=1
[ "$1" = "--stop" ] && STOP_ONLY=1
[ "$1" = "--doctor" ] && DOCTOR=1

# Resolve the project dir from THIS script's location — never hardcode, or the
# launcher silently breaks the moment the repo moves.
PROJ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# File-descriptor headroom. macOS defaults the soft limit to 256. Folder
# watching is O(1) descriptors per folder since the native FSEvents engine
# (folder-watch-scaling), but the server still juggles sockets, MCP child
# processes, SQLite, and parser subprocesses — keep generous headroom.
ulimit -n 10240 2>/dev/null || ulimit -n "$(ulimit -Hn)" 2>/dev/null || true
LOG_FILE="/tmp/ppt.log"
PID_FILE="/tmp/ppt.pid"
DEBUG_PROFILE="$HOME/.chrome-debug-profile"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
export PATH="$HOME/homebrew/bin:$HOME/.local/bin:$HOME/.toolbox/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

# Resolve node without hardcoding any machine-specific path. BotBoy.app
# launches with a minimal PATH, so check PATH first, then the layouts of
# common installers (n, nvm, homebrew, system). The globs pick the newest
# installed version. nvm matters for teammates: nvm only exists after its
# shell init runs, so `command -v node` fails in app launches and bare
# shells — that produced ':x: node not found' on a machine with a
# perfectly good nvm-managed Node 22 (2026-08-24).
NODE="$(command -v node)"
if [ -z "$NODE" ]; then
  for candidate in "$HOME"/n/n/versions/node/*/bin/node "$HOME"/.n/versions/node/*/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$candidate" ] && NODE="$candidate"
  done
fi
if [ -z "$NODE" ]; then
  echo "❌ node not found — install Node 20+ (e.g. brew install node), then re-run ./start.sh" | tee -a "$LOG_FILE"
  exit 1
fi
# Make the chosen node's bin dir visible to child processes (npm, npx).
PATH="$(dirname "$NODE"):$PATH"
export PATH

server_is_up() {
  curl -s -o /dev/null -w "%{http_code}" http://localhost:7778/ 2>/dev/null | grep -q 200
}

# 0. Ensure AEA native messaging host is in debug profile (needed for Midway SSO)
AEA_SRC="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/amazon_enterprise_access.json"
AEA_DST="$DEBUG_PROFILE/NativeMessagingHosts/amazon_enterprise_access.json"
if [ -f "$AEA_SRC" ] && [ ! -f "$AEA_DST" ]; then
  mkdir -p "$DEBUG_PROFILE/NativeMessagingHosts"
  cp "$AEA_SRC" "$AEA_DST"
fi

# 1. Start debug Chrome if not already running
if ! curl -s http://127.0.0.1:9222/json >/dev/null 2>&1; then
  "$CHROME" \
    --remote-debugging-port=9222 \
    --user-data-dir="$DEBUG_PROFILE" \
    --no-first-run --no-default-browser-check >/dev/null 2>&1 &
  # A cold Chrome start can take well over a fixed sleep (first launch after
  # boot, profile migrations). Wait until the DevTools endpoint actually
  # answers so open_dashboard_window never runs before Chrome is ready —
  # that race is why launches used to open Chrome without a BotBoy window.
  for _ in $(seq 1 20); do
    curl -s --max-time 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1 && break
    sleep 1
  done
fi

# Teammate zero-config: if a downloaded botboy-credentials*.env is sitting in
# ~/Downloads or ~/Desktop, fold it into ~/.personal-productivity-tracker/.env
# (and delete the download) before settings are loaded. No-op otherwise.
bash "$PROJ_DIR/scripts/import-credentials.sh" 2>&1 | tee -a "$LOG_FILE" || true

# Load only inference-related local settings before selecting provider defaults.
# Do not source this file: values are parsed as data and only allowlisted keys
# are exported. A non-empty value supplied by the launching shell always wins.
load_local_runtime_settings() {
  local env_file="$HOME/.personal-productivity-tracker/.env"
  local line=""
  local key=""
  local value=""

  [ -f "$env_file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ ^([A-Z_]+)=(.+)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      case "$key" in
        BOTBOY_INFERENCE_*|BOTBOY_LOCAL_LLM_FALLBACK|BOTBOY_LLM_PROMPT_LOG|VLLM_*|LLM_FALLBACK_ENABLED|OLLAMA_*|AWS_BEARER_TOKEN_BEDROCK|AWS_CLI_BIN|PPT_WRITE_FILE_MAX_CHARS|CHAT_MAX_COMPLETION_TOKENS)
          ;;
        *)
          continue
          ;;
      esac

      value="${value#"${value%%[![:space:]]*}"}"
      value="${value%"${value##*[![:space:]]}"}"
      if [ -z "${!key}" ]; then
        printf -v "$key" '%s' "$value"
        export "$key"
      fi
    fi
  done < "$env_file"
}
load_local_runtime_settings
unset -f load_local_runtime_settings

# Shared inference provider. All generative paths (chat, rolling summaries,
# librarian routing, project brains, reconciliation, and organization) use the
# same provider/model. Preserve an explicit provider; otherwise infer legacy
# vLLM intent before applying any Bedrock defaults.
if [ -z "${BOTBOY_INFERENCE_PROVIDER:-}" ]; then
  INFERENCE_ENDPOINT_HINT="${BOTBOY_INFERENCE_ENDPOINT:-${VLLM_ENDPOINT:-}}"
  if [ "${VLLM_AUTH_MODE:-}" = "sigv4" ] || [[ "$INFERENCE_ENDPOINT_HINT" == *"bedrock-runtime."* ]] || [[ "$INFERENCE_ENDPOINT_HINT" == *"bedrock-mantle."* ]]; then
    BOTBOY_INFERENCE_PROVIDER="bedrock"
  elif [ -n "${BOTBOY_INFERENCE_OAUTH_CLIENT_ID:-}" ] || [ -n "${BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET:-}" ]; then
    # Teammate mode: OAuth client credentials imply the authenticated gateway.
    BOTBOY_INFERENCE_PROVIDER="gateway"
  elif [ "${VLLM_AUTH_MODE:-}" = "apiKey" ] || [ "${VLLM_AUTH_MODE:-}" = "apikey" ] || [ -n "$INFERENCE_ENDPOINT_HINT" ]; then
    BOTBOY_INFERENCE_PROVIDER="openai-compatible"
  else
    BOTBOY_INFERENCE_PROVIDER="bedrock"
  fi
fi
export BOTBOY_INFERENCE_PROVIDER

# Local fallback is opt-in. Keep the legacy alias working when the product
# setting is absent, but never overwrite an explicitly supplied product value.
if [ -z "${BOTBOY_LOCAL_LLM_FALLBACK+x}" ]; then
  BOTBOY_LOCAL_LLM_FALLBACK="${LLM_FALLBACK_ENABLED:-0}"
fi
export BOTBOY_LOCAL_LLM_FALLBACK

# Provider-specific defaults. Bedrock Mantle + Luna Responses is primary.
# Pointing Bedrock at the legacy bedrock-runtime host explicitly selects the
# previous Kimi Chat Completions profile, preserving a configuration-only
# rollback. Gateway has no endpoint default because deployment owns its URL.
case "$BOTBOY_INFERENCE_PROVIDER" in
  bedrock)
    export BOTBOY_INFERENCE_ENDPOINT="${BOTBOY_INFERENCE_ENDPOINT:-${VLLM_ENDPOINT:-https://bedrock-mantle.us-east-1.api.aws/openai/v1}}"
    if [ -z "${BOTBOY_INFERENCE_API_MODE:-}" ]; then
      if [[ "$BOTBOY_INFERENCE_ENDPOINT" == *"bedrock-runtime."* ]]; then
        BOTBOY_INFERENCE_API_MODE="chat-completions"
      else
        BOTBOY_INFERENCE_API_MODE="responses"
      fi
    fi
    export BOTBOY_INFERENCE_API_MODE
    case "$BOTBOY_INFERENCE_API_MODE" in
      responses)
        export BOTBOY_INFERENCE_MODEL="${BOTBOY_INFERENCE_MODEL:-${VLLM_MODEL:-openai.gpt-5.6-luna}}"
        export BOTBOY_INFERENCE_DIALECT="${BOTBOY_INFERENCE_DIALECT:-${VLLM_DIALECT:-openai}}"
        export BOTBOY_INFERENCE_REASONING_EFFORT="${BOTBOY_INFERENCE_REASONING_EFFORT:-${VLLM_REASONING_EFFORT:-low}}"
        export BOTBOY_INFERENCE_MAX_CONTEXT_TOKENS="${BOTBOY_INFERENCE_MAX_CONTEXT_TOKENS:-${VLLM_MAX_CONTEXT_TOKENS:-1000000}}"
        ;;
      chat-completions)
        export BOTBOY_INFERENCE_MODEL="${BOTBOY_INFERENCE_MODEL:-${VLLM_MODEL:-moonshotai.kimi-k2.5}}"
        export BOTBOY_INFERENCE_DIALECT="${BOTBOY_INFERENCE_DIALECT:-${VLLM_DIALECT:-kimi}}"
        export BOTBOY_INFERENCE_MAX_CONTEXT_TOKENS="${BOTBOY_INFERENCE_MAX_CONTEXT_TOKENS:-${VLLM_MAX_CONTEXT_TOKENS:-262144}}"
        ;;
      *)
        echo "❌ Unsupported BOTBOY_INFERENCE_API_MODE: $BOTBOY_INFERENCE_API_MODE" | tee -a "$LOG_FILE"
        exit 1
        ;;
    esac
    ;;
  openai-compatible)
    export BOTBOY_INFERENCE_API_MODE="${BOTBOY_INFERENCE_API_MODE:-chat-completions}"
    export BOTBOY_INFERENCE_MODEL="${BOTBOY_INFERENCE_MODEL:-${VLLM_MODEL:-/app/models/qwen35-35b-a3b-fp8}}"
    export BOTBOY_INFERENCE_DIALECT="${BOTBOY_INFERENCE_DIALECT:-${VLLM_DIALECT:-qwen}}"
    export BOTBOY_INFERENCE_MAX_CONTEXT_TOKENS="${BOTBOY_INFERENCE_MAX_CONTEXT_TOKENS:-${VLLM_MAX_CONTEXT_TOKENS:-32768}}"
    ;;
  gateway)
    # Authenticated AgentCore gateway fronting Bedrock Mantle (Luna).
    # Endpoint, token URL, and scope are baked team defaults (not secrets —
    # the gateway 401s without a valid JWT). The ONLY per-person config is
    # BOTBOY_INFERENCE_OAUTH_CLIENT_ID/_CLIENT_SECRET (client-credentials JWT,
    # minted+cached by the app); a static BOTBOY_INFERENCE_API_KEY also works.
    # Model ids carry the gateway target prefix.
    export BOTBOY_INFERENCE_ENDPOINT="${BOTBOY_INFERENCE_ENDPOINT:-https://botboy-luna-gateway-tyagefrrnz.gateway.bedrock-agentcore.us-east-1.amazonaws.com/inference/v1}"
    export BOTBOY_INFERENCE_API_MODE="${BOTBOY_INFERENCE_API_MODE:-responses}"
    export BOTBOY_INFERENCE_MODEL="${BOTBOY_INFERENCE_MODEL:-bedrock-mantle-luna/openai.gpt-5.6-luna}"
    export BOTBOY_INFERENCE_DIALECT="${BOTBOY_INFERENCE_DIALECT:-openai}"
    export BOTBOY_INFERENCE_REASONING_EFFORT="${BOTBOY_INFERENCE_REASONING_EFFORT:-low}"
    export BOTBOY_INFERENCE_MAX_CONTEXT_TOKENS="${BOTBOY_INFERENCE_MAX_CONTEXT_TOKENS:-1000000}"
    ;;
esac

# 3. Open the dashboard in its own standalone window (Chrome "app mode": no
#    tab strip, no omnibox).
#
#    Invoke the Chrome BINARY directly — never `open -na`. The `-n` flag forces
#    a brand-new process, and two Chrome processes sharing one --user-data-dir
#    corrupt the profile's SQLite files ("Something went wrong when opening
#    your profile") and can leave the surviving process without
#    --remote-debugging-port, silently killing all browser capture.
#    Without `-n`, Chrome's singleton hands the command line to the ALREADY
#    RUNNING instance, which opens the app window in-process. (2026-08-05.)
open_dashboard_window() {
  # Tolerate a still-warming Chrome: retry the DevTools endpoint briefly
  # rather than deciding from a single probe.
  local devtools_up=1
  for _ in $(seq 1 5); do
    curl -s --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1 && { devtools_up=0; break; }
    sleep 1
  done
  if [ "$devtools_up" = "0" ]; then
    # Parse with node (always present — it runs the server); python3 is not a
    # BotBoy prerequisite and may be missing on a fresh machine.
    DASH_TARGET=$(curl -s --max-time 3 http://127.0.0.1:9222/json/list \
      | "$NODE" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const t=JSON.parse(d).filter(x=>String(x.url||'').includes('localhost:7778'));process.stdout.write(t.length?t[0].id:'')}catch{}})" 2>/dev/null)
    if [ -n "$DASH_TARGET" ]; then
      # A reused window keeps running whatever app.js it loaded at open time —
      # potentially weeks old (recurring gotcha: AGENT_FIX_LEARNINGS #1/#17/#18;
      # bit again 2026-08-25 as a "broken overlay"). ./start.sh means new code:
      # close the stale window and open a fresh one so the UI is current.
      curl -s --max-time 3 "http://127.0.0.1:9222/json/close/$DASH_TARGET" >/dev/null
      sleep 1
    fi
    "$CHROME" \
      --user-data-dir="$DEBUG_PROFILE" \
      --app="http://localhost:7778" >/dev/null 2>&1 &
    sleep 2
    echo "✅ Dashboard window ready: http://localhost:7778"
  else
    echo "⚠️  Debug Chrome not reachable on :9222 — open http://localhost:7778 manually"
  fi
}

wait_for_server() {
  for _ in $(seq 1 20); do
    server_is_up && return 0
    sleep 1
  done
  return 1
}

# Teammate machines run the LLM through the gateway with per-person OAuth
# credentials. When neither those nor a Bedrock key are present, BotBoy still
# runs but chat/synthesis are dead — say so at startup instead of letting the
# owner debug "BotBoy has no LLM" from a screenshot. Owner machines with any
# credential source stay silent.
warn_if_no_llm_credentials() {
  local env_file="$HOME/.personal-productivity-tracker/.env"
  [ -n "${AWS_BEARER_TOKEN_BEDROCK:-}" ] && return 0
  [ -n "${BOTBOY_INFERENCE_API_KEY:-}" ] && return 0
  [ -n "${BOTBOY_INFERENCE_OAUTH_CLIENT_ID:-}" ] && return 0
  if [ -f "$env_file" ] && grep -qE '^(BOTBOY_INFERENCE_OAUTH_CLIENT_ID|AWS_BEARER_TOKEN_BEDROCK|BOTBOY_INFERENCE_API_KEY)=' "$env_file" 2>/dev/null; then
    return 0
  fi
  echo "⚠️  No LLM credentials found — BotBoy will run without chat/synthesis."
  echo "    Download your botboy-credentials file into ~/Downloads and re-run ./start.sh (it installs automatically)."
}

# Self-heal the Dock/Applications launcher: build /Applications/BotBoy.app on
# the first start after a clone (or after someone deletes the app). Runs only
# when the bundle is missing, after the dashboard is already open so it never
# delays startup, and a failure never breaks the tracker — the app is
# cosmetic + lifecycle convenience, not a runtime dependency.
install_app_bundle_if_missing() {
  [ -d "/Applications/BotBoy.app" ] && return 0
  [ -f "$PROJ_DIR/scripts/make-app-bundle.mjs" ] || return 0
  echo "ℹ️  Installing BotBoy.app into /Applications (first run)"
  if "$NODE" "$PROJ_DIR/scripts/make-app-bundle.mjs" >> "$LOG_FILE" 2>&1; then
    echo "✅ BotBoy.app installed — launch from Spotlight or the Dock next time"
  else
    echo "⚠️  Could not install BotBoy.app (see $LOG_FILE) — run: npm run app:bundle"
  fi
}

# Gracefully stop a server we are about to replace. SIGINT (not KILL) so the
# app's shutdown handler flushes SQLite and stops the monitors.
stop_existing_server() {
  # Stop EVERY running tracker, not just the pid-file one. Crash/freeze cycles
  # used to leak headless zombies (observed 2026-08-20: 12 stale processes,
  # one frozen instance still holding :7778 while a newer one answered pings),
  # because this used `pgrep | head -1`.
  local pids=""
  pids="$(pgrep -f 'node dist/index.js' 2>/dev/null)"
  [ -f "$PID_FILE" ] && pids="$pids $(cat "$PID_FILE" 2>/dev/null)"
  pids="$(echo "$pids" | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u)"
  [ -z "$pids" ] && return 0
  echo "ℹ️  Taking over from running tracker(s): $(echo "$pids" | tr '\n' ' ')— stopping gracefully"
  for pid in $pids; do kill -INT "$pid" 2>/dev/null; done
  for _ in $(seq 1 15); do
    local alive=0
    for pid in $pids; do ps -p "$pid" >/dev/null 2>&1 && alive=1; done
    [ "$alive" = "0" ] && break
    sleep 1
  done
  # Anything that survived graceful shutdown is wedged — force it off the port.
  for pid in $pids; do
    if ps -p "$pid" >/dev/null 2>&1; then
      echo "⚠️  pid $pid ignored SIGINT — killing"
      kill -9 "$pid" 2>/dev/null
    fi
  done
}

cd "$PROJ_DIR" || exit 1

if [ "$OPEN_WINDOW_ONLY" = "1" ]; then
  open_dashboard_window
  exit 0
fi

# ── --stop: clean shutdown of every tracker process ──
if [ "$STOP_ONLY" = "1" ]; then
  if ! pgrep -f 'node dist/index.js' >/dev/null 2>&1; then
    rm -f "$PID_FILE"
    echo "ℹ️  BotBoy is not running"
    exit 0
  fi
  stop_existing_server
  rm -f "$PID_FILE"
  echo "✅ BotBoy stopped"
  exit 0
fi

# ── --doctor: one-shot support report. Read-only; changes nothing ──
# Every teammate incident so far (missing build, native-module mismatch,
# missing UI assets, dead port, missing credentials) is visible in this
# output, so support starts from evidence instead of guesses.
if [ "$DOCTOR" = "1" ]; then
  echo "== BotBoy doctor — $(date) =="
  echo "macos: $(sw_vers -productVersion 2>/dev/null) ($(uname -m))"
  echo "node:  $NODE ($("$NODE" --version 2>/dev/null))"
  echo "npm:   $(command -v npm) ($(npm --version 2>/dev/null))"
  if xcode-select -p >/dev/null 2>&1; then echo "xcode-clt: installed"; else echo "xcode-clt: MISSING — run: xcode-select --install"; fi
  [ -x "$CHROME" ] && echo "chrome: installed" || echo "chrome: MISSING at $CHROME"
  [ -f "$PROJ_DIR/dist/index.js" ] && echo "build: dist/index.js present" || echo "build: MISSING — run: npm run build"
  [ -f "$PROJ_DIR/dist/ui/index.html" ] && [ -f "$PROJ_DIR/dist/ui/dashboard.css" ] && echo "ui-assets: present" || echo "ui-assets: MISSING/PARTIAL — run: npm run build"
  for mod in better-sqlite3 node-pty; do
    if "$NODE" -e "require('$mod')" >/dev/null 2>&1; then
      echo "native $mod: loads"
    else
      echo "native $mod: FAILS to load — run: npm rebuild $mod (needs Xcode CLT)"
    fi
  done
  # Folder watching rides FSEvents (native fs.watch recursive): ~1 fd per
  # watched FOLDER, independent of file count. A low limit here no longer
  # implicates watched-folder size — look at sockets/subprocesses instead.
  echo "fd limit: $(ulimit -n) (folder watching costs ~1 fd per folder)"
  # Managed MCP executables (installed via aim; searched the same way BotBoy
  # resolves them — PATH plus the AIM wrapper directory).
  if command -v amazon-sharepoint-mcp >/dev/null 2>&1 || [ -x "$HOME/.aim/mcp-servers/amazon-sharepoint-mcp" ]; then
    echo "sharepoint-mcp: installed"
  else
    echo "sharepoint-mcp: not installed (optional — install from Connections → SharePoint)"
  fi
  DOCTOR_ENV="$HOME/.personal-productivity-tracker/.env"
  if [ -f "$DOCTOR_ENV" ] && grep -q '^BOTBOY_INFERENCE_OAUTH_CLIENT_ID=' "$DOCTOR_ENV" 2>/dev/null; then
    echo "llm-credentials: present"
    # Live auth probe: mint a token with the stored pair. Prints ONLY the
    # HTTP status — never the credentials or the token. This is the line
    # that separates "file imported fine" from "agent not responding":
    #   200 = credentials valid and Cognito reachable
    #   400 = invalid_client — secret wrong/revoked, ask owner to reissue
    #   000 = network problem (VPN/proxy/DNS)
    DOCTOR_CID=$(grep '^BOTBOY_INFERENCE_OAUTH_CLIENT_ID=' "$DOCTOR_ENV" | head -1 | cut -d= -f2-)
    DOCTOR_SEC=$(grep '^BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET=' "$DOCTOR_ENV" | head -1 | cut -d= -f2-)
    DOCTOR_TOKEN_URL=$(grep '^BOTBOY_INFERENCE_OAUTH_TOKEN_URL=' "$DOCTOR_ENV" | head -1 | cut -d= -f2-)
    DOCTOR_TOKEN_URL=${DOCTOR_TOKEN_URL:-https://botboy-luna-603949561274.auth.us-east-1.amazoncognito.com/oauth2/token}
    if [ -n "$DOCTOR_CID" ] && [ -n "$DOCTOR_SEC" ]; then
      # Credentials go through a config file descriptor, not argv, so they
      # never appear in `ps` output.
      CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
        -K <(printf 'user = "%s:%s"\n' "$DOCTOR_CID" "$DOCTOR_SEC") \
        -d 'grant_type=client_credentials&scope=botboy-llm/invoke' \
        "$DOCTOR_TOKEN_URL" 2>/dev/null)
      echo "llm auth probe: HTTP ${CODE:-000} (200=valid, 400=invalid/revoked — ask owner, 000=network)"
    fi
  else
    echo "llm-credentials: missing or incomplete (~/.personal-productivity-tracker/.env)"
  fi
  PORT_PIDS=$(lsof -ti tcp:7778 -sTCP:LISTEN 2>/dev/null | tr '\n' ' ')
  echo "port 7778 listener: ${PORT_PIDS:-none}"
  for asset in / /dashboard.css /dashboard.js /app.js; do
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://localhost:7778$asset" 2>/dev/null)
    echo "http $asset: ${CODE:-no-response}"
  done
  echo "-- last 25 lines of $LOG_FILE --"
  tail -n 25 "$LOG_FILE" 2>/dev/null || echo "(no log file)"
  exit 0
fi

# ── Startup lock: mashing ./start.sh must not race itself ──
# The first run builds for ~1 min; a second run during that window used to
# start a second build and a second server. mkdir is atomic, so the first
# invocation wins and later ones exit with a pointer to the winner. A lock
# older than 10 min is from a crashed run — take it over.
LOCK_DIR="/tmp/ppt-start.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$LOCK_DIR" 2>/dev/null || echo 0) ))
  if [ "$LOCK_AGE" -lt 600 ]; then
    echo "ℹ️  Another ./start.sh is already running (started ${LOCK_AGE}s ago) — let it finish."
    echo "    Stuck? Run: ./start.sh --stop   (or remove $LOCK_DIR if no build is running)"
    exit 0
  fi
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null || exit 0
fi
release_start_lock() { rm -rf "$LOCK_DIR"; }
trap release_start_lock EXIT

# Build self-heal. Two triggers:
#   1. dist/index.js missing — fresh clone (dist/ is gitignored). Without
#      this, `node dist/index.js` dies instantly and the launcher still opens
#      a dashboard window onto a dead port.
#   2. dist/.build-commit differs from git HEAD — stale build after git pull.
#      Without this, pulled fixes silently never activate (the server keeps
#      running last week's code and everyone wonders why nothing changed).
NEED_BUILD=""
if [ ! -f "$PROJ_DIR/dist/index.js" ]; then
  NEED_BUILD="first run"
else
  CURRENT_COMMIT=$(git -C "$PROJ_DIR" rev-parse HEAD 2>/dev/null || echo "")
  BUILT_COMMIT=$(cat "$PROJ_DIR/dist/.build-commit" 2>/dev/null || echo "")
  if [ -n "$CURRENT_COMMIT" ] && [ "$CURRENT_COMMIT" != "$BUILT_COMMIT" ]; then
    NEED_BUILD="new code since last build"
  fi
fi
if [ -n "$NEED_BUILD" ]; then
  echo "ℹ️  Compiling BotBoy ($NEED_BUILD) — takes about a minute" | tee -a "$LOG_FILE"
  if ! npm run build >> "$LOG_FILE" 2>&1; then
    echo "❌ Build failed — see $LOG_FILE (try: npm install && npm run build)" | tee -a "$LOG_FILE"
    exit 1
  fi
  echo "✅ Build complete" | tee -a "$LOG_FILE"
fi

if [ "$FOREGROUND" = "1" ]; then
  # ── Foreground mode (app bundle) ──
  # The server runs as a child of THIS script and the script blocks on it, so
  # the launching .app stays alive (dock icon persists) for as long as the
  # tracker runs. Only one server may own port 7778, so an existing instance is
  # handed over first.
  server_is_up && stop_existing_server

  "$NODE" dist/index.js >> "$LOG_FILE" 2>&1 &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$PID_FILE"

  # Forward Quit/Ctrl-C to the server so shutdown stays graceful.
  trap 'echo "🔻 BotBoy quitting — stopping tracker (pid $SERVER_PID)" >> "$LOG_FILE"; kill -INT "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; exit 0' TERM INT HUP

  if wait_for_server; then
    open_dashboard_window
  else
    echo "⚠️  Server did not become ready in 20s — see $LOG_FILE"
  fi

  # Startup is done — release the lock now. Foreground mode blocks for the
  # app's lifetime, and holding the lock that long would wrongly turn away
  # every later ./start.sh (which should just focus the window).
  release_start_lock
  warn_if_no_llm_credentials
  install_app_bundle_if_missing

  # Block for the server's lifetime. `wait` returns early when a trapped signal
  # arrives, so the loop keeps the app alive until the server is really gone.
  while ps -p "$SERVER_PID" >/dev/null 2>&1; do
    wait "$SERVER_PID" 2>/dev/null
  done
  exit 0
fi

# ── Background mode (CLI default) ──
# A fresh build with the old server still running would serve last week's
# code — restart onto the new build.
if [ -n "$NEED_BUILD" ] && server_is_up; then
  echo "ℹ️  Restarting BotBoy on the new build"
  stop_existing_server
fi
# 2. Start the tracker server if not already running
if ! server_is_up; then
  # The health check failing does NOT mean no process exists: a wedged server
  # can hold :7778 without answering. Starting on top of it creates headless
  # zombies (bind fails, monitors keep running). Clear every old instance.
  stop_existing_server
  "$NODE" dist/index.js >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  wait_for_server
fi

open_dashboard_window
warn_if_no_llm_credentials
install_app_bundle_if_missing
