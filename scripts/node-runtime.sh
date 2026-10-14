#!/bin/bash
# BotBoy's private Node runtime. SOURCED by start.sh (never run on its own); bash 3.2 (macOS /bin/bash) only.
#
# Owner job (2026-10-13): a Mac with no usable Node (no Node, Homebrew, nvm or npm) clones botboy-app and runs
# ./start.sh, or opens BotBoy.app. Nothing is installed first. This file finds a Node that works and, only when
# there is none, downloads the ONE pinned official Node (node-runtime.pin), checks its SHA-256 BEFORE unpacking
# it, unpacks it under ~/.personal-productivity-tracker/runtime, and start.sh uses it for npm install, the
# build, every script and the server. Git and Chrome are still prerequisites. Map: docs/maps/teammate-install-release.md.
#
# THE RULES
#  1. A Node that works today is always preferred, and nothing about it changes (node_usable). It works when it
#     runs, is at least 20.16.0 (the documented minimum; pdfjs-dist needs it), and is neither of two cases that
#     cannot INSTALL BotBoy: "Node below 22 on a Mac with no Command Line Tools" (it compiles the database module)
#     and "a Node whose npm is 10.9.x" (that npm crashes on a FIRST install of this project's vitest peer set,
#     npm/cli#8261, measured with 10.9.9: Node 22 ships it; npm 10.8.2 and npm 11 install fine, and adding packages to
#     an installed tree worked with 10.9.9 too). Each case is still usable when the native
#     modules already work in this checkout under that Node (the launcher's own smoke: open a database, spawn a
#     pty), because then nothing has to be installed. The smoke runs only for those Nodes, so a Node 24 or a Node 22
#     with a newer npm never pays for it, and a Mac that already runs BotBoy keeps its Node.
#  2. Two phases, so nothing that is not a real start can download.
#       Phase 1, node_select_phase1: every mode and every test hook. No network. Picks the system Node, or an
#       ALREADY installed private one (the pinned version first, else the newest that runs).
#       Phase 2, ensure_node_runtime: called only from a real start and from --update when it will not start.
#       The only place that downloads. --stop, --doctor, --recover-shutdown, --open-window and --rebuild-ocr
#       never reach it; without any Node they say so and name ./start.sh.
#  3. The private Node reaches everything through PATH: start.sh puts <runtime>/bin first (npm's `#!/usr/bin/env
#     node` and npx need it, a $NODE variable is not enough), so npm install, the build, the OCR and bootstrap
#     jobs, the server, the in-app updater's child and the --foreground flow all use it. The user's own shell is
#     untouched; the model-run commands drop it from their PATH (protected-local-resources.ts).
#  4. An inherited PATH entry under runtime/ is removed before the search (node_runtime_scrub_path): the updater's
#     child inherits the server's PATH and would otherwise mistake the old private Node for a system one.
#  5. Failure never leaves a partial runtime (extract to .extract-<pid>, smoke it, one atomic rename) and every
#     message names the next action. A corrupt installed runtime (its smoke fails) is fetched again ONCE.
#  6. BOTBOY_NODE_RUNTIME=auto (default) | system (never use or download a private Node: the behaviour before this
#     file existed) | private (use it even when this Mac has a Node, downloading it if needed).
#  7. Every caller searches for a system Node the same way. node_find_system puts START_EXTRA_PATH (the folders
#     start.sh adds in front of PATH) in front of PATH itself, so the --update prefetch, which runs BEFORE start.sh
#     extends PATH, agrees with a real start about whether this Mac has a Node.
#  8. The install (node_runtime_install; the map keeps only its seams, the mechanics are here). Before any byte is
#     fetched: the chip comes from HW_ARM64 (never uname), the macOS floor is the pin's min_macos, and 1 GiB must be
#     free. One folder lock (.lock): a second start says so and exits 0; a dead holder, or a lock older than 15 minutes,
#     is taken over. curl -C - resumes a .part file (three attempts; the size must equal the pin's); curl exit 6/7/28 =
#     offline or proxy, 60 and the TLS family = a network replacing secure connections, 22 = nodejs.org no longer serves
#     the file, 33 (Range refused) deletes the partial file first, and any other exit (18, 56, ...) is retried and ends as
#     "interrupted" when the file is still short (the next start resumes). shasum -a 256 must equal the pin BEFORE tar runs; a
#     mismatch deletes the file and never unpacks it (one fresh download first only when this attempt resumed a partial
#     file). The unpack goes to .extract-<pid>, is smoke-tested (it says v<pinned version>, fs/os/crypto/zlib load, npm is
#     there), loses any download flag, and is moved to node-<version>-<chip> by one rename. Other runtimes are removed
#     unless a process runs from them.
#
# Inputs from start.sh: PROJ_DIR, HOME, LOG_FILE, HW_ARM64 (arch_facts), START_EXTRA_PATH, clt_installed, native_exec,
# native_modules_status, arch_prepare, XATTR_BIN, DOCTOR/STOP_ONLY/... and NODE_DOWNLOAD_OK.
# Outputs: NODE, NODE_SOURCE (system|private|none), NODE_REASON, NODE_NEEDS_RUNTIME, NODE_INSTALLED_DIR, PATH.
# Test hooks (production never sets them): BOTBOY_TEST_NODE_BIN (a path, or "none"), BOTBOY_TEST_NODE_RUNTIME_PIN,
# BOTBOY_TEST_NODE_DIST_URL (https, or http on 127.0.0.1 / localhost only), BOTBOY_TEST_CURL_BIN,
# BOTBOY_TEST_SHASUM_BIN, BOTBOY_TEST_TAR_BIN, BOTBOY_TEST_SW_VERS_BIN, BOTBOY_TEST_DF_BIN, BOTBOY_TEST_XATTR_BIN,
# BOTBOY_TEST_PREFER_PRIVATE_NODE=1 (every system Node counts as unusable, so a Mac whose Node works installs and uses the
# private one exactly like a Mac with none, and a failed download does not fall back to that Node: for a live run of BotBoy
# on the private Node on a Mac that has its own; BOTBOY_NODE_RUNTIME=system still wins), and
# (read by start.sh, which builds START_EXTRA_PATH) BOTBOY_TEST_NO_HOST_BIN_DIRS=1: /usr/local/bin and /opt/homebrew/bin
# are left out, so what a test finds does not depend on what is installed on the Mac that runs it.

: "${LOG_FILE:=${PPT_LOG_FILE:-/tmp/ppt.log}}"

NODE_RUNTIME_MODE="${BOTBOY_NODE_RUNTIME:-auto}"
NODE_RUNTIME_ROOT="$HOME/.personal-productivity-tracker/runtime"
NODE_RUNTIME_PIN_FILE="${BOTBOY_TEST_NODE_RUNTIME_PIN:-$PROJ_DIR/node-runtime.pin}"
NODE_RUNTIME_DIST="${BOTBOY_TEST_NODE_DIST_URL:-https://nodejs.org/dist}"
NODE_RUNTIME_DIST="${NODE_RUNTIME_DIST%/}"
case "$NODE_RUNTIME_DIST" in
  https://*|http://127.0.0.1|http://127.0.0.1:*|http://127.0.0.1/*|http://localhost|http://localhost:*|http://localhost/*) ;;
  *) NODE_RUNTIME_DIST="https://nodejs.org/dist" ;;
esac
NODE_RUNTIME_CURL="${BOTBOY_TEST_CURL_BIN:-/usr/bin/curl}"
NODE_RUNTIME_SHASUM="${BOTBOY_TEST_SHASUM_BIN:-/usr/bin/shasum}"
NODE_RUNTIME_TAR="${BOTBOY_TEST_TAR_BIN:-/usr/bin/tar}"
NODE_RUNTIME_SW_VERS="${BOTBOY_TEST_SW_VERS_BIN:-/usr/bin/sw_vers}"
NODE_RUNTIME_DF="${BOTBOY_TEST_DF_BIN:-df}"
NODE_RUNTIME_MIN_FREE_KB=1048576
NODE_MIN_VERSION="20.16.0"

NODE_SYSTEM=""
NODE_SYSTEM_VERSION=""
NODE_UNUSABLE_REASON=""
NODE_SOURCE=system
NODE_REASON=""
NODE_NEEDS_RUNTIME=0
NODE_INSTALLED_DIR=""
NODE_DOWNLOAD_OK="${NODE_DOWNLOAD_OK:-0}"
NR_ERROR=""
NR_ARCH=""
NR_VERSION=""
NR_FAIL=""
NR_CURL_RC=""
NR_LOCK_AGE=0

# ── small helpers ────────────────────────────────────────────────────────────

# Whether dotted version $1 is at least $2 (up to three numeric parts).
version_at_least() {
  local have="$1" need="$2" i h n
  local -a hv nv
  IFS=. read -r -a hv <<< "$have"
  IFS=. read -r -a nv <<< "$need"
  for i in 0 1 2; do
    h="${hv[$i]:-0}"
    n="${nv[$i]:-0}"
    [[ "$h" =~ ^[0-9]+$ ]] || h=0
    [[ "$n" =~ ^[0-9]+$ ]] || n=0
    [ "$((10#$h))" -gt "$((10#$n))" ] && return 0
    [ "$((10#$h))" -lt "$((10#$n))" ] && return 1
  done
  return 0
}

# Size of a file in bytes (0 when it does not exist).
node_runtime_file_size() {
  stat -f %z "$1" 2>/dev/null || echo 0
}

# Say a line on the terminal and in the log.
node_runtime_say() {
  echo "$1" | tee -a "$LOG_FILE"
}

# The directory with $HOME written as ~ (for messages).
node_runtime_tilde() {
  case "$1" in
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Remove every PATH entry that lies under the private runtime folder (rule 4).
node_runtime_scrub_path() {
  local rest="$PATH" dir out=""
  while [ -n "$rest" ]; do
    case "$rest" in
      *:*) dir="${rest%%:*}"; rest="${rest#*:}" ;;
      *) dir="$rest"; rest="" ;;
    esac
    case "$dir" in
      "$NODE_RUNTIME_ROOT"|"$NODE_RUNTIME_ROOT"/*) continue ;;
    esac
    out="${out:+$out:}$dir"
  done
  PATH="$out"
}

# This Mac's chip as the pin names it. Hardware, not the shell: HW_ARM64 comes from `sysctl hw.optional.arm64`.
node_runtime_chip() {
  if [ "${HW_ARM64:-0}" = "1" ]; then NR_ARCH=arm64; else NR_ARCH=x64; fi
}

# ── the pin ──────────────────────────────────────────────────────────────────

# Read node-runtime.pin into NR_*; strict, like scripts/verify-node-runtime.mjs (src/core/node-runtime.test.ts
# runs both readers over the same files). Returns 1 with NR_ERROR on any problem.
node_runtime_read_pin() {
  NR_ERROR=""; NR_VERSION=""; NR_LINE=""; NR_EOL=""; NR_MIN_MACOS=""
  NR_SHA_ARM64=""; NR_BYTES_ARM64=""; NR_SHA_X64=""; NR_BYTES_X64=""
  local file="$NODE_RUNTIME_PIN_FILE" key value schema="" seen=" " chips=0 chip sha bytes
  local re_ver='^[0-9]+\.[0-9]+\.[0-9]+$' re_sha='^[0-9a-f]{64}$' re_num='^[0-9]+$' re_mac='^[0-9]+(\.[0-9]+){0,2}$' re_date='^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  if [ ! -f "$file" ]; then NR_ERROR="node-runtime.pin is missing"; return 1; fi
  if [ "$(node_runtime_file_size "$file")" -gt 8192 ]; then NR_ERROR="node-runtime.pin is larger than 8 KB"; return 1; fi
  while IFS='=' read -r key value || [ -n "$key" ]; do
    value="${value%"${value##*[![:space:]]}"}"
    case "$key" in ''|'#'*) continue ;; esac
    case "$seen" in *" $key "*) NR_ERROR="$key appears twice"; return 1 ;; esac
    seen="$seen$key "
    case "$key" in
      schema) schema="$value" ;;
      version) NR_VERSION="$value" ;;
      line) NR_LINE="$value" ;;
      eol) NR_EOL="$value" ;;
      min_macos) NR_MIN_MACOS="$value" ;;
      darwin-arm64.sha256) NR_SHA_ARM64="$value" ;;
      darwin-arm64.bytes) NR_BYTES_ARM64="$value" ;;
      darwin-x64.sha256) NR_SHA_X64="$value" ;;
      darwin-x64.bytes) NR_BYTES_X64="$value" ;;
      *) NR_ERROR="unknown key $key"; return 1 ;;
    esac
  done < "$file"
  if [ "$schema" != "1" ]; then NR_ERROR="schema is not 1"; return 1; fi
  if ! [[ "$NR_VERSION" =~ $re_ver ]]; then NR_ERROR="version is not a full version"; return 1; fi
  if [ "${NR_VERSION%%.*}" != "$NR_LINE" ]; then NR_ERROR="line is not the major of version $NR_VERSION"; return 1; fi
  if ! [[ "$NR_EOL" =~ $re_date ]]; then NR_ERROR="eol is not a date"; return 1; fi
  if ! [[ "$NR_MIN_MACOS" =~ $re_mac ]]; then NR_ERROR="min_macos is not a macOS version"; return 1; fi
  for chip in arm64 x64; do
    if [ "$chip" = "arm64" ]; then sha="$NR_SHA_ARM64"; bytes="$NR_BYTES_ARM64"; else sha="$NR_SHA_X64"; bytes="$NR_BYTES_X64"; fi
    [ -z "$sha$bytes" ] && continue
    if ! [[ "$sha" =~ $re_sha ]]; then NR_ERROR="darwin-$chip.sha256 is not a lowercase SHA-256"; return 1; fi
    if ! [[ "$bytes" =~ $re_num ]] || [ "$bytes" -le 0 ]; then NR_ERROR="darwin-$chip.bytes is not a size"; return 1; fi
    chips=$((chips + 1))
  done
  if [ "$chips" -eq 0 ]; then NR_ERROR="no chip is pinned"; return 1; fi
  return 0
}

# ── the system Node, and the rule that decides whether it is usable ───────────

# The Node found the way start.sh always found it: PATH with START_EXTRA_PATH (start.sh's own folders) in front,
# then the layouts of common installers (n, nvm); the globs pick the newest installed version. nvm matters because it
# exists only after its shell init has run, which BotBoy.app and bare shells never do (a perfectly good nvm Node 22
# was "not found" on 2026-08-24). The extra folders are added HERE, for the lookup only, because the --update prefetch
# asks before start.sh puts them on PATH: every caller must search the same way, or an update would download a
# private Node for a Mac whose Node works (rule 7).
node_find_system() {
  local candidate saved_path="$PATH"
  NODE_SYSTEM=""
  case "${BOTBOY_TEST_NODE_BIN:-}" in
    none) return 0 ;;
    '')
      PATH="${START_EXTRA_PATH:+$START_EXTRA_PATH:}$PATH"
      NODE_SYSTEM="$(command -v node)"
      PATH="$saved_path"
      ;;
    *) NODE_SYSTEM="$BOTBOY_TEST_NODE_BIN" ;;
  esac
  if [ -z "$NODE_SYSTEM" ]; then
    for candidate in "$HOME"/n/n/versions/node/*/bin/node "$HOME"/.n/versions/node/*/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
      [ -x "$candidate" ] && NODE_SYSTEM="$candidate"
    done
  fi
  return 0
}

# npm's version for the Node at $1, read from its files (no process runs): <prefix>/lib/node_modules/npm/package.json,
# where <prefix> is the folder above the Node's bin directory (nodejs.org, Homebrew, nvm and n all lay it out so).
# Prints nothing when it cannot be told; "unknown" is never "bad".
node_runtime_npm_version() {
  local bin="$1" prefix line count=0
  case "$bin" in */*) prefix="${bin%/*}"; prefix="${prefix%/*}" ;; *) return 1 ;; esac
  [ -f "$prefix/lib/node_modules/npm/package.json" ] || return 1
  while IFS= read -r line && [ "$count" -lt 40 ]; do
    count=$((count + 1))
    if [[ "$line" =~ ^[[:space:]]*\"version\":[[:space:]]*\"([0-9]+\.[0-9]+\.[0-9]+)\" ]]; then
      printf '%s' "${BASH_REMATCH[1]}"
      return 0
    fi
  done < "$prefix/lib/node_modules/npm/package.json"
  return 1
}

# Whether npm $1 cannot install this project from a clean checkout: 10.9.x (npm/cli#8261; measured with 10.9.9 on
# 2026-10-14, 2 of 2 times; reported for 10.9.8; npm 10.8.2 and 11.19.0 install it).
node_runtime_npm_known_bad() {
  case "$1" in 10.9.*) return 0 ;; esac
  return 1
}

# Whether the native modules already work in this checkout under Node $1 (nothing needs installing).
node_runtime_modules_work() {
  [ -f "$PROJ_DIR/node_modules/better-sqlite3/package.json" ] || return 1
  NODE="$1" native_modules_status check >/dev/null 2>&1
}

# Rule 1. Sets NODE_SYSTEM_VERSION and, when it returns 1, NODE_UNUSABLE_REASON.
node_usable() {
  local bin="$1" out major npm_version
  NODE_UNUSABLE_REASON=""
  NODE_SYSTEM_VERSION=""
  if [ "${BOTBOY_TEST_PREFER_PRIVATE_NODE:-0}" = "1" ]; then
    NODE_UNUSABLE_REASON="BOTBOY_TEST_PREFER_PRIVATE_NODE=1 treats every system Node as unusable (a test switch)"
    return 1
  fi
  out="$("$bin" --version 2>/dev/null)" || { NODE_UNUSABLE_REASON="$bin does not run"; return 1; }
  if ! [[ "$out" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
    NODE_UNUSABLE_REASON="$bin did not report a Node version"
    return 1
  fi
  major="${BASH_REMATCH[1]}"
  NODE_SYSTEM_VERSION="${out#v}"
  if ! version_at_least "$NODE_SYSTEM_VERSION" "$NODE_MIN_VERSION"; then
    NODE_UNUSABLE_REASON="Node $NODE_SYSTEM_VERSION is older than the 20.16 BotBoy needs"
    return 1
  fi
  if [ "$major" -lt 22 ] && ! clt_installed; then
    # Works today only if the modules were built earlier; a fresh checkout cannot build them on this Mac.
    if node_runtime_modules_work "$bin"; then return 0; fi
    NODE_UNUSABLE_REASON="Node $NODE_SYSTEM_VERSION is below 22 and this Mac has no Command Line Tools to build BotBoy's database module (Node 24 and newer need none)"
    return 1
  fi
  npm_version="$(node_runtime_npm_version "$bin")"
  if [ -n "$npm_version" ] && node_runtime_npm_known_bad "$npm_version" && ! node_runtime_modules_work "$bin"; then
    NODE_UNUSABLE_REASON="Node $NODE_SYSTEM_VERSION comes with npm $npm_version, which cannot install BotBoy's dependencies (npm bug \"Cannot read properties of null (reading 'edgesOut')\"; Node 24 comes with npm 11, which can)"
    return 1
  fi
  return 0
}

# ── installed private runtimes ───────────────────────────────────────────────

# Whether $1 is a healthy runtime directory: Node runs and reports a version, npm is there. Sets NR_FOUND_VERSION.
node_runtime_healthy() {
  local dir="$1" out
  NR_FOUND_VERSION=""
  [ -x "$dir/bin/node" ] || return 1
  out="$(native_exec "$dir/bin/node" --version 2>/dev/null)" || return 1
  [[ "$out" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  [ -x "$dir/bin/npm" ] && [ -f "$dir/lib/node_modules/npm/bin/npm-cli.js" ] || return 1
  NR_FOUND_VERSION="${out#v}"
  return 0
}

# The newest installed runtime for this chip that runs (any version), printed; nothing when there is none.
node_runtime_find_installed() {
  local d best="" bestver="" v
  node_runtime_chip
  for d in "$NODE_RUNTIME_ROOT"/node-*-"$NR_ARCH"; do
    [ -d "$d" ] || continue
    node_runtime_healthy "$d" || continue
    v="$NR_FOUND_VERSION"
    if [ -z "$best" ] || ! version_at_least "$bestver" "$v"; then
      best="$d"
      bestver="$v"
    fi
  done
  [ -n "$best" ] && printf '%s' "$best"
  return 0
}

# ── phase 1: choose, never download ──────────────────────────────────────────

node_select_phase1() {
  local want_private=0 pinned older
  case "$NODE_RUNTIME_MODE" in
    auto|system|private) ;;
    *) echo "ℹ️  BOTBOY_NODE_RUNTIME=$NODE_RUNTIME_MODE is not auto, system or private; using auto" | tee -a "$LOG_FILE"; NODE_RUNTIME_MODE=auto ;;
  esac
  NODE_SOURCE=system; NODE_REASON=""; NODE_NEEDS_RUNTIME=0; NODE_INSTALLED_DIR=""; NODE_UNUSABLE_REASON=""
  node_runtime_scrub_path
  node_find_system
  NODE="$NODE_SYSTEM"
  if [ "$NODE_RUNTIME_MODE" = "system" ]; then
    [ -n "$NODE" ] || NODE_SOURCE=none
    return 0
  fi
  if [ "$NODE_RUNTIME_MODE" = "private" ]; then
    NODE_REASON="BOTBOY_NODE_RUNTIME=private is set"
    want_private=1
  elif [ -z "$NODE_SYSTEM" ]; then
    NODE_REASON="no Node was found on this Mac"
    want_private=1
  elif ! node_usable "$NODE_SYSTEM"; then
    NODE_REASON="$NODE_UNUSABLE_REASON"
    want_private=1
  fi
  [ "$want_private" = "1" ] || return 0
  node_runtime_chip
  if node_runtime_read_pin; then
    pinned="$NODE_RUNTIME_ROOT/node-$NR_VERSION-$NR_ARCH"
    if node_runtime_healthy "$pinned" && [ "$NR_FOUND_VERSION" = "$NR_VERSION" ]; then
      NODE="$pinned/bin/node"; NODE_SOURCE=private; NODE_INSTALLED_DIR="$pinned"
      return 0
    fi
  fi
  # The pinned copy is not installed (or the pin cannot be read): a real start fetches it (phase 2).
  NODE_NEEDS_RUNTIME=1
  older="$(node_runtime_find_installed)"
  if [ -n "$older" ]; then
    NODE="$older/bin/node"; NODE_SOURCE=private; NODE_INSTALLED_DIR="$older"
  elif [ -z "$NODE" ]; then
    NODE_SOURCE=none
  fi
  return 0
}

# ── phase 2: install the pinned runtime ──────────────────────────────────────

# One failure, in words: what happened, the next action, and the way around it. $1 kind, $2 detail.
node_runtime_fail() {
  local kind="$1" detail="${2:-}" what="" next="" around="Or install Node 24 or newer from nodejs.org yourself (the LTS download; its installer needs no other tools), then run ./start.sh again."
  case "$kind" in
    pin) what="BotBoy's Node pin (node-runtime.pin) cannot be used: $detail."; next="Run ./start.sh --update, or clone botboy-app again." ;;
    cpu) what="BotBoy's Node has no build for this Mac's processor ($detail)."; next="Install Node from nodejs.org for this Mac, then run ./start.sh again."; around="" ;;
    macos) what="BotBoy's Node v$NR_VERSION needs macOS $NR_MIN_MACOS or newer, and this Mac runs macOS $detail."; next="Update macOS in System Settings > General > Software Update (on macOS 13 Ventura, $NR_MIN_MACOS or newer is a free update), then run ./start.sh again."; around="Only if this Mac cannot update: install Node 22 from nodejs.org, run sudo npm install -g npm@11 once in Terminal (it asks for your Mac password; Node 22's own npm 10.9 cannot do BotBoy's first install), then run ./start.sh again." ;;
    home) what="BotBoy cannot place its Node: this Mac's home folder ($HOME) is not usable."; next="Run ./start.sh from your own account." ;;
    disk) what="Not enough free disk space to set up BotBoy's Node: it needs about 1 GB free and this Mac has $detail."; next="Free some space, then run ./start.sh again." ;;
    tool) what="$detail is missing from this Mac, so BotBoy cannot download or check its Node."; next="Run ./start.sh --doctor and send the output to the owner." ;;
    offline) what="Could not reach nodejs.org to download Node (curl exit $detail)."; next="Check your internet connection, VPN or proxy, then run ./start.sh again." ;;
    tls) what="Your network is replacing secure connections to nodejs.org, so the download was refused (curl exit $detail)."; next="Ask IT, or try another network (for example a phone hotspot), then run ./start.sh again." ;;
    interrupted) what="The download of Node was interrupted (curl exit $detail)."; next="Run ./start.sh again; it resumes where it stopped." ;;
    http) what="nodejs.org did not serve BotBoy's Node file (curl exit $detail: the answer was an error)."; next="Tell the owner: the pinned Node may have been removed from nodejs.org." ;;
    size) what="The downloaded Node file is not the size BotBoy expects ($detail)."; next="BotBoy deleted it. Run ./start.sh again; if it repeats, tell the owner." ;;
    hash) what="BotBoy deleted the Node download: its checksum does not match the one BotBoy has on record ($detail). It was not unpacked or run."; next="This can mean a damaged download or a network that alters files. Try another network and run ./start.sh again; if it repeats, tell the owner." ;;
    unpack) what="BotBoy could not unpack its Node ($detail)."; next="Run ./start.sh again; if it repeats, send ./start.sh --doctor to the owner." ;;
    smoke) what="BotBoy's Node was unpacked but does not run here ($detail)."; next="BotBoy removed it. Run ./start.sh again; if it repeats, send ./start.sh --doctor to the owner." ;;
    *) what="BotBoy could not set up its Node ($kind $detail)."; next="Run ./start.sh again." ;;
  esac
  node_runtime_say "❌ $what"
  node_runtime_say "    Next: $next"
  [ -z "$around" ] || node_runtime_say "    $around"
}

# Take the folder lock; 75 when another start holds it (NR_LOCK_AGE says for how long).
node_runtime_lock() {
  local lock="$NODE_RUNTIME_ROOT/.lock" holder
  mkdir -p "$NODE_RUNTIME_ROOT" 2>/dev/null || return 1
  if mkdir "$lock" 2>/dev/null; then echo "$$" > "$lock/pid"; return 0; fi
  holder="$(cat "$lock/pid" 2>/dev/null)"
  NR_LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$lock" 2>/dev/null || echo 0) ))
  # A holder that is gone (killed mid-download), or a lock older than 15 minutes, is taken over.
  if { [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; } || [ "$NR_LOCK_AGE" -ge 900 ]; then
    rm -rf "$lock"
    if mkdir "$lock" 2>/dev/null; then echo "$$" > "$lock/pid"; return 0; fi
  fi
  return 75
}
node_runtime_unlock() {
  rm -rf "$NODE_RUNTIME_ROOT/.lock"
}

# Download $1 to $2 (a .part file, resumed), expecting $3 bytes. 0, or 1 with NR_FAIL and NR_CURL_RC set.
node_runtime_download() {
  local url="$1" dest="$2" want="$3" attempt=0 size rc quiet
  if [ -t 1 ]; then quiet="--progress-bar"; else quiet="-sS"; fi
  NR_FAIL=""; NR_CURL_RC=""
  [ -x "$NODE_RUNTIME_CURL" ] || { NR_FAIL=tool; NR_CURL_RC="curl"; return 1; }
  while [ "$attempt" -lt 3 ]; do
    attempt=$((attempt + 1))
    size="$(node_runtime_file_size "$dest")"
    [ "$size" -eq "$want" ] && return 0
    [ "$size" -gt "$want" ] && rm -f "$dest"
    "$NODE_RUNTIME_CURL" -fL $quiet --retry 2 --retry-delay 2 --connect-timeout 20 --speed-limit 1024 --speed-time 60 -C - -o "$dest" "$url"
    rc=$?
    NR_CURL_RC="$rc"
    case "$rc" in
      0) ;;
      6|7|28) NR_FAIL=offline; return 1 ;;
      35|51|53|54|58|59|60|77|80|83|90|91) NR_FAIL=tls; return 1 ;;
      22) NR_FAIL=http; return 1 ;;
      33) rm -f "$dest" ;;
      *) ;;
    esac
  done
  size="$(node_runtime_file_size "$dest")"
  [ "$size" -eq "$want" ] && return 0
  if [ "$size" -gt "$want" ]; then
    rm -f "$dest"
    NR_FAIL=size; NR_CURL_RC="got $size bytes, expected $want"
  else
    NR_FAIL=interrupted
  fi
  return 1
}

# Unpack the verified tarball $1 into a runtime directory, smoke it, and move it to $2 in one rename.
node_runtime_unpack() {
  local tarball="$1" final="$2" arch="$3" tmp top out rc
  tmp="$NODE_RUNTIME_ROOT/.extract-$$"
  top="$tmp/node-v$NR_VERSION-darwin-$arch"
  rm -rf "$tmp"
  mkdir -p "$tmp" || { node_runtime_fail unpack "cannot create $tmp"; return 1; }
  if ! "$NODE_RUNTIME_TAR" -xzf "$tarball" -C "$tmp" >> "$LOG_FILE" 2>&1; then
    rm -rf "$tmp"; node_runtime_fail unpack "tar could not read the file"; return 1
  fi
  if [ ! -d "$top" ]; then rm -rf "$tmp"; node_runtime_fail unpack "the file does not hold node-v$NR_VERSION-darwin-$arch"; return 1; fi
  # The smoke, before the rename: Node runs and is the pinned version, the basics load, npm is present.
  out="$(native_exec "$top/bin/node" -e 'require("node:fs");require("node:os");require("node:crypto");require("node:zlib");process.stdout.write(process.version)' 2>>"$LOG_FILE")"
  rc=$?
  if [ "$rc" -ne 0 ] || [ "$out" != "v$NR_VERSION" ]; then
    rm -rf "$tmp"; node_runtime_fail smoke "its bin/node said \"${out:-nothing}\" instead of v$NR_VERSION"; return 1
  fi
  if [ ! -x "$top/bin/npm" ] || [ ! -f "$top/lib/node_modules/npm/bin/npm-cli.js" ]; then
    rm -rf "$tmp"; node_runtime_fail smoke "npm is missing from it"; return 1
  fi
  # The helpers' safeguard: curl and tar set no download flag, but a flagged file is never run.
  if "$XATTR_BIN" -p com.apple.quarantine "$top/bin/node" >/dev/null 2>&1; then
    "$XATTR_BIN" -r -d com.apple.quarantine "$top" >/dev/null 2>&1 || true
  fi
  printf 'version=%s\narch=%s\nsource=%s\ninstalled=%s\n' "$NR_VERSION" "$arch" "$NODE_RUNTIME_DIST/v$NR_VERSION" "$(date '+%Y-%m-%dT%H:%M:%S')" > "$top/.botboy-runtime" 2>/dev/null || true
  if [ -e "$final" ]; then mv "$final" "$NODE_RUNTIME_ROOT/.corrupt-$$" 2>/dev/null || rm -rf "$final"; fi
  if ! mv "$top" "$final"; then rm -rf "$tmp"; node_runtime_fail unpack "could not move it into place"; return 1; fi
  rm -rf "$tmp" "$NODE_RUNTIME_ROOT/.corrupt-$$"
  return 0
}

# Remove every other node-<version>-<chip> runtime, unless a process runs from it (a stopped server's copy goes at the next start).
node_runtime_remove_others() {
  local keep="$1" other
  for other in "$NODE_RUNTIME_ROOT"/node-[0-9]*; do
    [ -d "$other" ] && [ ! -L "$other" ] || continue
    [ "$other" = "$keep" ] && continue
    if pgrep -f "$other/bin/node" >/dev/null 2>&1; then
      echo "Kept $other: a process still runs from it" >> "$LOG_FILE"
      continue
    fi
    rm -rf "$other"
    echo "Removed the older Node runtime $other" >> "$LOG_FILE"
  done
}

# The work, under the lock. 0 on success (NR_INSTALLED_DIR set), 1 on failure (message printed).
node_runtime_install_locked() {
  local arch="$1" sha="$2" want="$3" final="$4" file part got mb label fresh=0 resumed=0 verified
  file="node-v$NR_VERSION-darwin-$arch.tar.gz"
  part="$NODE_RUNTIME_ROOT/.download/$file.part"
  verified="$NODE_RUNTIME_ROOT/.download/$file"
  # Another start may have finished while this one waited for the lock.
  if node_runtime_healthy "$final" && [ "$NR_FOUND_VERSION" = "$NR_VERSION" ]; then
    NR_INSTALLED_DIR="$final"
    node_runtime_remove_others "$final"
    return 0
  fi
  rm -rf "$NODE_RUNTIME_ROOT"/.extract-* "$NODE_RUNTIME_ROOT"/.corrupt-*
  if [ -e "$final" ]; then
    node_runtime_say "ℹ️  BotBoy's Node in $(node_runtime_tilde "$final") does not run; fetching it again"
    mv "$final" "$NODE_RUNTIME_ROOT/.corrupt-$$" 2>/dev/null || rm -rf "$final"
    rm -rf "$NODE_RUNTIME_ROOT/.corrupt-$$"
  fi
  mkdir -p "$NODE_RUNTIME_ROOT/.download" || { node_runtime_fail home; return 1; }
  if [ "$arch" = "arm64" ]; then label="Apple silicon"; else label="Intel"; fi
  mb=$(( (want + 999999) / 1000000 ))
  node_runtime_say "ℹ️  BotBoy needs a working Node.js, and ${NODE_REASON:-this Mac has no usable Node}. Setting up its own copy: Node v$NR_VERSION for $label (about $mb MB) from nodejs.org. It is checked against a checksum kept in this folder before it is unpacked into $(node_runtime_tilde "$NODE_RUNTIME_ROOT"), and only BotBoy uses it."
  while :; do
    [ "$(node_runtime_file_size "$part")" -gt 0 ] && [ "$(node_runtime_file_size "$part")" -lt "$want" ] && resumed=1
    rm -f "$verified"
    if ! node_runtime_download "$NODE_RUNTIME_DIST/v$NR_VERSION/$file" "$part" "$want"; then
      node_runtime_fail "$NR_FAIL" "$NR_CURL_RC"
      return 1
    fi
    got="$("$NODE_RUNTIME_SHASUM" -a 256 "$part" 2>/dev/null | awk '{ print $1 }')"
    if [ -z "$got" ]; then rm -f "$part"; node_runtime_fail tool "shasum"; return 1; fi
    if [ "$got" = "$sha" ]; then break; fi
    rm -f "$part"
    # A partial file that was resumed may have been damaged on an earlier try: one fresh download, then give up.
    if [ "$resumed" = "1" ] && [ "$fresh" = "0" ]; then fresh=1; resumed=0; continue; fi
    node_runtime_fail hash "expected ${sha:0:12}…, got ${got:0:12}…"
    return 1
  done
  mv "$part" "$verified" || { node_runtime_fail unpack "cannot rename the download"; return 1; }
  if ! node_runtime_unpack "$verified" "$final" "$arch"; then rm -f "$verified"; return 1; fi
  rm -f "$verified"
  NR_INSTALLED_DIR="$final"
  node_runtime_remove_others "$final"
  node_runtime_say "✅ Node v$NR_VERSION is ready (checksum verified)"
  return 0
}

# Preconditions, the lock, and the work. 0 installed, 1 failed (message printed), 75 another start is doing it.
node_runtime_install() {
  local arch sha want final macos free_kb rc
  NR_INSTALLED_DIR=""
  case "$NODE_RUNTIME_ROOT" in
    /?*/.personal-productivity-tracker/runtime) ;;
    *) node_runtime_fail home; return 1 ;;
  esac
  node_runtime_chip
  arch="$NR_ARCH"
  if ! node_runtime_read_pin; then node_runtime_fail pin "$NR_ERROR"; return 1; fi
  if [ "$arch" = "arm64" ]; then sha="$NR_SHA_ARM64"; want="$NR_BYTES_ARM64"; else sha="$NR_SHA_X64"; want="$NR_BYTES_X64"; fi
  if [ -z "$sha" ]; then
    if [ "$arch" = "arm64" ]; then node_runtime_fail cpu "Apple silicon"; else node_runtime_fail cpu "Intel"; fi
    return 1
  fi
  macos="$("$NODE_RUNTIME_SW_VERS" -productVersion 2>/dev/null)"
  if [[ "$macos" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] && ! version_at_least "$macos" "$NR_MIN_MACOS"; then
    node_runtime_fail macos "$macos"
    return 1
  fi
  free_kb="$("$NODE_RUNTIME_DF" -k "$HOME" 2>/dev/null | awk 'NR == 2 { print $4 }')"
  if [[ "$free_kb" =~ ^[0-9]+$ ]] && [ "$free_kb" -lt "$NODE_RUNTIME_MIN_FREE_KB" ]; then
    node_runtime_fail disk "$(awk -v k="$free_kb" 'BEGIN { printf "%.1f GB", k / 1048576 }')"
    return 1
  fi
  final="$NODE_RUNTIME_ROOT/node-$NR_VERSION-$arch"
  node_runtime_lock
  rc=$?
  if [ "$rc" -ne 0 ]; then
    [ "$rc" -eq 75 ] && return 75
    node_runtime_fail home
    return 1
  fi
  node_runtime_install_locked "$arch" "$sha" "$want" "$final"
  rc=$?
  node_runtime_unlock
  return "$rc"
}

# Make $1 (a runtime directory) the Node this start uses: NODE, the source, PATH (rule 3), the architecture facts.
node_adopt() {
  NODE="$1/bin/node"
  NODE_SOURCE=private
  NODE_INSTALLED_DIR="$1"
  NODE_NEEDS_RUNTIME=0
  PATH="$1/bin:$PATH"
  export PATH
  arch_prepare
}

# Phase 2. Called only from a real start. Installs the pinned runtime when phase 1 asked for it; on failure a Node
# that still works carries on (with a warning), otherwise the start ends here with the reason.
ensure_node_runtime() {
  local rc
  if [ "${NODE_NEEDS_RUNTIME:-0}" != "1" ]; then
    # The pinned copy is installed. Retire older ones that a running server kept alive at the last swap: nothing
    # runs from them any more (a copy a process still runs from is left alone, again).
    if [ "$NODE_SOURCE" = "private" ] && [ -n "$NODE_INSTALLED_DIR" ]; then node_runtime_remove_others "$NODE_INSTALLED_DIR"; fi
    return 0
  fi
  node_runtime_install
  rc=$?
  if [ "$rc" -eq 0 ]; then
    node_adopt "$NR_INSTALLED_DIR"
    return 0
  fi
  if [ "$rc" -eq 75 ]; then
    node_runtime_say "ℹ️  Another ./start.sh is already setting up BotBoy's Node (for ${NR_LOCK_AGE}s) — let it finish."
    exit 0
  fi
  if [ -n "$NODE_INSTALLED_DIR" ]; then
    node_runtime_say "⚠️  Could not fetch the pinned Node v$NR_VERSION now; continuing with the BotBoy Node already installed ($(node_runtime_tilde "$NODE_INSTALLED_DIR")), which still works."
    node_adopt "$NODE_INSTALLED_DIR"
    return 0
  fi
  if [ "$NODE_RUNTIME_MODE" = "auto" ] && [ "${BOTBOY_TEST_PREFER_PRIVATE_NODE:-0}" != "1" ] && [ -n "$NODE_SYSTEM" ] && NODE="$NODE_SYSTEM" native_modules_status check >/dev/null 2>&1; then
    NODE="$NODE_SYSTEM"
    node_runtime_say "⚠️  Continuing with $NODE (Node ${NODE_SYSTEM_VERSION:-?}): BotBoy could not set up its own Node, and this one runs with the modules already installed."
    return 0
  fi
  exit 1
}

# --update that will not start BotBoy (guarded, or BOTBOY_UPDATE_NO_START): fetch the pinned Node now when this Mac
# uses or needs the private one, so the next start finds it. Never fails the update.
node_runtime_update_prefetch() {
  [ "$NODE_RUNTIME_MODE" != "system" ] || return 0
  node_select_phase1
  [ "$NODE_NEEDS_RUNTIME" = "1" ] || return 0
  if node_runtime_install; then
    node_runtime_say "✅ BotBoy's Node is ready for the new release"
  else
    node_runtime_say "ℹ️  BotBoy's new Node could not be fetched now; the next ./start.sh tries again."
  fi
  return 0
}

# ── what a mode without a Node says, and the doctor's rows ───────────────────

# The two doctor rows. Read-only: nothing is run beyond `--version` of the Node in use.
doctor_node_runtime_rows() {
  local shown pinned_dir state="" source_row
  shown="$(node_runtime_tilde "$NODE_RUNTIME_ROOT")"
  node_runtime_chip
  case "$NODE_SOURCE" in
    private) source_row="node source: private v$(node_runtime_version_of "$NODE") because $NODE_REASON ($NODE)" ;;
    none)
      if [ "$NODE_RUNTIME_MODE" = "system" ]; then source_row="node source: none (BOTBOY_NODE_RUNTIME=system keeps BotBoy's own Node off)"
      else source_row="node source: none ($NODE_REASON); ./start.sh will set up BotBoy's own Node"; fi ;;
    *)
      if [ -z "$NODE" ]; then source_row="node source: none"
      elif [ "$NODE_NEEDS_RUNTIME" = "1" ]; then source_row="node source: system v$(node_runtime_version_of "$NODE") at $NODE is NOT usable ($NODE_REASON); ./start.sh will set up BotBoy's own Node"
      else source_row="node source: system v$(node_runtime_version_of "$NODE") at $NODE (BotBoy's own Node is not needed)"; fi ;;
  esac
  echo "$source_row"
  if ! node_runtime_read_pin; then
    echo "node runtime: the pin cannot be read ($NR_ERROR); folder $shown. Run ./start.sh --update"
    return 0
  fi
  pinned_dir="$NODE_RUNTIME_ROOT/node-$NR_VERSION-$NR_ARCH"
  if node_runtime_healthy "$pinned_dir" && [ "$NR_FOUND_VERSION" = "$NR_VERSION" ]; then
    if [ "$NODE_SOURCE" = "private" ]; then state="installed in $(node_runtime_tilde "$pinned_dir") and in use; no download needed"
    else state="installed in $(node_runtime_tilde "$pinned_dir") but not in use: this Mac's own Node works (rm -rf $shown removes it)"; fi
  elif [ "$NODE_NEEDS_RUNTIME" = "1" ]; then
    state="not installed; the next ./start.sh downloads it from nodejs.org (checksum verified, about 1 GB free needed)"
  else
    state="not installed, and not needed: this Mac's own Node works"
  fi
  echo "node runtime: pinned Node $NR_VERSION (Node $NR_LINE, supported until $NR_EOL), $NR_ARCH; $state"
}

# The version of a Node binary, for the rows above ("?" when it will not say).
node_runtime_version_of() {
  local out
  out="$("$1" --version 2>/dev/null)" || out=""
  [[ "$out" =~ ^v[0-9.]+$ ]] && printf '%s' "${out#v}" || printf '?'
}

# A short doctor for a Mac with no Node: the doctor itself needs Node for most rows, and never downloads.
node_doctor_without_node() {
  echo "== BotBoy doctor — $(date) =="
  echo "macos: $("$NODE_RUNTIME_SW_VERS" -productVersion 2>/dev/null) ($(uname -m))"
  echo "node:  none usable on this Mac"
  doctor_node_runtime_rows
  [ "${PYTHON_RUNTIME_LOADED:-0}" != "1" ] || doctor_python_rows
  echo "The other rows need Node. Run ./start.sh once (it sets up BotBoy's own Node), then ./start.sh --doctor again. The doctor never downloads."
}

# No Node at all after phase 1. A real start goes on to phase 2; every other mode says what to do and stops.
node_none_found() {
  if [ "$NODE_DOWNLOAD_OK" = "1" ] && [ "$NODE_RUNTIME_MODE" != "system" ]; then
    return 0
  fi
  if [ "$DOCTOR" = "1" ]; then
    node_doctor_without_node
    exit 0
  fi
  if [ "$STOP_ONLY" = "1" ] && ! pgrep -f 'node dist/index.js' >/dev/null 2>&1; then
    echo "ℹ️  BotBoy is not running"
    exit 0
  fi
  if [ "$NODE_RUNTIME_MODE" = "system" ]; then
    node_runtime_say "❌ node not found — install Node 24 or newer from nodejs.org (the LTS download; the installer needs no other tools), then re-run ./start.sh. BOTBOY_NODE_RUNTIME=system keeps BotBoy from using its own copy."
  else
    node_runtime_say "❌ node not found — this Mac has no Node yet, and this command never downloads one. Run ./start.sh first: it sets up BotBoy's own Node (a verified download from nodejs.org, about 50 MB), or install Node 24 or newer from nodejs.org yourself (the LTS download)."
  fi
  exit 1
}

# Test hook output (BOTBOY_TEST_NODE_SELECT / BOTBOY_TEST_NODE_ENSURE): the decision, one key=value per line.
print_node_selection() {
  node_runtime_chip
  echo "node=$NODE"
  echo "source=$NODE_SOURCE"
  echo "reason=$NODE_REASON"
  echo "needs_runtime=$NODE_NEEDS_RUNTIME"
  echo "download_allowed=$NODE_DOWNLOAD_OK"
  echo "mode=$NODE_RUNTIME_MODE"
  echo "path_first=${PATH%%:*}"
  echo "chip=$NR_ARCH"
}

NODE_RUNTIME_LOADED=1
