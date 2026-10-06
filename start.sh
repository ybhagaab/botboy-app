#!/bin/bash
# BotBoy — Personal Productivity Tracker Launcher
#
# BASH REQUIRED: this script uses bashisms (BASH_REMATCH, printf -v). Running
# it as `zsh ./start.sh` ignores the shebang and SILENTLY breaks the .env
# loader — zsh's =~ does not populate BASH_REMATCH, so zero keys load, and
# provider derivation falls back to defaults (live incident 2026-09-02: chat
# flipped gateway→bedrock and died overnight with the aws login session).
# Re-exec under bash when any other shell sourced or invoked us.
if [ -z "${BASH_VERSION:-}" ]; then
  exec /bin/bash "$0" "$@"
fi
#
# Modes:
#   ./start.sh               background: rebuild local source when needed,
#                            start/restart detached, open dashboard, exit
#   ./start.sh --stop        stop every running BotBoy server and exit
#   ./start.sh --doctor      print a diagnostic report (paste it when asking
#                            for help) and exit; changes nothing
#   ./start.sh --recover-shutdown
#                            explicit receipt-less legacy recovery: refuse live
#                            processes/DB handles, snapshot DB+WAL+SHM, verify
#                            a copy, archive the guard, and exit without start
#   ./start.sh --update      back up tracked BotBoy customizations, fast-forward
#                            the owner release, three-way reapply clean changes,
#                            preserve overlaps for rebase, rebuild, and start.
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
RECOVER_SHUTDOWN=0
UPDATE_ONLY=0
[ "$1" = "--foreground" ] && FOREGROUND=1
# --open-window: just focus/open the dashboard window (used when BotBoy.app's
# dock icon is clicked while the tracker is already running).
[ "$1" = "--open-window" ] && OPEN_WINDOW_ONLY=1
[ "$1" = "--stop" ] && STOP_ONLY=1
[ "$1" = "--doctor" ] && DOCTOR=1
[ "$1" = "--recover-shutdown" ] && RECOVER_SHUTDOWN=1
[ "$1" = "--update" ] && UPDATE_ONLY=1

# Resolve the project dir from THIS script's location — never hardcode, or the
# launcher silently breaks the moment the repo moves.
PROJ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Release checkouts are customizable runtime snapshots. Detect from the
# generated marker (current releases) or origin URL (backward compatibility).
BOTBOY_REMOTE_URL="$(git -C "$PROJ_DIR" remote get-url origin 2>/dev/null || true)"
if [ -f "$PROJ_DIR/.botboy-distribution" ] || [[ "$BOTBOY_REMOTE_URL" == *"/botboy-app.git" ]] || [[ "$BOTBOY_REMOTE_URL" == *"/botboy-app" ]]; then
  BOTBOY_RELEASE_CHECKOUT=1
else
  BOTBOY_RELEASE_CHECKOUT=0
fi

# Customization-aware teammate updater. BotBoy may legitimately modify tracked
# UI/source files. Preserve the full diff, fast-forward the release baseline,
# then three-way reapply each changed file independently. Cleanly applicable
# customizations stay live; conflicting ones remain safely archived for BotBoy
# or the owner to rebase. Untracked files are never deleted or moved.
if [ "$UPDATE_ONLY" = "1" ]; then
  if [ "$BOTBOY_RELEASE_CHECKOUT" != "1" ]; then
    echo "❌ --update is for botboy-app teammate checkouts only; update the development repo with Git directly."
    exit 1
  fi
  if ! git -C "$PROJ_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "❌ This botboy-app install is not a Git checkout. Re-clone it to update."
    exit 1
  fi
  UPDATE_SAFETY_BLOCK="${PPT_STARTUP_SAFETY_BLOCK:-/tmp/ppt-startup-safety-block.json}"
  if [ -f "$UPDATE_SAFETY_BLOCK" ]; then
    echo "❌ Update paused: an earlier shutdown is still unverified."
    echo "    Run: ./start.sh --doctor"
    echo "    Then: ./start.sh --recover-shutdown"
    echo "    The updater will not replace the existing guard or change Git state."
    exit 1
  fi

  BACKUP_PATH=""
  PATCH_PARTS_DIR=""
  TRACKED_CHANGES="$(git -C "$PROJ_DIR" status --porcelain --untracked-files=no)"
  if [ -n "$TRACKED_CHANGES" ]; then
    BACKUP_DIR="$HOME/.personal-productivity-tracker/update-backups"
    BACKUP_STAMP="$(date +%Y%m%d-%H%M%S)"
    BACKUP_PATH="$BACKUP_DIR/botboy-app-$BACKUP_STAMP.patch"
    PATCH_PARTS_DIR="$BACKUP_DIR/.parts-$BACKUP_STAMP"
    mkdir -p "$PATCH_PARTS_DIR"
    git -C "$PROJ_DIR" diff --binary HEAD -- . > "$BACKUP_PATH"
    PART_INDEX=0
    while IFS= read -r -d '' CHANGED_PATH; do
      PART_INDEX=$((PART_INDEX + 1))
      printf '%s' "$CHANGED_PATH" > "$PATCH_PARTS_DIR/$PART_INDEX.path"
      git -C "$PROJ_DIR" diff --binary HEAD -- "$CHANGED_PATH" > "$PATCH_PARTS_DIR/$PART_INDEX.patch"
    done < <(git -C "$PROJ_DIR" diff --name-only -z HEAD -- .)
    git -C "$PROJ_DIR" restore --source=HEAD --staged --worktree -- .
    echo "ℹ️  Backed up tracked BotBoy customizations to: $BACKUP_PATH"
  fi

  if ! git -C "$PROJ_DIR" pull --ff-only; then
    echo "❌ Update could not fast-forward. No untracked files were removed; inspect 'git status --short'."
    exit 1
  fi

  REAPPLIED=0
  CONFLICTS=0
  if [ -n "$PATCH_PARTS_DIR" ] && [ -d "$PATCH_PARTS_DIR" ]; then
    CONFLICT_DIR="${BACKUP_PATH%.patch}-needs-reapply"
    for PART_PATCH in "$PATCH_PARTS_DIR"/*.patch; do
      [ -f "$PART_PATCH" ] || continue
      PART_PREFIX="${PART_PATCH%.patch}"
      CHANGED_PATH="$(cat "$PART_PREFIX.path")"
      if git -C "$PROJ_DIR" apply --3way "$PART_PATCH" >/dev/null 2>&1 \
        && ! git -C "$PROJ_DIR" ls-files -u -- "$CHANGED_PATH" | grep -q .; then
        git -C "$PROJ_DIR" restore --staged -- "$CHANGED_PATH" 2>/dev/null || true
        REAPPLIED=$((REAPPLIED + 1))
      else
        # Three-way apply may report success while leaving conflict stages.
        # Restore only this path to the new release; its patch remains durable.
        git -C "$PROJ_DIR" restore --source=HEAD --staged --worktree -- "$CHANGED_PATH"
        mkdir -p "$CONFLICT_DIR"
        cp "$PART_PATCH" "$CONFLICT_DIR/$CONFLICTS.patch"
        printf '%s\n' "$CHANGED_PATH" > "$CONFLICT_DIR/$CONFLICTS.path"
        CONFLICTS=$((CONFLICTS + 1))
      fi
    done
    rm -rf "$PATCH_PARTS_DIR"
    if [ "$REAPPLIED" -gt 0 ]; then
      echo "✅ Reapplied $REAPPLIED customized tracked file(s) onto the new release"
    fi
    if [ "$CONFLICTS" -gt 0 ]; then
      echo "⚠️  $CONFLICTS customization(s) overlap the new release and were not applied."
      echo "    BotBoy is updated and usable; preserved conflict patches: $CONFLICT_DIR"
      echo "    Ask BotBoy or the owner to reapply those customizations against this version."
    fi
  fi

  echo "✅ BotBoy updated — rebuilding and starting"
  if [ "${BOTBOY_UPDATE_NO_START:-0}" = "1" ]; then
    exit 0
  fi
  export BOTBOY_FORCE_BUILD=1
  exec /bin/bash "$0"
fi

# File-descriptor headroom. macOS defaults the soft limit to 256. Folder
# watching is O(1) descriptors per folder since the native FSEvents engine
# (folder-watch-scaling), but the server still juggles sockets, MCP child
# processes, SQLite, and parser subprocesses — keep generous headroom.
ulimit -n 10240 2>/dev/null || ulimit -n "$(ulimit -Hn)" 2>/dev/null || true
LOG_FILE="${PPT_LOG_FILE:-/tmp/ppt.log}"
PID_FILE="${PPT_PID_FILE:-/tmp/ppt.pid}"
# Settings → AI model: the owner's OpenAI key, saved by the server (0600). The
# launcher only checks that it exists; it never reads it into a variable,
# argv, or the environment.
AI_MODEL_SETTINGS_FILE="$HOME/.personal-productivity-tracker/ai-model.json"
# BotBoy's shared Google client staged by scripts/import-credentials.sh; the
# server moves it into gmail.json at boot and deletes this file.
GMAIL_TEAM_CLIENT_INBOX="$HOME/.personal-productivity-tracker/gmail-team-client.json"
# Connections → Gmail: the Google OAuth client(s) and refresh token,
# saved by the server (0600). Only --doctor inspects it, inside node.
GMAIL_CREDENTIALS_FILE="$HOME/.personal-productivity-tracker/gmail.json"
STARTUP_SAFETY_BLOCK="${PPT_STARTUP_SAFETY_BLOCK:-/tmp/ppt-startup-safety-block.json}"
SHUTDOWN_RECEIPT_DIR="${PPT_SHUTDOWN_RECEIPT_DIR:-/tmp}"
STARTUP_INT_GRACE_SECONDS="${PPT_STARTUP_INT_GRACE_SECONDS:-20}"
STARTUP_TERM_GRACE_SECONDS="${PPT_STARTUP_TERM_GRACE_SECONDS:-10}"
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
  echo "❌ node not found — install Node 20.16+ (e.g. brew install node), then re-run ./start.sh" | tee -a "$LOG_FILE"
  exit 1
fi
# Make the chosen node's bin dir visible to child processes (npm, npx).
PATH="$(dirname "$NODE"):$PATH"
export PATH

# Packages package.json declares that node_modules lacks, or holds at another
# version than an exact pin. Space-separated; empty when everything is there.
missing_npm_dependencies() {
  "$NODE" -e '
    const fs = require("fs");
    const path = require("path");
    const dir = process.argv[1];
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const wanted = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const missing = [];
    for (const [name, spec] of Object.entries(wanted)) {
      let installed = null;
      try { installed = JSON.parse(fs.readFileSync(path.join(dir, "node_modules", name, "package.json"), "utf8")).version; } catch {}
      if (installed == null || (/^\d+\.\d+\.\d+$/.test(spec) && installed !== spec)) missing.push(name);
    }
    process.stdout.write(missing.join(" "));
  ' "$PROJ_DIR" 2>/dev/null || true
}

if [ "$RECOVER_SHUTDOWN" = "1" ]; then
  RECOVERY_SCRIPT="$PROJ_DIR/scripts/recover-shutdown.mjs"
  if [ ! -f "$RECOVERY_SCRIPT" ]; then
    echo "❌ Shutdown recovery helper is missing; update BotBoy without starting, then retry."
    echo "    BOTBOY_UPDATE_NO_START=1 ./start.sh --update"
    exit 1
  fi
  PPT_STARTUP_SAFETY_BLOCK="$STARTUP_SAFETY_BLOCK" \
  PPT_SHUTDOWN_RECEIPT_DIR="$SHUTDOWN_RECEIPT_DIR" \
  PPT_PID_FILE="$PID_FILE" \
    exec "$NODE" "$RECOVERY_SCRIPT"
fi

server_is_ready() {
  local expected_pid="${1:-}"
  local payload=""
  local ready_process_id=""
  # `/` is intentionally 200 during provisional boot so an already-open tab
  # can show the self-refreshing startup page. Only the version API proves the
  # real app handler is installed and startup reached its completion boundary.
  payload=$(curl -fsS --max-time 1 \
    http://localhost:7778/api/dashboard/version 2>/dev/null) || return 1
  [ -z "$expected_pid" ] && return 0
  # The version receipt carries a non-secret process id. Parse with the same
  # Node runtime we launch so a competing listener can never satisfy this
  # child's readiness check.
  ready_process_id=$(printf '%s' "$payload" \
    | "$NODE" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(String(JSON.parse(d).processId??''))}catch{process.exitCode=1}})" \
      2>/dev/null) || return 1
  [ "$ready_process_id" = "$expected_pid" ]
}

startup_target_is_ready() {
  local expected_pid="${1:-}"
  if [ -n "$expected_pid" ] && ! kill -0 "$expected_pid" 2>/dev/null; then
    return 1
  fi
  server_is_ready "$expected_pid" || return 1
  [ -z "$expected_pid" ] || kill -0 "$expected_pid" 2>/dev/null
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

# Teammate zero-config: if an owner-issued botboy-credentials plaintext file
# or ZIP is sitting in ~/Downloads or ~/Desktop, fold its validated pair into
# ~/.personal-productivity-tracker/.env (and delete the attachment) before
# settings are loaded. No-op otherwise.
bash "$PROJ_DIR/scripts/import-credentials.sh" 2>&1 | tee -a "$LOG_FILE" || true

# Load only inference-related local settings before selecting provider defaults.
# Do not source this file: values are parsed as data and only allowlisted keys
# are exported. OAuth shell overrides are atomic: either both keys come from
# the launching shell or neither does, so a stored key can never silently mate
# with a one-key override.
SHELL_OAUTH_HAS_ID=0
SHELL_OAUTH_HAS_SECRET=0
[ -n "${BOTBOY_INFERENCE_OAUTH_CLIENT_ID:-}" ] && SHELL_OAUTH_HAS_ID=1
[ -n "${BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET:-}" ] && SHELL_OAUTH_HAS_SECRET=1

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
      case "$key" in
        BOTBOY_INFERENCE_OAUTH_CLIENT_ID|BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET)
          if [ "$SHELL_OAUTH_HAS_ID" = "1" ] || [ "$SHELL_OAUTH_HAS_SECRET" = "1" ]; then
            continue
          fi
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

validate_oauth_pair() {
  local has_id=0
  local has_secret=0
  if [ "$SHELL_OAUTH_HAS_ID" != "$SHELL_OAUTH_HAS_SECRET" ]; then
    echo "❌ Incomplete BotBoy OAuth shell override — set both client id and secret, or unset both."
    echo "    Stored credentials are not mixed with a one-key shell override."
    echo "    Need details? Run: ./start.sh --doctor"
    return 1
  fi
  [ -n "${BOTBOY_INFERENCE_OAUTH_CLIENT_ID:-}" ] && has_id=1
  [ -n "${BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET:-}" ] && has_secret=1
  if [ "$has_id" != "$has_secret" ]; then
    echo "❌ Incomplete BotBoy OAuth credentials — client id and secret must both be present."
    echo "    Download the owner-issued credential attachment again, then re-run ./start.sh."
    echo "    Need details? Run: ./start.sh --doctor"
    return 1
  fi
  return 0
}

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
        export BOTBOY_INFERENCE_MODEL="${BOTBOY_INFERENCE_MODEL:-${VLLM_MODEL:-openai.gpt-5.6-terra}}"
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
    # Model default is Terra; the bedrock-mantle-luna/ prefix is the gateway
    # TARGET name (fixed deployment id), not the model.
    export BOTBOY_INFERENCE_MODEL="${BOTBOY_INFERENCE_MODEL:-bedrock-mantle-luna/openai.gpt-5.6-terra}"
    export BOTBOY_INFERENCE_DIALECT="${BOTBOY_INFERENCE_DIALECT:-openai}"
    export BOTBOY_INFERENCE_REASONING_EFFORT="${BOTBOY_INFERENCE_REASONING_EFFORT:-low}"
    export BOTBOY_INFERENCE_MAX_CONTEXT_TOKENS="${BOTBOY_INFERENCE_MAX_CONTEXT_TOKENS:-1000000}"
    # Curated chat-only GPT-6 routes. These identifiers are deployment
    # metadata, not credentials: all gateways reuse the existing Cognito
    # client pair and scope. Background work remains on GPT-5.6 Terra.
    export BOTBOY_INFERENCE_GPT6_ROLLOUT="${BOTBOY_INFERENCE_GPT6_ROLLOUT:-preview}"
    export BOTBOY_INFERENCE_GPT6_EAST_TARGET="${BOTBOY_INFERENCE_GPT6_EAST_TARGET:-botboy-gpt6-east}"
    export BOTBOY_INFERENCE_GPT6_ASTRA_TARGET="${BOTBOY_INFERENCE_GPT6_ASTRA_TARGET:-botboy-gpt6-astra-west}"
    export BOTBOY_INFERENCE_GPT6_ASTRA_ENDPOINT="${BOTBOY_INFERENCE_GPT6_ASTRA_ENDPOINT:-https://botboy-gpt6-astra-west-gateway-y0bjavx16u.gateway.bedrock-agentcore.us-west-2.amazonaws.com/inference/v1}"
    export BOTBOY_INFERENCE_GPT6_ASTRA_PROJECT="${BOTBOY_INFERENCE_GPT6_ASTRA_PROJECT:-proj_gcag2sv5e6z2eni2azsx}"
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
  # $1 = "focus": reactivation path (--open-window — Dock icon, Spotlight,
  # Launchpad while BotBoy is already running). Nothing changed, the user
  # just wants their window back: focus the existing window instead of
  # closing+respawning it. The old respawn here silently threw away the
  # user's current page (fresh window = bare root URL = homepage) — first
  # teammate-reported bug, 2026-08-28.
  #
  # No argument = real start/restart: close any old window and spawn fresh.
  # That path keeps the stale-JS protection (a reused window runs whatever
  # app.js it loaded at open time — AGENT_FIX_LEARNINGS #1/#17/#18): a
  # start/restart can mean new code, so the window must reload it. Focus
  # reuse is safe from staleness because the bootId poll hard-reloads every
  # open tab whenever the server restarts — a live window is never older
  # than the running server.
  local mode="${1:-fresh}"
  local expected_pid="${2:-}"
  if ! startup_target_is_ready "$expected_pid"; then
    echo "❌ BotBoy is not ready — dashboard window was not opened."
    echo "    Run: ./start.sh --doctor"
    echo "    Runtime log: $LOG_FILE"
    return 1
  fi
  # Tolerate a still-warming Chrome: retry the DevTools endpoint briefly
  # rather than deciding from a single probe.
  local devtools_up=1
  for _ in $(seq 1 5); do
    curl -s --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1 && { devtools_up=0; break; }
    sleep 1
  done
  if [ "$devtools_up" = "0" ]; then
    # Parse with node (always present — it runs the server); python3 is not a
    # BotBoy prerequisite and may be missing on a fresh machine. Emits
    # "<targetId>\t<url>" so the respawn below can preserve the user's place.
    DASH_INFO=$(curl -s --max-time 3 http://127.0.0.1:9222/json/list \
      | "$NODE" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const t=JSON.parse(d).filter(x=>String(x.url||'').includes('localhost:7778'));process.stdout.write(t.length?(t[0].id+'\t'+String(t[0].url||'')):'')}catch{}})" 2>/dev/null)
    DASH_TARGET="${DASH_INFO%%$'\t'*}"
    DASH_URL="${DASH_INFO#*$'\t'}"
    if [ -n "$DASH_TARGET" ] && [ "$mode" = "focus" ]; then
      # Target.activateTarget: raises the existing app window, page state
      # (route, scroll, drafts) intact.
      curl -s --max-time 3 "http://127.0.0.1:9222/json/activate/$DASH_TARGET" >/dev/null
      if ! startup_target_is_ready "$expected_pid"; then
        echo "❌ BotBoy stopped before its dashboard window could be focused."
        echo "    Run: ./start.sh --doctor"
        return 1
      fi
      echo "✅ Dashboard window focused"
      return 0
    fi
    # Real start/restart: the fresh window must load current code, but the
    # user's PLACE should survive — reopen at the old window's URL (the route
    # lives in the hash; a since-removed route degrades to the not-found view
    # via parseRoute). Guard: only genuine dashboard URLs are reused, so a
    # connection-error page (chrome-error://…) is never resurrected.
    REOPEN_URL="http://localhost:7778"
    case "$DASH_URL" in
      "http://localhost:7778"*) REOPEN_URL="$DASH_URL" ;;
    esac
    if [ -n "$DASH_TARGET" ]; then
      curl -s --max-time 3 "http://127.0.0.1:9222/json/close/$DASH_TARGET" >/dev/null
      sleep 1
    fi
    # Snapshot every existing page target after the old dashboard is closed.
    # The singleton Chrome process creates one new page for --app; retaining
    # its new ID lets a failed settle close exactly this launch artifact even
    # if its URL has already become chrome-error://.
    PRELAUNCH_TARGET_IDS=$(curl -s --max-time 3 http://127.0.0.1:9222/json/list \
      | "$NODE" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).filter(x=>x.type==='page').map(x=>String(x.id||'')).filter(Boolean).join('\n'))}catch{}})" 2>/dev/null)
    local window_started=$SECONDS
    "$CHROME" \
      --user-data-dir="$DEBUG_PROFILE" \
      --app="$REOPEN_URL" >/dev/null 2>&1 &
    # Chrome can take several seconds to open an --app window while it is
    # busy (large profile, many tabs, a cold hand-off to the running debug
    # instance). The old ~2 s poll gave up before the window appeared on a
    # 2026-09-29 restart, and the launcher then stopped a healthy server.
    # Wait up to BOTBOY_WINDOW_WAIT_SECONDS (default 20) and claim only a page
    # that looks like this launch (the dashboard URL, a connection-error page,
    # or a blank page still loading), so a tab the owner opens meanwhile is
    # never taken for it. Only a gone server PID ends the wait early: a slow
    # version API during boot is not a reason to give up on the window, and
    # the readiness check after the window appears still decides the outcome.
    local window_wait="${BOTBOY_WINDOW_WAIT_SECONDS:-20}"
    [[ "$window_wait" =~ ^[0-9]+$ ]] || window_wait=20
    local window_deadline=$((SECONDS + window_wait))
    local server_gone=0
    NEW_DASH_TARGET=""
    while :; do
      NEW_DASH_TARGET=$(curl -s --max-time 3 http://127.0.0.1:9222/json/list \
        | BOTBOY_PRELAUNCH_TARGET_IDS="$PRELAUNCH_TARGET_IDS" "$NODE" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const old=new Set(String(process.env.BOTBOY_PRELAUNCH_TARGET_IDS||'').split('\n').filter(Boolean));const launched=u=>u===''||u==='about:blank'||u.startsWith('chrome-error://')||u.startsWith('http://localhost:7778')||u.startsWith('http://127.0.0.1:7778');const t=JSON.parse(d).find(x=>x.type==='page'&&x.id&&!old.has(String(x.id))&&launched(String(x.url||'')));process.stdout.write(String(t?.id||''))}catch{}})" 2>/dev/null)
      [ -n "$NEW_DASH_TARGET" ] && break
      if [ -n "$expected_pid" ] && ! kill -0 "$expected_pid" 2>/dev/null; then
        server_gone=1
        break
      fi
      [ "$SECONDS" -ge "$window_deadline" ] && break
      sleep 0.25
    done
    if [ -z "$NEW_DASH_TARGET" ]; then
      if [ "$server_gone" = "1" ]; then
        echo "❌ BotBoy stopped before its dashboard window opened."
        echo "    Run: ./start.sh --doctor"
        echo "    Runtime log: $LOG_FILE"
        return 1
      fi
      echo "❌ Chrome did not create a dashboard window within ${window_wait}s."
      echo "    Run: ./start.sh --doctor"
      return 1
    fi
    local window_seconds=$((SECONDS - window_started))
    [ "$window_seconds" -ge 3 ] && echo "ℹ️  Chrome took ${window_seconds}s to open the dashboard window"
    sleep 2
    if startup_target_is_ready "$expected_pid"; then
      echo "✅ Dashboard ready: $REOPEN_URL"
    else
      curl -s --max-time 3 "http://127.0.0.1:9222/json/close/$NEW_DASH_TARGET" >/dev/null
      echo "❌ BotBoy stopped before the dashboard window became usable."
      echo "    Run: ./start.sh --doctor"
      echo "    Runtime log: $LOG_FILE"
      return 1
    fi
  else
    if ! startup_target_is_ready "$expected_pid"; then
      echo "❌ BotBoy stopped while waiting for the dashboard window."
      echo "    Run: ./start.sh --doctor"
      echo "    Runtime log: $LOG_FILE"
      return 1
    fi
    echo "✅ Dashboard ready: http://localhost:7778 (open it manually)"
    echo "⚠️  Debug Chrome not reachable on :9222 — automatic window launch was skipped"
  fi
}

wait_for_server() {
  local server_pid="${1:-}"
  local deadline=$((SECONDS + 90))
  local child_exited=0
  local exit_code=1
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ -n "$server_pid" ] && ! kill -0 "$server_pid" 2>/dev/null; then
      child_exited=1
      break
    fi
    startup_target_is_ready "$server_pid" && return 0
    if [ -n "$server_pid" ] && ! kill -0 "$server_pid" 2>/dev/null; then
      child_exited=1
      break
    fi
    [ "$SECONDS" -ge "$deadline" ] || sleep 1
  done
  if [ "$child_exited" = "1" ]; then
    if wait "$server_pid" 2>/dev/null; then
      exit_code=0
    else
      exit_code=$?
    fi
    if [ -f "$PID_FILE" ] && [ "$(cat "$PID_FILE" 2>/dev/null)" = "$server_pid" ]; then
      rm -f "$PID_FILE"
    fi
    echo "❌ BotBoy exited before the dashboard became ready (exit $exit_code)."
  else
    echo "❌ BotBoy did not become ready within about 90 seconds."
  fi
  echo "    Run: ./start.sh --doctor"
  echo "    Runtime log: $LOG_FILE"
  return 1
}

shutdown_receipt_path() {
  printf '%s/ppt-shutdown-%s.json' "$SHUTDOWN_RECEIPT_DIR" "$1"
}

current_epoch_ms() {
  "$NODE" -e 'process.stdout.write(String(Date.now()))'
}

# Persist the exact process set and original signal boundary before attempting
# shutdown. If this launcher is interrupted, later starts remain fail-closed
# until every target has a matching, fresh, DB-closed receipt.
write_shutdown_safety_block() {
  local reason="$1"
  local not_before_ms="$2"
  shift 2
  [ "$#" -gt 0 ] || return 1
  "$NODE" -e '
    const fs = require("fs");
    const path = require("path");
    const file = process.argv[1];
    const reason = process.argv[2];
    const notBeforeMs = Number(process.argv[3]);
    const pids = process.argv.slice(4).map(Number);
    if (!Number.isFinite(notBeforeMs) || notBeforeMs <= 0
        || pids.length === 0 || pids.length > 20
        || pids.some(pid => !Number.isInteger(pid) || pid <= 0)) {
      process.exit(1);
    }
    const value = {
      schemaVersion: 2,
      reason,
      createdAt: new Date().toISOString(),
      targets: [...new Set(pids)].map(pid => ({ pid, notBeforeMs })),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(temporary, "w", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  ' "$STARTUP_SAFETY_BLOCK" "$reason" "$not_before_ms" "$@"
}

write_startup_safety_block() {
  local server_pid="$1"
  local not_before_ms="$2"
  write_shutdown_safety_block "startup_child_shutdown_unverified" "$not_before_ms" "$server_pid"
}

# Stop an exact candidate child through the same 20/30-second DB-last contract
# as ordinary takeover. Failed readiness/window settlement must never create a
# five-second shortcut around the application's 25-second coordinator.
stop_startup_child() {
  local server_pid="$1"
  local receipt attempt_started_ms
  receipt="$(shutdown_receipt_path "$server_pid")"
  attempt_started_ms="$(current_epoch_ms)"
  if ! write_startup_safety_block "$server_pid" "$attempt_started_ms"; then
    echo "❌ Could not persist the failed-start shutdown guard; the child was not signalled."
    return 1
  fi

  local killed=0
  rm -f "$receipt"
  if pid_is_live "$server_pid"; then
    kill -INT "$server_pid" 2>/dev/null || true
    for _ in $(seq 1 "$STARTUP_INT_GRACE_SECONDS"); do
      pid_is_live "$server_pid" || break
      sleep 1
    done
    if pid_is_live "$server_pid"; then
      echo "⚠️  startup pid $server_pid exceeded the cooperative window — sending the real second signal"
      kill -TERM "$server_pid" 2>/dev/null || true
      for _ in $(seq 1 "$STARTUP_TERM_GRACE_SECONDS"); do
        pid_is_live "$server_pid" || break
        sleep 1
      done
    fi
    if pid_is_live "$server_pid"; then
      killed=1
      echo "❌ startup pid $server_pid exceeded 30 seconds — sending SIGKILL; DB closure is unverified"
      kill -9 "$server_pid" 2>/dev/null || true
    fi
  fi
  wait "$server_pid" 2>/dev/null || true
  if [ -f "$PID_FILE" ] && [ "$(cat "$PID_FILE" 2>/dev/null)" = "$server_pid" ]; then
    rm -f "$PID_FILE"
  fi

  local state
  state="$(shutdown_receipt_state "$receipt" "$server_pid" "$attempt_started_ms")"
  case "$state" in
    "complete|clean|closed")
      if ! scrub_shutdown_receipt "$receipt" "$server_pid"; then
        echo "❌ DB closure was proved, but private receipt fields could not be scrubbed."
        return 1
      fi
      rm -f "$STARTUP_SAFETY_BLOCK"
      echo "✅ startup pid $server_pid stopped cleanly after failed completion (receipt: $receipt)"
      return 0
      ;;
    "complete|forced|closed"|"complete|failed|closed")
      if ! scrub_shutdown_receipt "$receipt" "$server_pid"; then
        echo "❌ DB closure was proved, but private receipt fields could not be scrubbed."
        return 1
      fi
      rm -f "$STARTUP_SAFETY_BLOCK"
      echo "⚠️  startup pid $server_pid required bounded cleanup but proved SQLite closed (receipt: $receipt)"
      return 2
      ;;
    *)
      echo "❌ Failed-start cleanup did not prove exact, fresh DB-last closure ($state)."
      echo "    Replacement starts are blocked by: $STARTUP_SAFETY_BLOCK"
      echo "    Preserve tracker.db + WAL + SHM together and inspect: $receipt"
      [ "$killed" = "0" ] || echo "    The candidate required SIGKILL."
      return 1
      ;;
  esac
}

# Teammate machines run the LLM through the gateway with per-person OAuth
# credentials. When neither those nor a Bedrock key are present, BotBoy still
# runs but chat/synthesis are dead — say so at startup instead of letting the
# owner debug "BotBoy has no LLM" from a screenshot. Owner machines with any
# credential source stay silent.
warn_if_no_llm_credentials() {
  # An OpenAI or DeepSeek key saved in Settings → AI model powers BotBoy on its
  # own. grep -q only tests for a key field; nothing is read into the shell.
  [ -s "$AI_MODEL_SETTINGS_FILE" ] && grep -q '"apiKey"' "$AI_MODEL_SETTINGS_FILE" 2>/dev/null && return 0
  [ -n "${AWS_BEARER_TOKEN_BEDROCK:-}" ] && return 0
  [ -n "${BOTBOY_INFERENCE_API_KEY:-}" ] && return 0
  if [ -n "${BOTBOY_INFERENCE_OAUTH_CLIENT_ID:-}" ] \
    && [ -n "${BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET:-}" ]; then
    return 0
  fi
  echo "⚠️  No AI model set up yet — chat and background organizing stay off until you add one."
  echo "    In BotBoy, open Settings → AI model and paste an OpenAI or DeepSeek API key (it takes effect right away)."
  echo "    Or, if the owner sent you a botboy-credentials file, put it in ~/Downloads and re-run ./start.sh."
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

# A foreground child remains visible as a zombie until this launcher calls
# wait(1); treat that as exited so the bounded stop path never escalates it.
pid_is_live() {
  local state
  state="$(ps -o stat= -p "$1" 2>/dev/null | tr -d ' ')"
  [ -n "$state" ] && [[ "$state" != Z* ]]
}

# Accept only a receipt bound to this exact PID and shutdown-attempt boundary.
# The application already emits schema-v1 PID and lifecycle timestamps, so
# this strengthens validation without making a running prior build unreadable.
shutdown_receipt_state() {
  local receipt="$1"
  local expected_pid="$2"
  local not_before_ms="$3"
  [ -f "$receipt" ] || { echo "missing"; return 0; }
  "$NODE" -e '
    const fs = require("fs");
    const fail = reason => { process.stdout.write(reason); process.exit(0); };
    try {
      const file = process.argv[1];
      const expectedPid = Number(process.argv[2]);
      const notBeforeMs = Number(process.argv[3]);
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Number.isInteger(expectedPid) || expectedPid <= 0 || !Number.isFinite(notBeforeMs) || notBeforeMs <= 0) {
        fail("invalid_validator");
      }
      if (!value || value.schemaVersion !== 1 || !Number.isInteger(value.pid) || value.pid <= 0) {
        fail("invalid_schema");
      }
      if (value.pid !== expectedPid) fail("pid_mismatch");
      if (!["running", "complete", "incomplete"].includes(value.status)
          || !["pending", "clean", "forced", "failed"].includes(value.outcome)) {
        fail("invalid_state");
      }
      const startedAt = Date.parse(value.startedAt);
      const updatedAt = Date.parse(value.updatedAt);
      if (!Number.isFinite(startedAt) || !Number.isFinite(updatedAt) || startedAt > updatedAt) {
        fail("invalid_timestamps");
      }
      let completedAt = null;
      if (value.status === "complete") {
        completedAt = Date.parse(value.completedAt);
        if (!Number.isFinite(completedAt) || completedAt < startedAt || updatedAt < completedAt) {
          fail("invalid_timestamps");
        }
      }
      if (!Array.isArray(value.signals) || value.signals.length === 0) fail("invalid_signals");
      const lifecycleEnd = completedAt ?? updatedAt;
      const signalTimes = value.signals.map((signal, index) => {
        const at = Date.parse(signal?.at);
        if (!signal || typeof signal.name !== "string" || !/^SIG[A-Z0-9]+$/.test(signal.name)
            || signal.ordinal !== index + 1 || !Number.isFinite(at)) {
          fail("invalid_signals");
        }
        if (at < startedAt || at > lifecycleEnd || at > updatedAt) fail("invalid_signal_chronology");
        return at;
      });
      for (let index = 1; index < signalTimes.length; index++) {
        if (signalTimes[index] < signalTimes[index - 1]) fail("invalid_signal_chronology");
      }
      if (Math.max(...signalTimes) < notBeforeMs || updatedAt < notBeforeMs) fail("stale");
      if (value.status === "complete" && value.database?.closed === true) {
        const closeStartedAt = Date.parse(value.database.closeStartedAt);
        const closedAt = Date.parse(value.database.closedAt);
        if (!Number.isFinite(closeStartedAt) || !Number.isFinite(closedAt)
            || closeStartedAt < startedAt || closedAt < closeStartedAt || closedAt > completedAt) {
          fail("invalid_database_timestamps");
        }
      }
      const mtimeMs = fs.statSync(file).mtimeMs;
      if (!Number.isFinite(mtimeMs) || mtimeMs + 2 < notBeforeMs) fail("stale");
      process.stdout.write(`${value.status}|${value.outcome}|${value.database?.closed === true ? "closed" : "open"}`);
    } catch { fail("invalid"); }
  ' "$receipt" "$expected_pid" "$not_before_ms"
}

# Current builds never serialize a private path. A process already running the
# immediately previous build can still emit database.path once; after exact,
# fresh closure is proved, remove that legacy field atomically before proceed.
scrub_shutdown_receipt() {
  local receipt="$1"
  local expected_pid="$2"
  "$NODE" -e '
    const fs = require("fs");
    const file = process.argv[1];
    const expectedPid = Number(process.argv[2]);
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (value?.schemaVersion !== 1 || value?.pid !== expectedPid) process.exit(1);
      if (!value.database || !Object.prototype.hasOwnProperty.call(value.database, "path")) process.exit(0);
      delete value.database.path;
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
      const fd = fs.openSync(temporary, "w", 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, file);
      fs.chmodSync(file, 0o600);
    } catch { process.exit(1); }
  ' "$receipt" "$expected_pid"
}

startup_safety_block_targets() {
  [ -f "$STARTUP_SAFETY_BLOCK" ] || { echo ""; return 0; }
  "$NODE" -e '
    const fs = require("fs");
    try {
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (value?.schemaVersion !== 2 || !Array.isArray(value.targets) || value.targets.length === 0) {
        throw new Error("invalid guard");
      }
      const seen = new Set();
      const lines = value.targets.map(target => {
        const pid = Number(target?.pid);
        const notBeforeMs = Number(target?.notBeforeMs);
        if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(notBeforeMs) || notBeforeMs <= 0 || seen.has(pid)) {
          throw new Error("invalid target");
        }
        seen.add(pid);
        return `${pid}|${notBeforeMs}`;
      });
      process.stdout.write(lines.join("\n"));
    } catch { process.stdout.write("invalid"); }
  ' "$STARTUP_SAFETY_BLOCK"
}

# Gracefully stop every exact server in the pre-signal snapshot. The
# application owns a 25-second bounded coordinator: first signal closes
# admission, the second escalates local resources, and SQLite closes last.
# Return 0=clean, 2=forced but DB-closed, 1=incomplete/unsafe.
stop_existing_server() {
  local exact_pid="${1:-}"
  local pids=""
  if [ -n "$exact_pid" ]; then
    if ! [[ "$exact_pid" =~ ^[0-9]+$ ]]; then
      echo "❌ Invalid exact shutdown PID"
      return 1
    fi
    pids="$exact_pid"
  else
    pids="$(pgrep -f 'node dist/index.js' 2>/dev/null)"
    [ -f "$PID_FILE" ] && pids="$pids $(cat "$PID_FILE" 2>/dev/null)"
    pids="$(echo "$pids" | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u)"
    local live_pids=""
    local discovered_pid=""
    for discovered_pid in $pids; do
      pid_is_live "$discovered_pid" && live_pids="$live_pids $discovered_pid"
    done
    pids="$(echo "$live_pids" | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u)"
  fi
  if [ -z "$pids" ]; then
    rm -f "$PID_FILE"
    return 0
  fi

  local attempt_started_ms
  attempt_started_ms="$(current_epoch_ms)"
  if ! write_shutdown_safety_block "tracker_shutdown_unverified" "$attempt_started_ms" $pids; then
    echo "❌ Could not persist the shutdown guard; no process was signalled."
    return 1
  fi

  echo "ℹ️  Taking over from running tracker(s): $(echo "$pids" | tr '\n' ' ')— requesting bounded shutdown"
  local pid=""
  for pid in $pids; do
    rm -f "$(shutdown_receipt_path "$pid")"
    pid_is_live "$pid" && kill -INT "$pid" 2>/dev/null || true
  done

  # Cooperative coordinator window. A healthy shutdown normally finishes in
  # well under this; do not send the second signal while DB-last cleanup runs.
  for _ in $(seq 1 "$STARTUP_INT_GRACE_SECONDS"); do
    local alive=0
    for pid in $pids; do pid_is_live "$pid" && alive=1; done
    [ "$alive" = "0" ] && break
    sleep 1
  done

  local second_signal=0
  for pid in $pids; do
    if pid_is_live "$pid"; then
      second_signal=1
      echo "⚠️  pid $pid exceeded the cooperative window — sending the real second signal"
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  if [ "$second_signal" = "1" ]; then
    for _ in $(seq 1 "$STARTUP_TERM_GRACE_SECONDS"); do
      local alive=0
      for pid in $pids; do pid_is_live "$pid" && alive=1; done
      [ "$alive" = "0" ] && break
      sleep 1
    done
  fi

  local killed=0
  for pid in $pids; do
    if pid_is_live "$pid"; then
      killed=1
      echo "❌ pid $pid exceeded 30 seconds — sending SIGKILL; shutdown is incomplete"
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  rm -f "$PID_FILE"

  local forced=0
  local failed=$killed
  for pid in $pids; do
    local receipt state
    receipt="$(shutdown_receipt_path "$pid")"
    state="$(shutdown_receipt_state "$receipt" "$pid" "$attempt_started_ms")"
    case "$state" in
      "complete|clean|closed")
        if scrub_shutdown_receipt "$receipt" "$pid"; then
          echo "✅ pid $pid stopped cleanly (receipt: $receipt)"
        else
          failed=1
          echo "❌ pid $pid closed SQLite but its private receipt fields could not be scrubbed"
        fi
        ;;
      "complete|forced|closed")
        if scrub_shutdown_receipt "$receipt" "$pid"; then
          forced=1
          echo "⚠️  pid $pid required bounded escalation but closed SQLite (receipt: $receipt)"
        else
          failed=1
          echo "❌ pid $pid closed SQLite but its private receipt fields could not be scrubbed"
        fi
        ;;
      "complete|failed|closed")
        if scrub_shutdown_receipt "$receipt" "$pid"; then
          forced=1
          echo "⚠️  pid $pid reported a shutdown-stage failure but proved SQLite closed (receipt: $receipt)"
        else
          failed=1
          echo "❌ pid $pid closed SQLite but its private receipt fields could not be scrubbed"
        fi
        ;;
      missing)
        failed=1
        echo "❌ pid $pid has no receipt for this shutdown attempt; process exit is not DB-closure proof"
        ;;
      *)
        failed=1
        echo "❌ pid $pid shutdown receipt is not exact, fresh, complete, and DB-closed ($state): $receipt"
        ;;
    esac
  done

  [ "$failed" = "0" ] || return 1
  rm -f "$STARTUP_SAFETY_BLOCK"
  [ "$forced" = "0" ] || return 2
  return 0
}

startup_safety_allows_takeover() {
  [ -f "$STARTUP_SAFETY_BLOCK" ] || return 0
  local targets
  targets="$(startup_safety_block_targets)"
  if [ -z "$targets" ] || [ "$targets" = "invalid" ]; then
    echo "❌ Replacement start blocked: the shutdown safety guard is invalid."
    echo "    Inspect $STARTUP_SAFETY_BLOCK and preserve tracker.db + WAL + SHM together before recovery."
    return 1
  fi

  local blocked=0
  local blocked_pid=""
  local not_before_ms=""
  while IFS='|' read -r blocked_pid not_before_ms; do
    local receipt blocked_state
    receipt="$(shutdown_receipt_path "$blocked_pid")"
    blocked_state="$(shutdown_receipt_state "$receipt" "$blocked_pid" "$not_before_ms")"
    case "$blocked_state" in
      "complete|clean|closed"|"complete|forced|closed"|"complete|failed|closed")
        if ! scrub_shutdown_receipt "$receipt" "$blocked_pid"; then
          blocked=1
          echo "❌ Replacement start blocked: PID $blocked_pid receipt scrubbing failed."
        fi
        ;;
      *)
        blocked=1
        echo "❌ Replacement start blocked: PID $blocked_pid lacks exact, fresh DB-last closure ($blocked_state)."
        ;;
    esac
  done <<< "$targets"

  if [ "$blocked" = "0" ]; then
    rm -f "$STARTUP_SAFETY_BLOCK"
    echo "✅ Cleared shutdown safety block from exact late DB-closure receipt(s)"
    return 0
  fi
  echo "    Inspect $STARTUP_SAFETY_BLOCK and preserve tracker.db + WAL + SHM together before recovery."
  return 1
}

safe_takeover() {
  startup_safety_allows_takeover || return 1
  stop_existing_server
  local result=$?
  if [ "$result" = "1" ]; then
    echo "❌ Replacement start blocked: prior process did not prove exact, fresh DB-last closure."
    echo "    Inspect $STARTUP_SAFETY_BLOCK and preserve tracker.db + WAL + SHM together before recovery."
    return 1
  fi
  if [ "$result" = "2" ]; then
    echo "⚠️  Continuing replacement because the forced receipt proves SQLite closed."
  fi
  return 0
}

# Executable test harness for the exact launcher state machine. All paths and
# grace windows are environment-overridable; production never sets these.
if [ -n "${BOTBOY_TEST_STARTUP_CLEANUP_PID:-}" ]; then
  stop_startup_child "$BOTBOY_TEST_STARTUP_CLEANUP_PID"
  exit $?
fi
if [ -n "${BOTBOY_TEST_EXISTING_CLEANUP_PID:-}" ]; then
  stop_existing_server "$BOTBOY_TEST_EXISTING_CLEANUP_PID"
  exit $?
fi
if [ "${BOTBOY_TEST_STARTUP_SAFETY_CHECK:-0}" = "1" ]; then
  startup_safety_allows_takeover
  exit $?
fi

foreground_shutdown() {
  trap - TERM INT HUP
  echo "🔻 BotBoy quitting — requesting bounded tracker shutdown (pid $SERVER_PID)" >> "$LOG_FILE"
  # Always create a new attempt boundary, remove any stale receipt, and signal
  # the exact child. A process-group Ctrl-C may make this a safe second signal;
  # disappearance or a pre-existing file is never accepted as closure proof.
  stop_existing_server "$SERVER_PID"
  local result=$?
  wait "$SERVER_PID" 2>/dev/null || true
  [ "$result" = "0" ] && exit 0
  exit "$result"
}

cd "$PROJ_DIR" || exit 1

if [ "$OPEN_WINDOW_ONLY" = "1" ]; then
  if ! open_dashboard_window focus; then
    exit 1
  fi
  exit 0
fi

# ── --stop: clean shutdown of every tracker process ──
if [ "$STOP_ONLY" = "1" ]; then
  if [ -f "$STARTUP_SAFETY_BLOCK" ]; then
    echo "❌ BotBoy stop refused: an earlier shutdown guard is unresolved."
    echo "    Run: ./start.sh --doctor"
    echo "    Then: ./start.sh --recover-shutdown"
    echo "    The existing guard was not replaced."
    exit 1
  fi
  if ! pgrep -f 'node dist/index.js' >/dev/null 2>&1; then
    rm -f "$PID_FILE"
    echo "ℹ️  BotBoy is not running"
    exit 0
  fi
  stop_existing_server
  STOP_RESULT=$?
  if [ "$STOP_RESULT" = "0" ]; then
    echo "✅ BotBoy stopped cleanly"
    exit 0
  fi
  if [ "$STOP_RESULT" = "2" ]; then
    echo "⚠️  BotBoy stopped with bounded escalation; SQLite closure is receipt-confirmed"
    exit 2
  fi
  echo "❌ BotBoy stop is incomplete; automatic success is refused"
  exit 1
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
  echo "checkout-mode: $([ "$BOTBOY_RELEASE_CHECKOUT" = "1" ] && echo 'teammate release (customizations supported)' || echo 'development')"
  TRACKED_DIRTY_COUNT=$(git -C "$PROJ_DIR" status --porcelain --untracked-files=no 2>/dev/null | wc -l | tr -d ' ')
  echo "tracked local changes: ${TRACKED_DIRTY_COUNT:-unknown}$([ "${TRACKED_DIRTY_COUNT:-0}" != "0" ] && echo ' — run ./start.sh --update before pulling' || true)"
  if [ -f "$PROJ_DIR/scripts/recover-shutdown.mjs" ]; then
    PPT_STARTUP_SAFETY_BLOCK="$STARTUP_SAFETY_BLOCK" \
    PPT_SHUTDOWN_RECEIPT_DIR="$SHUTDOWN_RECEIPT_DIR" \
    PPT_PID_FILE="$PID_FILE" \
      "$NODE" "$PROJ_DIR/scripts/recover-shutdown.mjs" --inspect
  elif [ -f "$STARTUP_SAFETY_BLOCK" ]; then
    echo "shutdown recovery: BLOCKED helper=missing next=update-without-start"
  else
    echo "shutdown recovery: no active safety guard"
  fi
  if xcode-select -p >/dev/null 2>&1; then echo "xcode-clt: installed"; else echo "xcode-clt: MISSING — run: xcode-select --install"; fi
  [ -x "$CHROME" ] && echo "chrome: installed" || echo "chrome: MISSING at $CHROME"
  [ -f "$PROJ_DIR/dist/index.js" ] && echo "build: dist/index.js present" || echo "build: MISSING — run: npm run build"
  [ -f "$PROJ_DIR/dist/ui/index.html" ] && [ -f "$PROJ_DIR/dist/ui/dashboard.css" ] && echo "ui-assets: present" || echo "ui-assets: MISSING/PARTIAL — run: npm run build"
  DOCTOR_MISSING_DEPS="$(missing_npm_dependencies)"
  if [ -z "$DOCTOR_MISSING_DEPS" ]; then echo "npm dependencies: installed"; else echo "npm dependencies: MISSING $DOCTOR_MISSING_DEPS — run: npm install (./start.sh also tries)"; fi
  echo "pdf readers: vision-ocr helper $([ -x "$PROJ_DIR/native/vision-ocr/bin/vision-ocr" ] && echo built || echo 'not built (needs Xcode CLT)'); pdftotext $(command -v pdftotext >/dev/null 2>&1 && echo installed || echo absent); pdf.js $([ -f "$PROJ_DIR/node_modules/pdfjs-dist/legacy/build/pdf.mjs" ] && echo installed || echo 'MISSING — run: npm install')"
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
  # Document downloads: Word/PDF/HTML convert through a local pandoc install
  # (markdown export needs nothing). Same lookup paths as the exporter.
  if command -v pandoc >/dev/null 2>&1 || [ -x /opt/homebrew/bin/pandoc ] || [ -x /usr/local/bin/pandoc ] || [ -x "$HOME/homebrew/bin/pandoc" ]; then
    echo "pandoc: installed (Word/PDF/HTML document downloads available)"
  else
    echo "pandoc: not installed (optional — BotBoy offers an in-app install on first Word/PDF/HTML download; Markdown works without it)"
  fi
  # Homebrew is never REQUIRED (node/Chrome/git all arrive without it), but
  # the in-app pandoc install and several setup suggestions lean on it —
  # support should see its absence in one glance.
  if command -v brew >/dev/null 2>&1 || [ -x /opt/homebrew/bin/brew ] || [ -x /usr/local/bin/brew ] || [ -x "$HOME/homebrew/bin/brew" ]; then
    echo "homebrew: installed"
  else
    echo "homebrew: not installed (optional — the in-app pandoc install needs it; https://brew.sh)"
  fi
  DOCTOR_ENV="$HOME/.personal-productivity-tracker/.env"
  echo "llm-provider (launcher): ${BOTBOY_INFERENCE_PROVIDER:-unset}"
  # Settings → AI model. Node reads the keys in its own memory and prints only
  # their last four characters plus the HTTP status of each provider's free
  # model-list probe; no key enters this shell, argv, or the output.
  if [ -f "$AI_MODEL_SETTINGS_FILE" ]; then
    "$NODE" -e '
      const fs = require("fs");
      const file = process.argv[1];
      const mode = (fs.statSync(file).mode & 0o777).toString(8);
      let value;
      try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      const pattern = /^sk-[A-Za-z0-9_-]{16,400}$/;
      const keys = {};
      if (value && value.schemaVersion === 1 && value.provider === "openai") keys.openai = value.apiKey;
      if (value && value.schemaVersion === 2 && value.keys) {
        keys.openai = value.keys.openai && value.keys.openai.apiKey;
        keys.deepseek = value.keys.deepseek && value.keys.deepseek.apiKey;
      }
      const probes = [
        ["openai", "OpenAI", "https://api.openai.com/v1/models", "api.openai.com"],
        ["deepseek", "DeepSeek", "https://api.deepseek.com/models", "api.deepseek.com"],
      ].filter(([id]) => typeof keys[id] === "string" && pattern.test(keys[id]));
      if (!value || (!probes.length && !(value.roles && Object.keys(value.roles).length))) {
        console.log(`ai-model: Settings file is unreadable (mode ${mode}) — save the key again in Settings → AI model`);
        process.exit(0);
      }
      for (const [id, label] of probes) console.log(`ai-model: ${label} key …${keys[id].slice(-4)} saved in Settings (mode ${mode})`);
      if (!probes.length) console.log(`ai-model: no API key saved; background model choices only (mode ${mode})`);
      const roles = value.roles || {};
      const choice = role => (roles[role] && roles[role].modelKey) || "automatic";
      console.log(`ai-model: organizing model ${choice("processing")}; document writing ${choice("documents")}`);
      Promise.all(probes.map(([id, label, url, host]) => fetch(url, {
        headers: { Authorization: `Bearer ${keys[id]}` },
        signal: AbortSignal.timeout(10000),
      })
        .then(response => `${id} probe: HTTP ${response.status} (200=key works, 401=key rejected)`)
        .catch(() => `${id} probe: HTTP 000 (network, proxy, or VPN blocks ${host})`)))
        .then(lines => lines.forEach(line => console.log(line)));
    ' "$AI_MODEL_SETTINGS_FILE" 2>/dev/null || echo "ai-model: could not inspect the Settings file"
  else
    echo "ai-model: no API key saved (add an OpenAI or DeepSeek key in Settings → AI model)"
  fi
  # Connections → Gmail. Node reads the OAuth client and refresh token in its
  # own memory and prints only which client is active (own or BotBoy's shared
  # one), the client ID's last characters, the account's domain, the granted
  # access, the file mode, and the HTTP status of one token refresh; no secret
  # or address enters this shell, argv, or the output.
  if [ -f "$GMAIL_TEAM_CLIENT_INBOX" ]; then
    echo "gmail: BotBoy's shared Google client is staged from the credential file (applied at the next start)"
  fi
  if [ -f "$GMAIL_CREDENTIALS_FILE" ]; then
    "$NODE" -e '
      const fs = require("fs");
      const file = process.argv[1];
      const mode = (fs.lstatSync(file).mode & 0o777).toString(8);
      let value;
      try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      const usable = entry => entry && typeof entry.clientId === "string" && typeof entry.clientSecret === "string";
      const own = value && value.schemaVersion === 1 && usable(value.client) ? value.client : null;
      const team = value && value.schemaVersion === 1 && usable(value.teamClient) ? value.teamClient : null;
      const client = own || team;
      if (!client) {
        console.log(`gmail: credentials file is unreadable (mode ${mode}) — import the BotBoy credential file again or save your own client in Connections → Gmail`);
        process.exit(0);
      }
      const source = own ? "own client" : "BotBoy shared client";
      const suffix = client.clientId.replace(/\.apps\.googleusercontent\.com$/, "").slice(-6);
      const connection = value.connection;
      if (!connection || typeof connection.refreshToken !== "string" || !connection.refreshToken) {
        console.log(`gmail: ${source} …${suffix} saved, not connected (mode ${mode})`);
        process.exit(0);
      }
      const domain = String(connection.accountEmail || "").split("@")[1] || "unknown";
      const scopes = String(connection.scope || "").split(/\s+/);
      const access = scopes.includes("https://www.googleapis.com/auth/gmail.compose") ? "read + compose" : "read only (Reconnect to allow drafting and sending)";
      console.log(`gmail: ${source} …${suffix} connected to an account at ${domain}; ${access} (mode ${mode})`);
      fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.clientId,
          client_secret: client.clientSecret,
          refresh_token: connection.refreshToken,
        }),
        signal: AbortSignal.timeout(10000),
      })
        .then(async response => {
          let code = "";
          if (!response.ok) {
            try {
              const body = await response.json();
              if (typeof body.error === "string") code = ` ${body.error.replace(/[^a-z_]/g, "").slice(0, 40)}`;
            } catch {}
          }
          console.log(`gmail refresh probe: HTTP ${response.status}${code} (200=connected, 400 invalid_grant=choose Reconnect in Connections → Gmail)`);
        })
        .catch(() => console.log("gmail refresh probe: HTTP 000 (network, proxy, or VPN blocks oauth2.googleapis.com)"));
    ' "$GMAIL_CREDENTIALS_FILE" 2>/dev/null || echo "gmail: could not inspect the credentials file"
  else
    echo "gmail: not set up (optional, for Google accounts: Connections → Gmail)"
  fi
  # Diagnose the same effective pair normal startup will use. A partial shell
  # override is reported directly and never completed from the stored file.
  DOCTOR_CID="${BOTBOY_INFERENCE_OAUTH_CLIENT_ID:-}"
  DOCTOR_SEC="${BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET:-}"
  DOCTOR_TOKEN_URL="${BOTBOY_INFERENCE_OAUTH_TOKEN_URL:-}"
  if [ "$SHELL_OAUTH_HAS_ID" != "$SHELL_OAUTH_HAS_SECRET" ]; then
    echo "llm-credentials: INCOMPLETE shell override — set both keys or unset both"
  elif [ -n "$DOCTOR_CID" ] && [ -n "$DOCTOR_SEC" ]; then
    echo "llm-credentials: complete effective pair present"
    # Live auth probe: mint a token with the effective pair. Prints ONLY the
    # HTTP status — never the credentials or the token. This is the line
    # that separates "file imported fine" from "agent not responding":
    #   200 = credentials valid and Cognito reachable
    #   400 = invalid_client — secret wrong/revoked, ask owner to reissue
    #   000 = network problem (VPN/proxy/DNS)
    DOCTOR_TOKEN_URL=${DOCTOR_TOKEN_URL:-https://botboy-luna-603949561274.auth.us-east-1.amazoncognito.com/oauth2/token}
    # Credentials go through a config file descriptor, not argv, so they
    # never appear in `ps` output.
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      -K <(printf 'user = "%s:%s"\n' "$DOCTOR_CID" "$DOCTOR_SEC") \
      -d 'grant_type=client_credentials&scope=botboy-llm/invoke' \
      "$DOCTOR_TOKEN_URL" 2>/dev/null)
    echo "llm auth probe: HTTP ${CODE:-000} (200=valid, 400=invalid/revoked — ask owner, 000=network)"
  elif [ -n "$DOCTOR_CID" ] || [ -n "$DOCTOR_SEC" ]; then
    echo "llm-credentials: INCOMPLETE — client id and secret must both be present"
  elif [ -s "$AI_MODEL_SETTINGS_FILE" ] && grep -q '"apiKey"' "$AI_MODEL_SETTINGS_FILE" 2>/dev/null; then
    echo "llm-credentials: none in ~/.personal-productivity-tracker/.env (not needed: a Settings → AI model key is used)"
  else
    echo "llm-credentials: missing (~/.personal-productivity-tracker/.env)"
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

# Reject a one-key OAuth state before any healthy old process is stopped. The
# provider treats either key as gateway intent, then exits fatally if its mate
# is absent; surface the repair directly instead of opening a dead dashboard.
if ! validate_oauth_pair; then
  exit 1
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
# Dependency self-heal. `--update` fast-forwards package.json but never ran
# npm, so a new or re-pinned dependency (BotBoy's pdf.js reader, an SDK pin)
# never reached teammates. Install only when something is missing; a failed
# install warns, and BotBoy starts with what it has.
DEPS_INSTALLED=0
MISSING_DEPS="$(missing_npm_dependencies)"
if [ -n "$MISSING_DEPS" ]; then
  echo "ℹ️  Installing dependencies ($MISSING_DEPS) — npm install" | tee -a "$LOG_FILE"
  if (cd "$PROJ_DIR" && npm install --no-audit --no-fund >> "$LOG_FILE" 2>&1); then
    echo "✅ Dependencies installed" | tee -a "$LOG_FILE"
    DEPS_INSTALLED=1
  else
    echo "⚠️  npm install failed — see $LOG_FILE. BotBoy starts without: $MISSING_DEPS" | tee -a "$LOG_FILE"
  fi
fi

NEED_BUILD=""
if [ "${BOTBOY_FORCE_BUILD:-0}" = "1" ]; then
  NEED_BUILD="updated release/customizations"
elif [ "$DEPS_INSTALLED" = "1" ]; then
  NEED_BUILD="dependencies installed"
elif [ ! -f "$PROJ_DIR/dist/index.js" ]; then
  NEED_BUILD="first run"
else
  CURRENT_COMMIT=$(git -C "$PROJ_DIR" rev-parse HEAD 2>/dev/null || echo "")
  BUILD_MARKER="$PROJ_DIR/dist/.build-commit"
  BUILT_COMMIT=$(cat "$BUILD_MARKER" 2>/dev/null || echo "")
  if [ -n "$CURRENT_COMMIT" ] && [ "$CURRENT_COMMIT" != "$BUILT_COMMIT" ]; then
    NEED_BUILD="new code since last build"
  elif [ ! -f "$BUILD_MARKER" ] \
    || [ -n "$(find "$PROJ_DIR/src" -type f -newer "$BUILD_MARKER" -print -quit 2>/dev/null)" ] \
    || [ "$PROJ_DIR/package.json" -nt "$BUILD_MARKER" ] \
    || [ "$PROJ_DIR/tsconfig.json" -nt "$BUILD_MARKER" ] \
    || [ "$PROJ_DIR/scripts/copy-ui-assets.mjs" -nt "$BUILD_MARKER" ]; then
    NEED_BUILD="local source changes"
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
  # handed over first. This is unconditional: a provisional or wedged process
  # may own the port without satisfying the final-ready endpoint.
  safe_takeover || exit 1

  "$NODE" dist/index.js >> "$LOG_FILE" 2>&1 &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$PID_FILE"

  # Forward Quit/Ctrl-C into the same receipt-aware bounded takeover path.
  trap 'foreground_shutdown INT' INT
  trap 'foreground_shutdown TERM' TERM
  trap 'foreground_shutdown HUP' HUP

  if ! wait_for_server "$SERVER_PID"; then
    stop_startup_child "$SERVER_PID"
    exit 1
  fi
  if ! open_dashboard_window fresh "$SERVER_PID"; then
    stop_startup_child "$SERVER_PID"
    exit 1
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
# Bare ./start.sh is the real start/restart path. Focus-only callers use the
# explicit --open-window branch above, so a healthy old process must not keep
# serving modules loaded before the current build.
if server_is_ready; then
  if [ -n "$NEED_BUILD" ]; then
    echo "ℹ️  Restarting BotBoy on the new build"
  else
    echo "ℹ️  Restarting BotBoy"
  fi
  safe_takeover || exit 1
fi
# 2. Start the tracker server after any exact old-process handoff.
SERVER_PID=""
if ! server_is_ready; then
  # A failed final-ready check does NOT mean no process exists: a wedged or
  # half-booted server can hold :7778. Clear every old instance before the
  # replacement starts, then verify this exact child through final readiness.
  safe_takeover || exit 1
  nohup "$NODE" dist/index.js </dev/null >> "$LOG_FILE" 2>&1 &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$PID_FILE"
  if ! wait_for_server "$SERVER_PID"; then
    stop_startup_child "$SERVER_PID"
    exit 1
  fi
fi

if ! open_dashboard_window fresh "$SERVER_PID"; then
  [ -z "$SERVER_PID" ] || stop_startup_child "$SERVER_PID"
  exit 1
fi
warn_if_no_llm_credentials
install_app_bundle_if_missing
