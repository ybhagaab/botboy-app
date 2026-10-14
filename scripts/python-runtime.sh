#!/bin/bash
# BotBoy's private Python runtime: uv plus ONE CPython. SOURCED by start.sh (never run on its own); bash 3.2 only.
#
# Owner job (2026-10-14): on any Mac, with or without Python or uv, Python MCP servers (uvx, uv run, python3 -m, and
# bare names from uv tool or pip --user), chat's Python and BotBoy features that run Python (a2-analytics) work without
# the user installing anything. A Mac whose own Python and uv work changes in nothing. Map: docs/maps/python-runtime.md.
#
# THE RULES
#  1. A usable system Python or uv is always preferred, and nothing about it changes. Python: the FIRST python3,
#     python3.13, python3.12, python3.11 or python3.10 on the search path that is not Apple's /usr/bin/python3 (nor a link
#     or hard link to it, nor a copy in the Command Line Tools or an Xcode app) and reports 3.10 or newer when run with
#     -I. Any one qualifying makes Python "system" (a2-analytics picks python3.13..3.10 first, so a Mac with only a good
#     python3.12 must keep it). uv: the first uv on the search path, 0.3.0 or newer, with uvx beside it. Apple's own
#     Python (3.9, Command Line Tools) never counts and is NEVER run: neither is /usr/bin/install_name_tool.
#  2. The search path is START_EXTRA_PATH in front of PATH, with inherited runtime/python and runtime/uv-* entries
#     removed first (python_runtime_scrub_path), so the --update prefetch, a start and the doctor agree.
#  3. The runtime is ONE unit: BotBoy's uv runs only its own managed CPython (UV_MANAGED_PYTHON), so both are installed
#     when either is missing. PATH is decided per part: BotBoy's Python bin goes first only when Python is private, its
#     uv folder only when uv is private (python_runtime_adopt).
#  4. Phases, so nothing that is not a real start downloads. Phase 1 (python_select_phase1) runs anywhere and never
#     downloads. A real start begins the download in the BACKGROUND right after ensure_node_runtime
#     (python_runtime_fetch_begin), overlapping npm install and the build, and joins it immediately before the server
#     starts (python_runtime_fetch_join): when this start ran npm or a build (and is not an update's start,
#     BOTBOY_FORCE_BUILD), until the 180 s deadline, by which every download of the job has ended by itself, plus 10 s
#     for its install step; otherwise (a restart with nothing to build, or an update's start) at most 20 s. A job
#     still running at the join gets one line with that bound before the wait. At the limit the job is stopped (its
#     .part file stays, curl -C - resumes it), BotBoy starts without Python, and the next start continues. Phase 1
#     runs again after the join, so the server's PATH matches what exists.
#     --stop, --doctor, --recover-shutdown, --open-window and --rebuild-ocr never download. Python is OPTIONAL: no
#     failure here ever stops a start.
#  5. The install (python_runtime_install, under runtime/.python.lock; the map keeps only its seams). Before any byte is
#     fetched: the chip from HW_ARM64, macOS 11.0 or newer (the files' floor), 1 GiB free. curl resumes a .part file;
#     every call gets --max-time from the deadline. Curl's classes: 6/7 offline, 28 offline unless the .part grew in
#     this attempt (then "slow"), the TLS family "tls", 22 "http"; the job stops at the first offline, slow, tls or
#     http class and never tries the second file after a network failure. shasum -a 256 must equal the pin BEFORE tar
#     runs; a mismatch deletes the file and never unpacks it. uv is unpacked into .py-extract-<pid>, its real binaries go
#     to libexec/ and two /bin/sh wrappers (uv, uvx) set BotBoy's settings with ${VAR:-...} (a declared value wins),
#     smoked (--version equals the pin), and moved by one rename to runtime/uv-<version>-<arm64|x64>. Then the new uv
#     installs the CPython from the verified local file through a file:// mirror laid out as <build>/<file> (a literal
#     '+' in the name, the URL percent-encoded), with env -i, PATH=/bin:/usr/sbin:/sbin (uv looks up install_name_tool
#     by name, and /usr/bin holds the Xcode stand-in), UV_NO_CONFIG=1 and UV_NO_CACHE=1 (the user's ~/.cache/uv is
#     never touched); uv checks the file again against its own built-in hash and places it atomically. BotBoy's
#     EXTERNALLY-MANAGED text replaces uv's, and the smoke (python3 -I -c, the pinned version, ssl/sqlite3/venv/ensurepip/
#     ctypes/zlib, the marker text) must pass; a runtime that fails it is removed and fetched again at the next start.
#  6. Everything sandboxed Python work writes lives in ONE folder outside the private root, ~/.botboy-python (bin,
#     tools, cache, user site). Never uv's default ~/.local/bin, which start.sh puts in FRONT of built-ins' PATH. The
#     runtime itself is read-only to sandboxed children (protected-local-resources.ts).
#  7. Maintenance (python_runtime_maintenance) runs right before the server is spawned, after the last safe_takeover
#     (the old server's uvx children are gone by then), at most weekly: skipped at once when any process runs from the
#     runtime or ~/.botboy-python; `du -sk` of BotBoy's own uv cache (20 s limit); above 5 GB `uv cache prune` (60 s,
#     never --force); still above 10 GB `uv cache clean` of that cache only (tool environments live in tools/); older
#     patches of the pinned minor are uninstalled. The stamp ~/.botboy-python/.maintenance is written on every attempt.
#  8. BOTBOY_PYTHON_RUNTIME=auto (default) | system (never use or download BotBoy's Python: the behaviour before this
#     file existed) | private (use it even when this Mac has its own).
#  9. An --update that will not start BotBoy fetches a changed pin only for a Mac that already HAS BotBoy's Python
#     (python_runtime_update_prefetch); a first install is left to the next start, which does it in the background.
#
# Inputs from start.sh: PROJ_DIR, HOME, LOG_FILE, HW_ARM64 (arch_facts), START_EXTRA_PATH, NODE_DOWNLOAD_OK, XATTR_BIN,
# version_at_least (scripts/node-runtime.sh; a copy below is used when that file is absent).
# Outputs: PY_SOURCE / UV_SOURCE (system|private|none), PY_REASON / UV_REASON, PY_NEEDS_RUNTIME, PY_BIN_DIR, PY_UV_DIR,
# PATH (python_runtime_adopt only).
# Test hooks (production never sets them): BOTBOY_TEST_PYTHON_RUNTIME_PIN, BOTBOY_TEST_PYTHON_DIST_URL (https, or
# http on 127.0.0.1 / localhost only), BOTBOY_TEST_PYTHON_CURL_BIN, BOTBOY_TEST_PYTHON_TAR_BIN, BOTBOY_TEST_SHASUM_BIN,
# BOTBOY_TEST_SW_VERS_BIN, BOTBOY_TEST_DF_BIN, BOTBOY_TEST_XATTR_BIN, BOTBOY_TEST_PYTHON_SHIM (a stand-in for
# /usr/bin/python3: skipped like it, never run), BOTBOY_TEST_PYTHON_DEVTOOLS_DIR (a stand-in for the Command Line
# Tools folder), BOTBOY_TEST_PYTHON_BUDGET_SECONDS, BOTBOY_TEST_PYTHON_RESTART_JOIN_SECONDS,
# BOTBOY_TEST_PYTHON_PRUNE_KB / _CLEAN_KB (the maintenance thresholds), and BOTBOY_TEST_PREFER_PRIVATE_PYTHON=1: every
# system Python and uv counts as unusable (nothing of theirs is run), so a Mac that has its own installs and uses
# BotBoy's exactly like a Mac with none, for the orchestrator's live run; BOTBOY_PYTHON_RUNTIME=system still wins.

: "${LOG_FILE:=${PPT_LOG_FILE:-/tmp/ppt.log}}"

PY_RUNTIME_MODE="${BOTBOY_PYTHON_RUNTIME:-auto}"
PY_RUNTIME_ROOT="$HOME/.personal-productivity-tracker/runtime"
PY_RUNTIME_PIN_FILE="${BOTBOY_TEST_PYTHON_RUNTIME_PIN:-$PROJ_DIR/python-runtime.pin}"
PY_DIST="${BOTBOY_TEST_PYTHON_DIST_URL:-https://github.com}"
PY_DIST="${PY_DIST%/}"
case "$PY_DIST" in
  https://*|http://127.0.0.1|http://127.0.0.1:*|http://127.0.0.1/*|http://localhost|http://localhost:*|http://localhost/*) ;;
  *) PY_DIST="https://github.com" ;;
esac
PY_CURL="${BOTBOY_TEST_PYTHON_CURL_BIN:-/usr/bin/curl}"
PY_TAR="${BOTBOY_TEST_PYTHON_TAR_BIN:-/usr/bin/tar}"
PY_SHASUM="${BOTBOY_TEST_SHASUM_BIN:-/usr/bin/shasum}"
PY_SW_VERS="${BOTBOY_TEST_SW_VERS_BIN:-/usr/bin/sw_vers}"
PY_DF="${BOTBOY_TEST_DF_BIN:-df}"
PY_XATTR="${XATTR_BIN:-${BOTBOY_TEST_XATTR_BIN:-/usr/bin/xattr}}"
# Apple's /usr/bin/python3 is an Xcode stand-in (xcselect): it is skipped by path, by real path and by inode, never run.
PY_SHIM="/usr/bin/python3"
PY_DEVTOOLS_DIR="/Library/Developer/CommandLineTools"
PY_MIN_VERSION="3.10.0"
UV_MIN_VERSION="0.3.0"
PY_MIN_MACOS="11.0"
PY_MIN_FREE_KB=1048576
PY_USER_BASE="$HOME/.botboy-python"
PY_BUDGET_SECONDS=180
PY_RESTART_JOIN_SECONDS=20
PY_JOIN_GRACE_SECONDS=10
PY_PRUNE_KB=5242880
PY_CLEAN_KB=10485760
[[ "${BOTBOY_TEST_PYTHON_BUDGET_SECONDS:-}" =~ ^[0-9]+$ ]] && PY_BUDGET_SECONDS="$BOTBOY_TEST_PYTHON_BUDGET_SECONDS"
[[ "${BOTBOY_TEST_PYTHON_RESTART_JOIN_SECONDS:-}" =~ ^[0-9]+$ ]] && PY_RESTART_JOIN_SECONDS="$BOTBOY_TEST_PYTHON_RESTART_JOIN_SECONDS"
[[ "${BOTBOY_TEST_PYTHON_PRUNE_KB:-}" =~ ^[0-9]+$ ]] && PY_PRUNE_KB="$BOTBOY_TEST_PYTHON_PRUNE_KB"
[[ "${BOTBOY_TEST_PYTHON_CLEAN_KB:-}" =~ ^[0-9]+$ ]] && PY_CLEAN_KB="$BOTBOY_TEST_PYTHON_CLEAN_KB"
# The test switch counts only in auto mode: BOTBOY_PYTHON_RUNTIME=system and =private win over it.
PY_PREFER_PRIVATE=0
[ "$PY_RUNTIME_MODE" = "auto" ] && [ "${BOTBOY_TEST_PREFER_PRIVATE_PYTHON:-0}" = "1" ] && PY_PREFER_PRIVATE=1
# The text BotBoy's CPython shows for a plain `pip install` outside a sandbox that sets PIP_BREAK_SYSTEM_PACKAGES, and
# that `uv pip install --system` shows (design review finding 8): the error names the next action.
PY_MANAGED_MARKER="BotBoy keeps its own Python read-only."
PY_MANAGED_TEXT="[externally-managed]
Error=BotBoy keeps its own Python read-only. In BotBoy chat, pip install <package> adds it to ~/.botboy-python. Elsewhere, use a virtual environment: python3 -m venv .venv && .venv/bin/pip install <package> (or uv venv, then uv pip install <package>)."

PY_SOURCE=system
UV_SOURCE=system
PY_REASON=""
UV_REASON=""
PY_SYSTEM=""
PY_SYSTEM_VERSION=""
UV_SYSTEM=""
UV_SYSTEM_VERSION=""
PY_NEEDS_RUNTIME=0
PY_NEEDS_DOWNLOAD=0
PY_BIN_DIR=""
PY_UV_DIR=""
PY_JOB_PID=""
PY_JOB_NOTES=""
PY_DEADLINE=0
PY_IN_JOB=0
PY_JOIN_LONG="${PY_JOIN_LONG:-0}"
PR_ERROR=""
PR_FAIL=""
PR_CURL_RC=""
PR_LOCK_AGE=0

# version_at_least comes from scripts/node-runtime.sh; a checkout without it still needs the comparison.
if ! type version_at_least >/dev/null 2>&1; then
  version_at_least() {
    local have="$1" need="$2" i h n
    local -a hv nv
    IFS=. read -r -a hv <<< "$have"
    IFS=. read -r -a nv <<< "$need"
    for i in 0 1 2; do
      h="${hv[$i]:-0}"; n="${nv[$i]:-0}"
      [[ "$h" =~ ^[0-9]+$ ]] || h=0
      [[ "$n" =~ ^[0-9]+$ ]] || n=0
      [ "$((10#$h))" -gt "$((10#$n))" ] && return 0
      [ "$((10#$h))" -lt "$((10#$n))" ] && return 1
    done
    return 0
  }
fi

# ── small helpers ────────────────────────────────────────────────────────────

python_runtime_file_size() {
  stat -f %z "$1" 2>/dev/null || echo 0
}

# A line for the owner: the terminal and the log, or, inside the background job, the log and the notes the join prints.
python_runtime_say() {
  if [ "$PY_IN_JOB" = "1" ]; then
    echo "$1"
    [ -z "$PY_JOB_NOTES" ] || echo "$1" >> "$PY_JOB_NOTES"
  else
    echo "$1" | tee -a "$LOG_FILE"
  fi
}

python_runtime_tilde() {
  case "$1" in
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# The real path of a file (links resolved, no external tool): bash's cd -P for the folder, readlink for the file.
py_realpath() {
  local file="$1" target dir count=0
  while [ -L "$file" ] && [ "$count" -lt 40 ]; do
    target="$(readlink "$file")" || break
    case "$target" in
      /*) file="$target" ;;
      *) file="$(dirname "$file")/$target" ;;
    esac
    count=$((count + 1))
  done
  dir="$(cd -P "$(dirname "$file")" 2>/dev/null && pwd -P)" || { printf '%s' "$file"; return 0; }
  printf '%s/%s' "$dir" "$(basename "$file")"
}

# The real path of a folder ("" when it does not exist).
py_realdir() {
  (cd -P "$1" 2>/dev/null && pwd -P)
}

# Remove PATH entries under BotBoy's Python runtime folders (runtime/python and runtime/uv-*). Node's own runtime
# entries are left alone: start.sh adds the Node bin before Python is chosen.
python_runtime_scrub_path() {
  local rest="$PATH" dir out=""
  while [ -n "$rest" ]; do
    case "$rest" in
      *:*) dir="${rest%%:*}"; rest="${rest#*:}" ;;
      *) dir="$rest"; rest="" ;;
    esac
    case "$dir" in
      "$PY_RUNTIME_ROOT/python"|"$PY_RUNTIME_ROOT/python"/*|"$PY_RUNTIME_ROOT"/uv-*) continue ;;
    esac
    out="${out:+$out:}$dir"
  done
  PATH="$out"
}

# The chip as the pin names it, and as uv and python-build-standalone name it.
python_runtime_chip() {
  if [ "${HW_ARM64:-0}" = "1" ]; then PR_CHIP=arm64; PR_TRIPLE=aarch64; else PR_CHIP=x64; PR_TRIPLE=x86_64; fi
}

# Every executable regular file called $1 on the search path (START_EXTRA_PATH in front of PATH; absolute folders
# only), in order, one per line. Nothing is run.
py_candidates_on_path() {
  local name="$1" rest="${START_EXTRA_PATH:+$START_EXTRA_PATH:}$PATH" dir seen=":"
  while [ -n "$rest" ]; do
    case "$rest" in
      *:*) dir="${rest%%:*}"; rest="${rest#*:}" ;;
      *) dir="$rest"; rest="" ;;
    esac
    case "$dir" in /*) ;; *) continue ;; esac
    case "$seen" in *":$dir:"*) continue ;; esac
    seen="$seen$dir:"
    if [ -f "$dir/$name" ] && [ -x "$dir/$name" ]; then
      printf '%s\n' "$dir/$name"
    fi
  done
  return 0
}

# The first of them.
py_first_on_path() {
  local first
  first="$(py_candidates_on_path "$1" | head -n 1)"
  [ -n "$first" ] || return 1
  printf '%s' "$first"
}

# ── the pin ──────────────────────────────────────────────────────────────────

# Read python-runtime.pin into PR_*; strict, like scripts/verify-python-runtime.mjs (python-runtime.test.ts runs both
# readers over the same files). Returns 1 with PR_ERROR on any problem.
python_runtime_read_pin() {
  PR_ERROR=""; PR_UV_VERSION=""; PR_PY_VERSION=""; PR_PY_BUILD=""; PR_PY_EOL=""; PR_PY_MINOR=""
  PR_UV_SHA_ARM64=""; PR_UV_BYTES_ARM64=""; PR_UV_SHA_X64=""; PR_UV_BYTES_X64=""
  PR_PY_SHA_ARM64=""; PR_PY_BYTES_ARM64=""; PR_PY_SHA_X64=""; PR_PY_BYTES_X64=""
  local file="$PY_RUNTIME_PIN_FILE" key value schema="" seen=" " chips=0 chip part sha bytes have_uv have_py
  local re_ver='^[0-9]+\.[0-9]+\.[0-9]+$' re_py='^3\.[0-9]+\.[0-9]+$' re_build='^[0-9]{8}$' re_sha='^[0-9a-f]{64}$' re_num='^[0-9]+$' re_date='^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  if [ ! -f "$file" ]; then PR_ERROR="python-runtime.pin is missing"; return 1; fi
  if [ "$(python_runtime_file_size "$file")" -gt 8192 ]; then PR_ERROR="python-runtime.pin is larger than 8 KB"; return 1; fi
  while IFS='=' read -r key value || [ -n "$key" ]; do
    value="${value%"${value##*[![:space:]]}"}"
    key="${key%$'\r'}"
    case "$key" in ''|'#'*) continue ;; esac
    case "$seen" in *" $key "*) PR_ERROR="$key appears twice"; return 1 ;; esac
    seen="$seen$key "
    case "$key" in
      schema) schema="$value" ;;
      uv.version) PR_UV_VERSION="$value" ;;
      python.version) PR_PY_VERSION="$value" ;;
      python.build) PR_PY_BUILD="$value" ;;
      python.eol) PR_PY_EOL="$value" ;;
      uv.darwin-arm64.sha256) PR_UV_SHA_ARM64="$value" ;;
      uv.darwin-arm64.bytes) PR_UV_BYTES_ARM64="$value" ;;
      uv.darwin-x64.sha256) PR_UV_SHA_X64="$value" ;;
      uv.darwin-x64.bytes) PR_UV_BYTES_X64="$value" ;;
      python.darwin-arm64.sha256) PR_PY_SHA_ARM64="$value" ;;
      python.darwin-arm64.bytes) PR_PY_BYTES_ARM64="$value" ;;
      python.darwin-x64.sha256) PR_PY_SHA_X64="$value" ;;
      python.darwin-x64.bytes) PR_PY_BYTES_X64="$value" ;;
      *) PR_ERROR="unknown key $key"; return 1 ;;
    esac
  done < "$file"
  if [ "$schema" != "1" ]; then PR_ERROR="schema is not 1"; return 1; fi
  if ! [[ "$PR_UV_VERSION" =~ $re_ver ]]; then PR_ERROR="uv.version is not a full version"; return 1; fi
  if ! [[ "$PR_PY_VERSION" =~ $re_py ]]; then PR_ERROR="python.version is not a full CPython 3 version"; return 1; fi
  if ! [[ "$PR_PY_BUILD" =~ $re_build ]]; then PR_ERROR="python.build is not a build tag"; return 1; fi
  if ! [[ "$PR_PY_EOL" =~ $re_date ]]; then PR_ERROR="python.eol is not a date"; return 1; fi
  PR_PY_MINOR="${PR_PY_VERSION%.*}"
  for chip in arm64 x64; do
    have_uv=0; have_py=0
    for part in uv python; do
      case "$part:$chip" in
        uv:arm64) sha="$PR_UV_SHA_ARM64"; bytes="$PR_UV_BYTES_ARM64" ;;
        uv:x64) sha="$PR_UV_SHA_X64"; bytes="$PR_UV_BYTES_X64" ;;
        python:arm64) sha="$PR_PY_SHA_ARM64"; bytes="$PR_PY_BYTES_ARM64" ;;
        python:x64) sha="$PR_PY_SHA_X64"; bytes="$PR_PY_BYTES_X64" ;;
      esac
      [ -z "$sha$bytes" ] && continue
      if ! [[ "$sha" =~ $re_sha ]]; then PR_ERROR="$part.darwin-$chip.sha256 is not a lowercase SHA-256"; return 1; fi
      if ! [[ "$bytes" =~ $re_num ]] || [ "$bytes" -le 0 ]; then PR_ERROR="$part.darwin-$chip.bytes is not a size"; return 1; fi
      if [ "$part" = "uv" ]; then have_uv=1; else have_py=1; fi
    done
    if [ "$have_uv" != "$have_py" ]; then PR_ERROR="darwin-$chip is pinned for one part only"; return 1; fi
    [ "$have_uv" = "1" ] && chips=$((chips + 1))
  done
  if [ "$chips" -eq 0 ]; then PR_ERROR="no chip is pinned"; return 1; fi
  return 0
}

# ── the system Python and uv ─────────────────────────────────────────────────

# Whether $1 is Apple's Python stand-in or a copy of the Command Line Tools / Xcode Python: by path, by real path, and by
# inode (every xcselect shim in /usr/bin is a hard link of one file). Nothing is run.
python_is_apple_stand_in() {
  local file="$1" real inode shim_inode test_inode
  [ "$file" = "$PY_SHIM" ] && return 0
  [ -n "${BOTBOY_TEST_PYTHON_SHIM:-}" ] && [ "$file" = "$BOTBOY_TEST_PYTHON_SHIM" ] && return 0
  real="$(py_realpath "$file")"
  [ "$real" = "$PY_SHIM" ] && return 0
  [ -n "${BOTBOY_TEST_PYTHON_SHIM:-}" ] && [ "$real" = "$(py_realpath "$BOTBOY_TEST_PYTHON_SHIM")" ] && return 0
  case "$real" in
    "$PY_DEVTOOLS_DIR"/*|/Applications/Xcode*.app/*) return 0 ;;
  esac
  if [ -n "${BOTBOY_TEST_PYTHON_DEVTOOLS_DIR:-}" ]; then
    case "$real" in "$BOTBOY_TEST_PYTHON_DEVTOOLS_DIR"/*) return 0 ;; esac
  fi
  inode="$(stat -f '%d:%i' "$real" 2>/dev/null)"
  shim_inode="$(stat -f '%d:%i' "$PY_SHIM" 2>/dev/null)"
  [ -n "$inode" ] && [ "$inode" = "$shim_inode" ] && return 0
  if [ -n "${BOTBOY_TEST_PYTHON_SHIM:-}" ]; then
    test_inode="$(stat -f '%d:%i' "$BOTBOY_TEST_PYTHON_SHIM" 2>/dev/null)"
    [ -n "$inode" ] && [ "$inode" = "$test_inode" ] && return 0
  fi
  return 1
}

# The version a candidate Python reports (x.y.z), run isolated (-I: no user site, no PYTHON* variables). Never called
# for an Apple stand-in.
python_probe_version() {
  local out
  out="$("$1" -I -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null)" || return 1
  out="${out%%$'\n'*}"
  [[ "$out" =~ ^3\.[0-9]+\.[0-9]+$ ]] || return 1
  printf '%s' "$out"
}

# Rule 1 for Python. For each name, the first file on the search path that is not an Apple stand-in decides (a stand-in
# is skipped, never run; a later file of the same name is not what a child running that name gets). Sets PY_SYSTEM
# (path) and PY_SYSTEM_VERSION when one qualifies, else PY_SYSTEM_NOTE says why.
python_find_system() {
  local name candidate version notes="" found
  PY_SYSTEM=""; PY_SYSTEM_VERSION=""; PY_SYSTEM_NOTE=""
  if [ "$PY_PREFER_PRIVATE" = "1" ]; then
    PY_SYSTEM_NOTE="BOTBOY_TEST_PREFER_PRIVATE_PYTHON=1 treats every system Python as unusable (a test switch)"
    return 1
  fi
  for name in python3 python3.13 python3.12 python3.11 python3.10; do
    found=""
    while IFS= read -r candidate; do
      [ -n "$candidate" ] || continue
      if python_is_apple_stand_in "$candidate"; then
        case "$notes" in *"$candidate is Apple's"*) ;; *) notes="${notes:+$notes; }$candidate is Apple's Python stand-in (not run)" ;; esac
        continue
      fi
      found="$candidate"
      break
    done <<EOF
$(py_candidates_on_path "$name")
EOF
    [ -n "$found" ] || continue
    if ! version="$(python_probe_version "$found")"; then
      notes="${notes:+$notes; }$found does not run"
      continue
    fi
    if version_at_least "$version" "$PY_MIN_VERSION"; then
      PY_SYSTEM="$found"
      PY_SYSTEM_VERSION="$version"
      return 0
    fi
    notes="${notes:+$notes; }$found is Python $version (BotBoy needs 3.10 or newer)"
  done
  PY_SYSTEM_NOTE="${notes:-no Python 3.10 or newer was found on this Mac}"
  return 1
}

# Rule 1 for uv. Sets UV_SYSTEM and UV_SYSTEM_VERSION when one qualifies, else UV_SYSTEM_NOTE says why.
uv_find_system() {
  local candidate out version
  UV_SYSTEM=""; UV_SYSTEM_VERSION=""; UV_SYSTEM_NOTE=""
  if [ "$PY_PREFER_PRIVATE" = "1" ]; then
    UV_SYSTEM_NOTE="BOTBOY_TEST_PREFER_PRIVATE_PYTHON=1 treats every system uv as unusable (a test switch)"
    return 1
  fi
  if ! candidate="$(py_first_on_path uv)"; then
    UV_SYSTEM_NOTE="no uv was found on this Mac"
    return 1
  fi
  out="$(UV_NO_CACHE=1 UV_NO_CONFIG=1 "$candidate" --version 2>/dev/null)" || out=""
  version="$(printf '%s' "$out" | awk 'NR == 1 { print $2 }')"
  if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
    UV_SYSTEM="$candidate"; UV_SYSTEM_NOTE="$candidate did not report a uv version"
    return 1
  fi
  version="${BASH_REMATCH[0]}"
  UV_SYSTEM="$candidate"; UV_SYSTEM_VERSION="$version"
  if ! version_at_least "$version" "$UV_MIN_VERSION"; then
    UV_SYSTEM_NOTE="$candidate is uv $version (BotBoy needs 0.3.0 or newer)"
    return 1
  fi
  if [ ! -x "$(dirname "$candidate")/uvx" ]; then
    UV_SYSTEM_NOTE="$candidate has no uvx beside it"
    return 1
  fi
  return 0
}

# ── installed private runtimes ───────────────────────────────────────────────

# Whether $1 is a complete BotBoy uv folder: the two wrappers and the real binaries, which report a version.
# Sets PR_FOUND_UV_VERSION.
python_runtime_uv_healthy() {
  local dir="$1" out
  PR_FOUND_UV_VERSION=""
  [ -x "$dir/uv" ] && [ -x "$dir/uvx" ] && [ -x "$dir/libexec/uv" ] && [ -x "$dir/libexec/uvx" ] || return 1
  out="$(UV_NO_CACHE=1 UV_NO_CONFIG=1 "$dir/libexec/uv" --version 2>/dev/null)" || return 1
  out="$(printf '%s' "$out" | awk 'NR == 1 { print $2 }')"
  [[ "$out" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  PR_FOUND_UV_VERSION="$out"
  return 0
}

# Whether $1 (a CPython bin folder) holds BotBoy's Python: it runs, reports a version, and carries BotBoy's
# EXTERNALLY-MANAGED text. Sets PR_FOUND_PY_VERSION.
python_runtime_python_healthy() {
  local bin="$1" version minor
  PR_FOUND_PY_VERSION=""
  [ -x "$bin/python3" ] || return 1
  version="$(python_probe_version "$bin/python3")" || return 1
  minor="${version%.*}"
  grep -qF "$PY_MANAGED_MARKER" "$bin/../lib/python$minor/EXTERNALLY-MANAGED" 2>/dev/null || return 1
  PR_FOUND_PY_VERSION="$version"
  return 0
}

# Where the pinned parts live. Needs a read pin and python_runtime_chip.
python_runtime_paths() {
  PR_UV_DIR="$PY_RUNTIME_ROOT/uv-$PR_UV_VERSION-$PR_CHIP"
  PR_PY_KEY="cpython-$PR_PY_VERSION-macos-$PR_TRIPLE-none"
  PR_PY_MINOR_KEY="cpython-$PR_PY_MINOR-macos-$PR_TRIPLE-none"
  # PATH names the MINOR link (an absolute link uv keeps on the newest patch), so a patch bump keeps tool envs working.
  PR_PY_BIN="$PY_RUNTIME_ROOT/python/$PR_PY_MINOR_KEY/bin"
}

# The newest installed uv folder for this chip that runs (any version), printed.
python_runtime_find_installed_uv() {
  local d best="" bestver=""
  for d in "$PY_RUNTIME_ROOT"/uv-*-"$PR_CHIP"; do
    [ -d "$d" ] || continue
    python_runtime_uv_healthy "$d" && python_runtime_uv_wrapped "$d" || continue
    if [ -z "$best" ] || ! version_at_least "$bestver" "$PR_FOUND_UV_VERSION"; then best="$d"; bestver="$PR_FOUND_UV_VERSION"; fi
  done
  [ -n "$best" ] && printf '%s' "$best"
  return 0
}

# ── phase 1: choose, never download ──────────────────────────────────────────

python_select_phase1() {
  local want_py=0 want_uv=0 older
  case "$PY_RUNTIME_MODE" in
    auto|system|private) ;;
    *) echo "ℹ️  BOTBOY_PYTHON_RUNTIME=$PY_RUNTIME_MODE is not auto, system or private; using auto" >> "$LOG_FILE"; PY_RUNTIME_MODE=auto ;;
  esac
  PY_SOURCE=system; UV_SOURCE=system; PY_REASON=""; UV_REASON=""; PY_NEEDS_RUNTIME=0; PY_NEEDS_DOWNLOAD=0; PY_BIN_DIR=""; PY_UV_DIR=""
  PY_PREFER_PRIVATE=0
  [ "$PY_RUNTIME_MODE" = "auto" ] && [ "${BOTBOY_TEST_PREFER_PRIVATE_PYTHON:-0}" = "1" ] && PY_PREFER_PRIVATE=1
  python_runtime_scrub_path
  python_runtime_chip
  case "$PY_RUNTIME_MODE" in
    system)
      # The behaviour before this file existed: whatever this Mac has; nothing of BotBoy's is used or downloaded.
      python_find_system || PY_SOURCE=none
      uv_find_system || UV_SOURCE=none
      return 0 ;;
    private)
      PY_REASON="BOTBOY_PYTHON_RUNTIME=private is set"; UV_REASON="$PY_REASON"
      want_py=1; want_uv=1 ;;
    *)
      python_find_system || { PY_REASON="$PY_SYSTEM_NOTE"; want_py=1; }
      uv_find_system || { UV_REASON="$UV_SYSTEM_NOTE"; want_uv=1; } ;;
  esac
  if [ "$want_py" = "0" ] && [ "$want_uv" = "0" ]; then return 0; fi
  # One unit (rule 3): the pinned uv and the pinned CPython must both be installed.
  if ! python_runtime_read_pin; then
    PY_NEEDS_RUNTIME=1
    PY_NEEDS_DOWNLOAD=1
    [ "$want_py" = "1" ] && PY_SOURCE=none
    [ "$want_uv" = "1" ] && UV_SOURCE=none
    return 0
  fi
  python_runtime_paths
  if python_runtime_uv_healthy "$PR_UV_DIR" && [ "$PR_FOUND_UV_VERSION" = "$PR_UV_VERSION" ]; then
    if python_runtime_uv_wrapped "$PR_UV_DIR"; then
      PY_UV_DIR="$PR_UV_DIR"
    else
      PY_NEEDS_RUNTIME=1   # wrappers of an older generation: phase 2 writes new ones, nothing is downloaded
    fi
  else
    PY_NEEDS_RUNTIME=1
    PY_NEEDS_DOWNLOAD=1
    older="$(python_runtime_find_installed_uv)"
    [ -z "$older" ] || PY_UV_DIR="$older"
  fi
  if python_runtime_python_healthy "$PR_PY_BIN"; then
    PY_BIN_DIR="$PR_PY_BIN"
    if [ "$PR_FOUND_PY_VERSION" != "$PR_PY_VERSION" ]; then PY_NEEDS_RUNTIME=1; PY_NEEDS_DOWNLOAD=1; fi
  else
    PY_NEEDS_RUNTIME=1
    PY_NEEDS_DOWNLOAD=1
  fi
  # uv runs only its managed CPython: a uv folder without it is not usable either.
  [ -n "$PY_BIN_DIR" ] || PY_UV_DIR=""
  if [ "$want_py" = "1" ]; then
    if [ -n "$PY_BIN_DIR" ]; then PY_SOURCE=private; else PY_SOURCE=none; fi
  fi
  if [ "$want_uv" = "1" ]; then
    if [ -n "$PY_UV_DIR" ]; then UV_SOURCE=private; else UV_SOURCE=none; fi
  fi
  return 0
}

# Put the private parts first on PATH (rule 3): Python's bin, then uv's folder, in front of the Node bin start.sh added.
python_runtime_adopt() {
  [ "$UV_SOURCE" = "private" ] && [ -n "$PY_UV_DIR" ] && PATH="$PY_UV_DIR:$PATH"
  [ "$PY_SOURCE" = "private" ] && [ -n "$PY_BIN_DIR" ] && PATH="$PY_BIN_DIR:$PATH"
  export PATH
  return 0
}

# ── phase 2: install the pinned runtime ──────────────────────────────────────

# One failure, in words: what happened and the next action. $1 kind, $2 detail. Python is optional: every line says
# that BotBoy starts without it.
python_runtime_fail() {
  local kind="$1" detail="${2:-}" what="" next=""
  case "$kind" in
    pin) what="BotBoy's Python pin (python-runtime.pin) cannot be used: $detail. BotBoy starts without Python."; next="Run ./start.sh --update, or clone botboy-app again." ;;
    cpu) what="BotBoy's Python has no build for this Mac's processor ($detail). BotBoy starts without Python."; next="Install Python 3.10 or newer from python.org and uv from docs.astral.sh/uv, then run ./start.sh again." ;;
    macos) what="BotBoy's Python needs macOS $PY_MIN_MACOS or newer, and this Mac runs macOS $detail. BotBoy starts without Python."; next="Update macOS in System Settings > General > Software Update, then run ./start.sh again." ;;
    home) what="BotBoy cannot place its Python: this Mac's home folder ($HOME) is not usable. BotBoy starts without Python."; next="Run ./start.sh from your own account." ;;
    disk) what="Not enough free disk space to set up BotBoy's Python: it needs about 1 GB free and this Mac has $detail. BotBoy starts without Python."; next="Free some space, then run ./start.sh again." ;;
    tool) what="$detail is missing from this Mac, so BotBoy cannot download or check its Python. BotBoy starts without Python."; next="Run ./start.sh --doctor and send the output to the owner." ;;
    offline) what="Could not reach github.com to download BotBoy's Python (curl exit $detail). BotBoy starts without Python; the next ./start.sh continues."; next="Check your internet connection, VPN or proxy." ;;
    slow) what="BotBoy's Python is still downloading (the link is slow, curl exit $detail). BotBoy starts without it and continues at the next start."; next="Nothing to do: the next ./start.sh resumes the download." ;;
    tls) what="Your network is replacing secure connections to github.com, so the download of BotBoy's Python was refused (curl exit $detail). BotBoy starts without Python."; next="Ask IT, or try another network (for example a phone hotspot), then run ./start.sh again." ;;
    interrupted) what="The download of BotBoy's Python was interrupted (curl exit $detail). BotBoy starts without Python; the next ./start.sh resumes it."; next="Run ./start.sh again while online." ;;
    http) what="github.com did not serve BotBoy's Python file (curl exit $detail: the answer was an error). BotBoy starts without Python."; next="Tell the owner: the pinned file may have been removed from GitHub." ;;
    size) what="A downloaded file of BotBoy's Python is not the size BotBoy expects ($detail). BotBoy deleted it and starts without Python."; next="Run ./start.sh again; if it repeats, tell the owner." ;;
    hash) what="BotBoy deleted a download of its Python: its checksum does not match the one BotBoy has on record ($detail). It was not unpacked or run. BotBoy starts without Python."; next="This can mean a damaged download or a network that alters files. Try another network and run ./start.sh again; if it repeats, tell the owner." ;;
    unpack) what="BotBoy could not unpack its uv ($detail). BotBoy starts without Python."; next="Run ./start.sh again; if it repeats, send ./start.sh --doctor to the owner." ;;
    install) what="BotBoy's uv could not install its CPython ($detail). BotBoy starts without Python."; next="Run ./start.sh again; if it repeats, send ./start.sh --doctor and the end of /tmp/ppt.log to the owner." ;;
    smoke) what="BotBoy's Python was installed but does not run here ($detail). BotBoy removed it and starts without Python."; next="Run ./start.sh again; if it repeats, send ./start.sh --doctor to the owner." ;;
    *) what="BotBoy could not set up its Python ($kind $detail). BotBoy starts without Python."; next="Run ./start.sh again." ;;
  esac
  python_runtime_say "⚠️  $what"
  python_runtime_say "    Next: $next"
}

# PR_SELF_PID: the PID of the shell that calls this (a background job's own, not its parent's: bash 3.2 has no BASHPID).
# Call it directly, never inside $(...): that would be a subshell of its own, one level down.
python_runtime_self_pid() {
  PR_SELF_PID="$(exec /bin/sh -c 'echo $PPID')"
}

# Take runtime/.python.lock (Node's .lock is never touched); 75 when another start holds it.
python_runtime_lock() {
  local lock="$PY_RUNTIME_ROOT/.python.lock" holder self
  mkdir -p "$PY_RUNTIME_ROOT" 2>/dev/null || return 1
  python_runtime_self_pid
  self="$PR_SELF_PID"
  if mkdir "$lock" 2>/dev/null; then echo "$self" > "$lock/pid"; return 0; fi
  holder="$(cat "$lock/pid" 2>/dev/null)"
  PR_LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$lock" 2>/dev/null || echo 0) ))
  if { [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; } || [ "$PR_LOCK_AGE" -ge 900 ]; then
    rm -rf "$lock"
    if mkdir "$lock" 2>/dev/null; then echo "$self" > "$lock/pid"; return 0; fi
  fi
  return 75
}
python_runtime_unlock() {
  rm -rf "$PY_RUNTIME_ROOT/.python.lock"
}

# Seconds left until the deadline (at least 1).
python_runtime_time_left() {
  local left=$(( PY_DEADLINE - $(date +%s) ))
  [ "$left" -ge 1 ] || left=1
  printf '%s' "$left"
}

# Download $1 to $2 (a .part file, resumed), expecting $3 bytes. 0, or 1 with PR_FAIL and PR_CURL_RC set.
python_runtime_download() {
  local url="$1" dest="$2" want="$3" attempt=0 size before rc left
  PR_FAIL=""; PR_CURL_RC=""
  [ -x "$PY_CURL" ] || { PR_FAIL=tool; PR_CURL_RC="curl"; return 1; }
  while [ "$attempt" -lt 3 ]; do
    attempt=$((attempt + 1))
    size="$(python_runtime_file_size "$dest")"
    [ "$size" -eq "$want" ] && return 0
    [ "$size" -gt "$want" ] && { rm -f "$dest"; size=0; }
    if [ "$(date +%s)" -ge "$PY_DEADLINE" ]; then PR_FAIL=slow; PR_CURL_RC=28; return 1; fi
    before="$size"
    left="$(python_runtime_time_left)"
    # --max-time bounds one request and --retry-max-time stops curl's own retries at the same deadline, so a slow link
    # ends this call by the deadline (exit 28) instead of three request times later.
    "$PY_CURL" -fL -sS --retry 2 --retry-delay 2 --retry-max-time "$left" --connect-timeout 20 --max-time "$left" -C - -o "$dest" "$url"
    rc=$?
    PR_CURL_RC="$rc"
    case "$rc" in
      0) ;;
      6|7) PR_FAIL=offline; return 1 ;;
      28)
        # A time-out after bytes arrived is a slow link (the deadline ran out), not a missing network.
        if [ "$(python_runtime_file_size "$dest")" -gt "$before" ]; then PR_FAIL=slow; else PR_FAIL=offline; fi
        return 1 ;;
      35|51|53|54|58|59|60|77|80|83|90|91) PR_FAIL=tls; return 1 ;;
      22) PR_FAIL=http; return 1 ;;
      33) rm -f "$dest" ;;
      *) ;;
    esac
  done
  size="$(python_runtime_file_size "$dest")"
  [ "$size" -eq "$want" ] && return 0
  if [ "$size" -gt "$want" ]; then
    rm -f "$dest"
    PR_FAIL=size; PR_CURL_RC="got $size bytes, expected $want"
  else
    PR_FAIL=interrupted
  fi
  return 1
}

# Fetch $1 (URL) into .download/$2, check its SHA-256 ($3) and size ($4) BEFORE anything else. Prints the verified
# file's path. A mismatch deletes it (one fresh download first when this attempt resumed a partial file).
python_runtime_fetch_verified() {
  local url="$1" name="$2" sha="$3" want="$4" part verified got resumed=0 fresh=0
  part="$PY_RUNTIME_ROOT/.download/$name.part"
  verified="$PY_RUNTIME_ROOT/.download/$name"
  # A complete file left by a start that stopped before using it is checked again, not fetched again.
  [ -f "$verified" ] && [ ! -f "$part" ] && mv "$verified" "$part"
  while :; do
    [ "$(python_runtime_file_size "$part")" -gt 0 ] && [ "$(python_runtime_file_size "$part")" -lt "$want" ] && resumed=1
    rm -f "$verified"
    if ! python_runtime_download "$url" "$part" "$want"; then
      python_runtime_fail "$PR_FAIL" "$PR_CURL_RC"
      return 1
    fi
    got="$("$PY_SHASUM" -a 256 "$part" 2>/dev/null | awk '{ print $1 }')"
    if [ -z "$got" ]; then rm -f "$part"; python_runtime_fail tool "shasum"; return 1; fi
    if [ "$got" = "$sha" ]; then break; fi
    rm -f "$part"
    if [ "$resumed" = "1" ] && [ "$fresh" = "0" ]; then fresh=1; resumed=0; continue; fi
    python_runtime_fail hash "$name: expected ${sha:0:12}…, got ${got:0:12}…"
    return 1
  done
  mv "$part" "$verified" || { python_runtime_fail unpack "cannot rename $name"; return 1; }
  PR_VERIFIED="$verified"
  return 0
}

# Percent-encode a path for a file:// URL (unreserved characters and / stay).
python_runtime_url_path() {
  local LC_ALL=C text="$1" out="" i ch
  for (( i = 0; i < ${#text}; i++ )); do
    ch="${text:i:1}"
    case "$ch" in
      [A-Za-z0-9/._~-]) out="$out$ch" ;;
      *) out="$out$(printf '%%%02X' "'$ch")" ;;
    esac
  done
  printf '%s' "$out"
}

# A value as one /bin/sh word, in single quotes.
python_runtime_sh_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# The uv or uvx wrapper: BotBoy's settings as defaults (a value the environment already has wins), then the real
# binary. Lives in the read-only runtime; it never writes there. $1 = libexec binary, $2 = real runtime/python.
# PY_WRAPPER_MARK names this generation of the text: a folder whose wrappers carry another one gets new wrappers
# (no download) at the next start.
PY_WRAPPER_MARK="# botboy-uv-wrapper 1"
python_runtime_wrapper_text() {
  local binary="$1" python_root="$2"
  cat <<EOF
#!/bin/sh
$PY_WRAPPER_MARK
# BotBoy's $(basename "$binary") (scripts/python-runtime.sh): BotBoy's own CPython, read-only, and everything it writes in
# ~/.botboy-python. A value already in the environment wins. Remove: rm -rf this folder and ~/.botboy-python.
botboy_python_root=$(python_runtime_sh_quote "$python_root")
if [ -z "\${UV_NO_MANAGED_PYTHON:-}" ] && [ -z "\${UV_PYTHON_PREFERENCE:-}" ]; then UV_MANAGED_PYTHON="\${UV_MANAGED_PYTHON:-1}"; export UV_MANAGED_PYTHON; fi
UV_PYTHON_DOWNLOADS="\${UV_PYTHON_DOWNLOADS:-manual}"
UV_PYTHON_INSTALL_DIR="\${UV_PYTHON_INSTALL_DIR:-\$botboy_python_root}"
UV_CACHE_DIR="\${UV_CACHE_DIR:-\$HOME/.botboy-python/cache}"
UV_TOOL_DIR="\${UV_TOOL_DIR:-\$HOME/.botboy-python/tools}"
UV_TOOL_BIN_DIR="\${UV_TOOL_BIN_DIR:-\$HOME/.botboy-python/bin}"
UV_PYTHON_BIN_DIR="\${UV_PYTHON_BIN_DIR:-\$HOME/.botboy-python/bin}"
export UV_PYTHON_DOWNLOADS UV_PYTHON_INSTALL_DIR UV_CACHE_DIR UV_TOOL_DIR UV_TOOL_BIN_DIR UV_PYTHON_BIN_DIR
exec $(python_runtime_sh_quote "$binary") "\$@"
EOF
}

# Write the two wrappers into folder $1, for a uv folder whose real, final path is $2 (they name its libexec binaries
# and the real runtime/python beside it).
python_runtime_write_wrappers() {
  local into="$1" final="$2" name
  for name in uv uvx; do
    python_runtime_wrapper_text "$final/libexec/$name" "$(dirname "$final")/python" > "$into/$name.new" || return 1
    chmod 0755 "$into/$name.new" && mv "$into/$name.new" "$into/$name" || return 1
  done
  return 0
}

# Whether the wrappers in uv folder $1 are this generation's and name this folder's own binaries.
python_runtime_uv_wrapped() {
  local dir="$1" real name
  real="$(py_realdir "$dir")" || return 1
  for name in uv uvx; do
    grep -qxF "$PY_WRAPPER_MARK" "$dir/$name" 2>/dev/null || return 1
    grep -qF "exec $(python_runtime_sh_quote "$real/libexec/$name") " "$dir/$name" 2>/dev/null || return 1
  done
  return 0
}

# Unpack the verified uv tarball $1 into a runtime folder, wrap it, smoke it, and move it to $2 in one rename.
python_runtime_unpack_uv() {
  local tarball="$1" final="$2" tmp top staged out real_root python_root
  python_runtime_self_pid
  tmp="$PY_RUNTIME_ROOT/.py-extract-$PR_SELF_PID"
  top="$tmp/uv-$PR_TRIPLE-apple-darwin"
  staged="$tmp/uv-$PR_UV_VERSION-$PR_CHIP"
  rm -rf "$tmp"
  mkdir -p "$tmp" || { python_runtime_fail unpack "cannot create $tmp"; return 1; }
  if ! "$PY_TAR" -xzf "$tarball" -C "$tmp" >> "$LOG_FILE" 2>&1; then rm -rf "$tmp"; python_runtime_fail unpack "tar could not read the file"; return 1; fi
  if [ ! -f "$top/uv" ] || [ ! -f "$top/uvx" ]; then rm -rf "$tmp"; python_runtime_fail unpack "the file does not hold uv-$PR_TRIPLE-apple-darwin/uv and uvx"; return 1; fi
  mkdir -p "$staged/libexec" && mv "$top/uv" "$top/uvx" "$staged/libexec/" || { rm -rf "$tmp"; python_runtime_fail unpack "cannot lay out the folder"; return 1; }
  chmod 0755 "$staged/libexec/uv" "$staged/libexec/uvx"
  # The smoke, before the rename: both binaries run and are the pinned version.
  out="$(env -i HOME="$HOME" PATH=/bin:/usr/sbin:/sbin UV_NO_CONFIG=1 UV_NO_CACHE=1 "$staged/libexec/uv" --version 2>>"$LOG_FILE" | awk 'NR == 1 { print $2 }')"
  if [ "$out" != "$PR_UV_VERSION" ]; then rm -rf "$tmp"; python_runtime_fail smoke "its uv said \"${out:-nothing}\" instead of $PR_UV_VERSION"; return 1; fi
  out="$(env -i HOME="$HOME" PATH=/bin:/usr/sbin:/sbin UV_NO_CONFIG=1 UV_NO_CACHE=1 "$staged/libexec/uvx" --version 2>>"$LOG_FILE" | awk 'NR == 1 { print $2 }')"
  if [ "$out" != "$PR_UV_VERSION" ]; then rm -rf "$tmp"; python_runtime_fail smoke "its uvx said \"${out:-nothing}\" instead of $PR_UV_VERSION"; return 1; fi
  # The helpers' safeguard: curl and tar set no download flag, but a flagged file is never run.
  if "$PY_XATTR" -p com.apple.quarantine "$staged/libexec/uv" >/dev/null 2>&1; then
    "$PY_XATTR" -r -d com.apple.quarantine "$staged" >/dev/null 2>&1 || true
  fi
  real_root="$(py_realdir "$PY_RUNTIME_ROOT")"
  python_runtime_write_wrappers "$staged" "$real_root/uv-$PR_UV_VERSION-$PR_CHIP" || { rm -rf "$tmp"; python_runtime_fail unpack "cannot write the uv wrappers"; return 1; }
  printf 'uv=%s\narch=%s\nsource=%s\ninstalled=%s\n' "$PR_UV_VERSION" "$PR_CHIP" "$PY_DIST/astral-sh/uv/releases/download/$PR_UV_VERSION" "$(date '+%Y-%m-%dT%H:%M:%S')" > "$staged/.botboy-runtime" 2>/dev/null || true
  if [ -e "$final" ]; then mv "$final" "$PY_RUNTIME_ROOT/.py-corrupt-$PR_SELF_PID" 2>/dev/null || rm -rf "$final"; fi
  if ! mv "$staged" "$final"; then rm -rf "$tmp"; python_runtime_fail unpack "could not move it into place"; return 1; fi
  rm -rf "$tmp" "$PY_RUNTIME_ROOT"/.py-corrupt-*
  return 0
}

# BotBoy's uv installs the verified CPython file $1 from a file:// mirror, then BotBoy's EXTERNALLY-MANAGED text goes
# in and the smoke runs. $2 = the uv folder.
python_runtime_install_python() {
  local file="$1" uv_dir="$2" tmp mirror name real_root url out key_dir
  real_root="$(py_realdir "$PY_RUNTIME_ROOT")"
  key_dir="$real_root/python/$PR_PY_KEY"
  python_runtime_self_pid
  tmp="$PY_RUNTIME_ROOT/.py-extract-$PR_SELF_PID"
  mirror="$tmp/mirror"
  # The literal '+' (uv asks for %2B and decodes it).
  name="cpython-$PR_PY_VERSION+$PR_PY_BUILD-$PR_TRIPLE-apple-darwin-install_only_stripped.tar.gz"
  rm -rf "$tmp"
  mkdir -p "$mirror/$PR_PY_BUILD" "$real_root/python" || { python_runtime_fail install "cannot create the mirror folder"; return 1; }
  mv "$file" "$mirror/$PR_PY_BUILD/$name" || { rm -rf "$tmp"; python_runtime_fail install "cannot move the download"; return 1; }
  # A copy that failed its smoke earlier is replaced, not kept ("already installed").
  [ -e "$key_dir" ] && rm -rf "$key_dir"
  url="file://$(python_runtime_url_path "$(py_realdir "$mirror")")"
  # Rule 5: no /usr/bin on PATH, no config, no cache (the user's ~/.cache/uv is never created or locked).
  if ! env -i HOME="$HOME" PATH=/bin:/usr/sbin:/sbin UV_NO_CONFIG=1 UV_NO_CACHE=1 \
    UV_PYTHON_INSTALL_DIR="$real_root/python" UV_PYTHON_INSTALL_MIRROR="$url" \
    "$uv_dir/libexec/uv" python install "$PR_PY_KEY" --no-bin >> "$LOG_FILE" 2>&1; then
    rm -rf "$tmp"
    python_runtime_fail install "uv python install $PR_PY_KEY failed; see /tmp/ppt.log"
    return 1
  fi
  rm -rf "$tmp"
  # BotBoy's own error text for a plain pip install (design review finding 8): it names the next action.
  if [ -d "$key_dir/lib/python$PR_PY_MINOR" ]; then
    printf '%s\n' "$PY_MANAGED_TEXT" > "$key_dir/lib/python$PR_PY_MINOR/EXTERNALLY-MANAGED" 2>/dev/null || true
  fi
  if [ -x "$key_dir/bin/python3" ] && "$PY_XATTR" -p com.apple.quarantine "$key_dir/bin/python3" >/dev/null 2>&1; then
    "$PY_XATTR" -r -d com.apple.quarantine "$key_dir" >/dev/null 2>&1 || true
  fi
  # The smoke, through the minor link PATH uses: the pinned version, the modules BotBoy's users need, the marker text.
  out="$("$PR_PY_BIN/python3" -I -c 'import ssl, sqlite3, venv, ensurepip, ctypes, zlib, sys; print("%d.%d.%d" % sys.version_info[:3])' 2>>"$LOG_FILE")"
  out="${out%%$'\n'*}"
  if [ "$out" != "$PR_PY_VERSION" ] || ! grep -qF "$PY_MANAGED_MARKER" "$key_dir/lib/python$PR_PY_MINOR/EXTERNALLY-MANAGED" 2>/dev/null; then
    rm -rf "$key_dir"
    python_runtime_fail smoke "its python3 said \"${out:-nothing}\" instead of $PR_PY_VERSION"
    return 1
  fi
  return 0
}

# Remove every other uv-<version>-<chip> folder, unless a process runs from it.
python_runtime_remove_other_uv() {
  local keep="$1" other
  for other in "$PY_RUNTIME_ROOT"/uv-[0-9]*; do
    [ -d "$other" ] && [ ! -L "$other" ] || continue
    [ "$other" = "$keep" ] && continue
    if pgrep -f "$other/" >/dev/null 2>&1; then
      echo "Kept $other: a process still runs from it" >> "$LOG_FILE"
      continue
    fi
    rm -rf "$other"
    echo "Removed the older uv $other" >> "$LOG_FILE"
  done
}

# The work, under the lock. 0 when both parts are installed, 1 on failure (message given).
python_runtime_install_locked() {
  local uv_sha uv_bytes py_sha py_bytes uv_name py_name uv_file="" py_file=""
  python_runtime_paths
  if [ "$PR_CHIP" = "arm64" ]; then
    uv_sha="$PR_UV_SHA_ARM64"; uv_bytes="$PR_UV_BYTES_ARM64"; py_sha="$PR_PY_SHA_ARM64"; py_bytes="$PR_PY_BYTES_ARM64"
  else
    uv_sha="$PR_UV_SHA_X64"; uv_bytes="$PR_UV_BYTES_X64"; py_sha="$PR_PY_SHA_X64"; py_bytes="$PR_PY_BYTES_X64"
  fi
  rm -rf "$PY_RUNTIME_ROOT"/.py-extract-* "$PY_RUNTIME_ROOT"/.py-corrupt-*
  mkdir -p "$PY_RUNTIME_ROOT/.download" || { python_runtime_fail home; return 1; }
  uv_name="uv-$PR_TRIPLE-apple-darwin.tar.gz"
  py_name="cpython-$PR_PY_VERSION+$PR_PY_BUILD-$PR_TRIPLE-apple-darwin-install_only_stripped.tar.gz"
  local need_uv=1 need_py=1
  if python_runtime_uv_healthy "$PR_UV_DIR" && [ "$PR_FOUND_UV_VERSION" = "$PR_UV_VERSION" ]; then
    if python_runtime_uv_wrapped "$PR_UV_DIR"; then
      need_uv=0
    elif python_runtime_write_wrappers "$PR_UV_DIR" "$(py_realdir "$PR_UV_DIR")"; then
      # Wrappers of an older generation: new ones, no download.
      echo "Wrote new uv wrappers in $PR_UV_DIR" >> "$LOG_FILE"
      need_uv=0
    fi
  fi
  if python_runtime_python_healthy "$PR_PY_BIN" && [ "$PR_FOUND_PY_VERSION" = "$PR_PY_VERSION" ]; then need_py=0; fi
  if [ "$need_uv" = "0" ] && [ "$need_py" = "0" ]; then return 0; fi
  # Both files are fetched and checked before anything is unpacked; the second never starts after a network failure.
  if [ "$need_uv" = "1" ]; then
    python_runtime_fetch_verified "$PY_DIST/astral-sh/uv/releases/download/$PR_UV_VERSION/$uv_name" "$uv_name" "$uv_sha" "$uv_bytes" || return 1
    uv_file="$PR_VERIFIED"
  fi
  if [ "$need_py" = "1" ]; then
    python_runtime_fetch_verified "$PY_DIST/astral-sh/python-build-standalone/releases/download/$PR_PY_BUILD/cpython-$PR_PY_VERSION%2B$PR_PY_BUILD-$PR_TRIPLE-apple-darwin-install_only_stripped.tar.gz" "$py_name" "$py_sha" "$py_bytes" || return 1
    py_file="$PR_VERIFIED"
  fi
  if [ "$need_uv" = "1" ]; then
    if ! python_runtime_unpack_uv "$uv_file" "$PR_UV_DIR"; then rm -f "$uv_file"; return 1; fi
    rm -f "$uv_file"
  fi
  if [ "$need_py" = "1" ]; then
    if ! python_runtime_install_python "$py_file" "$PR_UV_DIR"; then rm -f "$py_file"; return 1; fi
  fi
  python_runtime_remove_other_uv "$PR_UV_DIR"
  python_runtime_say "✅ BotBoy's Python is ready: uv $PR_UV_VERSION and CPython $PR_PY_VERSION (checksums verified)"
  return 0
}

# Preconditions, the lock, and the work. 0 installed, 1 failed (message given), 75 another start is doing it.
python_runtime_install() {
  local macos free_kb rc
  case "$PY_RUNTIME_ROOT" in
    /?*/.personal-productivity-tracker/runtime) ;;
    *) python_runtime_fail home; return 1 ;;
  esac
  python_runtime_chip
  if ! python_runtime_read_pin; then python_runtime_fail pin "$PR_ERROR"; return 1; fi
  if { [ "$PR_CHIP" = "arm64" ] && [ -z "$PR_UV_SHA_ARM64" ]; } || { [ "$PR_CHIP" = "x64" ] && [ -z "$PR_UV_SHA_X64" ]; }; then
    if [ "$PR_CHIP" = "arm64" ]; then python_runtime_fail cpu "Apple silicon"; else python_runtime_fail cpu "Intel"; fi
    return 1
  fi
  macos="$("$PY_SW_VERS" -productVersion 2>/dev/null)"
  if [[ "$macos" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] && ! version_at_least "$macos" "$PY_MIN_MACOS"; then
    python_runtime_fail macos "$macos"
    return 1
  fi
  free_kb="$("$PY_DF" -k "$HOME" 2>/dev/null | awk 'NR == 2 { print $4 }')"
  if [[ "$free_kb" =~ ^[0-9]+$ ]] && [ "$free_kb" -lt "$PY_MIN_FREE_KB" ]; then
    python_runtime_fail disk "$(awk -v k="$free_kb" 'BEGIN { printf "%.1f GB", k / 1048576 }')"
    return 1
  fi
  [ "$PY_DEADLINE" -gt 0 ] || PY_DEADLINE=$(( $(date +%s) + PY_BUDGET_SECONDS ))
  python_runtime_lock
  rc=$?
  if [ "$rc" -ne 0 ]; then
    [ "$rc" -eq 75 ] && return 75
    python_runtime_fail home
    return 1
  fi
  python_runtime_install_locked
  rc=$?
  python_runtime_unlock
  return "$rc"
}

# The background job (rule 4). Its output goes to the log; its owner-facing lines also go to the notes file the join prints.
python_runtime_install_job() {
  PY_IN_JOB=1
  trap '' HUP
  exec </dev/null
  python_runtime_install
  local rc=$?
  [ "$rc" -eq 75 ] && python_runtime_say "ℹ️  Another ./start.sh is already setting up BotBoy's Python (for ${PR_LOCK_AGE}s); this start goes on without waiting for it."
  return "$rc"
}

# Rule 4: start the download in the background. Only on a real start that needs the runtime.
python_runtime_fetch_begin() {
  [ "${PY_NEEDS_RUNTIME:-0}" = "1" ] || return 0
  [ "${NODE_DOWNLOAD_OK:-0}" = "1" ] || return 0
  [ "$PY_RUNTIME_MODE" != "system" ] || return 0
  [ -z "$PY_JOB_PID" ] || return 0
  python_runtime_read_pin >/dev/null 2>&1 || true
  PY_DEADLINE=$(( $(date +%s) + PY_BUDGET_SECONDS ))
  PY_JOB_NOTES="$(mktemp -t botboy-python-notes 2>/dev/null)" || PY_JOB_NOTES=""
  if [ "${PY_NEEDS_DOWNLOAD:-1}" = "1" ]; then
    python_runtime_say "ℹ️  Setting up BotBoy's own Python in the background (uv ${PR_UV_VERSION:-?} and CPython ${PR_PY_VERSION:-?}, about 40 MB from github.com, checksum verified, into $(python_runtime_tilde "$PY_RUNTIME_ROOT")): ${PY_REASON:-$UV_REASON}."
  else
    echo "Refreshing BotBoy's own Python (nothing to download)" >> "$LOG_FILE"
  fi
  ( python_runtime_install_job ) >> "$LOG_FILE" 2>&1 &
  PY_JOB_PID=$!
  return 0
}

# Stop the background job (the EXIT trap and a join at its limit): its curl or uv first, then the job; its lock goes
# with it; the .part file stays for the next start. Safe to call when there is no job.
python_runtime_fetch_abort() {
  local pid="$PY_JOB_PID" holder
  [ -n "$pid" ] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    pkill -TERM -P "$pid" >/dev/null 2>&1
    kill -TERM "$pid" >/dev/null 2>&1
    wait "$pid" 2>/dev/null
    holder="$(cat "$PY_RUNTIME_ROOT/.python.lock/pid" 2>/dev/null)"
    [ "$holder" = "$pid" ] && python_runtime_unlock
  fi
  PY_JOB_PID=""
  [ -z "$PY_JOB_NOTES" ] || rm -f "$PY_JOB_NOTES"
  PY_JOB_NOTES=""
  return 0
}

# Rule 4: wait for the job, immediately before the server starts. PY_JOIN_LONG=1 (this start ran npm or a build)
# waits until the deadline, otherwise at most PY_RESTART_JOIN_SECONDS. Then phase 1 again, and PATH.
python_runtime_fetch_join() {
  local limit now
  if [ -n "$PY_JOB_PID" ]; then
    now=$(date +%s)
    if [ "${PY_JOIN_LONG:-0}" = "1" ]; then
      # The job's own downloads end by the deadline (curl --max-time); the grace lets it say why, or unpack and install
      # a file that arrived just in time.
      limit=$(( PY_DEADLINE + PY_JOIN_GRACE_SECONDS ))
    else
      limit=$(( now + PY_RESTART_JOIN_SECONDS ))
      [ "$limit" -le "$PY_DEADLINE" ] || limit="$PY_DEADLINE"
    fi
    # A job still running gets one line with the bound first, so a long wait after the build never reads as a hang.
    if kill -0 "$PY_JOB_PID" 2>/dev/null && [ "$now" -lt "$limit" ]; then
      python_runtime_say "ℹ️  Waiting for BotBoy's Python download (at most $(( limit - now )) s)…"
    fi
    while kill -0 "$PY_JOB_PID" 2>/dev/null && [ "$(date +%s)" -lt "$limit" ]; do
      sleep 0.2
    done
    if kill -0 "$PY_JOB_PID" 2>/dev/null; then
      python_runtime_fetch_abort
      python_runtime_say "ℹ️  BotBoy's Python is still downloading; BotBoy starts without it and continues at the next start."
    else
      wait "$PY_JOB_PID" 2>/dev/null
      [ -z "$PY_JOB_NOTES" ] || cat "$PY_JOB_NOTES"
      PY_JOB_PID=""
      [ -z "$PY_JOB_NOTES" ] || rm -f "$PY_JOB_NOTES"
      PY_JOB_NOTES=""
    fi
    python_select_phase1
  fi
  python_runtime_adopt
}

# A command with a time limit of $1 seconds (rule 7). Its status, or 124 when it was stopped.
python_runtime_bounded() {
  local secs="$1" pid ticks=0 max
  shift
  max=$(( secs * 5 ))
  "$@" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$ticks" -ge "$max" ]; then
      pkill -TERM -P "$pid" >/dev/null 2>&1
      kill -TERM "$pid" >/dev/null 2>&1
      sleep 0.2
      kill -KILL "$pid" >/dev/null 2>&1
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 0.2
    ticks=$((ticks + 1))
  done
  wait "$pid"
}

# Whether any process runs from BotBoy's uv, its CPython or ~/.botboy-python (rule 7): by command line, under both the
# spelling start.sh uses and the real path ($1). A process started through the minor link shows python/ in its argv.
python_runtime_busy() {
  local real_root="$1" root
  for root in "$PY_RUNTIME_ROOT" ${real_root:+"$real_root"}; do
    pgrep -f "$root/uv-" >/dev/null 2>&1 && return 0
    pgrep -f "$root/python/" >/dev/null 2>&1 && return 0
  done
  pgrep -f "$PY_USER_BASE/" >/dev/null 2>&1 && return 0
  return 1
}

# Rule 7. Called right before the server is spawned, after the last safe_takeover. Never fails a start. At every start,
# older uv folders that a server kept alive at the last swap are retired once nothing runs from them; the rest is weekly.
python_runtime_maintenance() {
  local stamp="$PY_USER_BASE/.maintenance" cache="$PY_USER_BASE/cache" real_root uv size outcome="" d key
  python_runtime_chip
  if python_runtime_read_pin; then
    python_runtime_paths
    if [ -d "$PR_UV_DIR" ] && python_runtime_uv_healthy "$PR_UV_DIR"; then python_runtime_remove_other_uv "$PR_UV_DIR"; fi
  fi
  [ -d "$PY_USER_BASE" ] || return 0
  if [ -f "$stamp" ] && [ -n "$(find "$stamp" -mtime -7 2>/dev/null)" ]; then return 0; fi
  real_root="$(py_realdir "$PY_RUNTIME_ROOT")"
  if python_runtime_busy "$real_root"; then
    printf '%s skipped: a process runs from BotBoy'"'"'s Python\n' "$(date +%s)" > "$stamp" 2>/dev/null
    echo "BotBoy's Python upkeep skipped: a process runs from it" >> "$LOG_FILE"
    return 0
  fi
  python_runtime_chip
  uv=""
  if python_runtime_read_pin; then
    python_runtime_paths
    python_runtime_uv_healthy "$PR_UV_DIR" && uv="$PR_UV_DIR/libexec/uv"
  fi
  if [ -z "$uv" ]; then
    printf '%s skipped: BotBoy'"'"'s uv is not installed\n' "$(date +%s)" > "$stamp" 2>/dev/null
    return 0
  fi
  if [ -d "$cache" ]; then
    size="$(python_runtime_bounded 20 du -sk "$cache" 2>/dev/null | awk 'NR == 1 { print $1 }')"
    if ! [[ "$size" =~ ^[0-9]+$ ]]; then
      outcome="cache size unknown (du did not finish in 20 s)"
    elif [ "$size" -gt "$PY_PRUNE_KB" ]; then
      if python_runtime_bounded 60 env UV_CACHE_DIR="$cache" UV_NO_CONFIG=1 "$uv" cache prune >> "$LOG_FILE" 2>&1; then
        outcome="pruned the cache (${size} KB)"
      else
        outcome="cache prune did not finish in 60 s (${size} KB)"
      fi
      size="$(python_runtime_bounded 20 du -sk "$cache" 2>/dev/null | awk 'NR == 1 { print $1 }')"
      if [[ "$size" =~ ^[0-9]+$ ]] && [ "$size" -gt "$PY_CLEAN_KB" ]; then
        python_runtime_bounded 60 env UV_CACHE_DIR="$cache" UV_NO_CONFIG=1 "$uv" cache clean >> "$LOG_FILE" 2>&1 && outcome="$outcome; cleaned the cache (${size} KB)"
      fi
    else
      outcome="cache ${size} KB, nothing to prune"
    fi
  else
    outcome="no cache yet"
  fi
  # Older patches of the pinned minor (tool environments use the minor link, which uv keeps on the newest patch).
  for d in "$real_root/python"/cpython-"$PR_PY_MINOR".*-macos-"$PR_TRIPLE"-none; do
    [ -d "$d" ] && [ ! -L "$d" ] || continue
    key="$(basename "$d")"
    [ "$key" = "$PR_PY_KEY" ] && continue
    if python_runtime_bounded 60 env -i HOME="$HOME" PATH=/bin:/usr/sbin:/sbin UV_NO_CONFIG=1 UV_NO_CACHE=1 UV_PYTHON_INSTALL_DIR="$real_root/python" "$uv" python uninstall "$key" >> "$LOG_FILE" 2>&1; then
      outcome="$outcome; removed the older $key"
    fi
  done
  printf '%s %s\n' "$(date +%s)" "$outcome" > "$stamp" 2>/dev/null
  echo "BotBoy's Python upkeep: $outcome" >> "$LOG_FILE"
  return 0
}

# Rule 9: an --update that will not start BotBoy brings a changed pin, for a Mac that already has BotBoy's Python.
python_runtime_update_prefetch() {
  local d have=0
  [ "$PY_RUNTIME_MODE" != "system" ] || return 0
  for d in "$PY_RUNTIME_ROOT"/uv-* "$PY_RUNTIME_ROOT/python"; do [ -e "$d" ] && have=1; done
  [ "$have" = "1" ] || return 0
  python_select_phase1
  [ "$PY_NEEDS_RUNTIME" = "1" ] || return 0
  PY_DEADLINE=$(( $(date +%s) + PY_BUDGET_SECONDS ))
  if python_runtime_install; then
    python_runtime_say "✅ BotBoy's Python is ready for the new release"
  else
    python_runtime_say "ℹ️  BotBoy's new Python could not be fetched now; the next ./start.sh tries again."
  fi
  return 0
}

# ── the doctor's rows ────────────────────────────────────────────────────────

# Read-only: phase 1 (which runs only the version of each candidate), the pin, and the size of ~/.botboy-python.
doctor_python_rows() {
  local shown pinned state files size stamp
  python_select_phase1
  shown="$(python_runtime_tilde "$PY_RUNTIME_ROOT")"
  case "$PY_SOURCE" in
    private) echo "python source: private $(python_probe_version "$PY_BIN_DIR/python3" || echo '?') because $PY_REASON ($PY_BIN_DIR/python3)" ;;
    none)
      if [ "$PY_RUNTIME_MODE" = "system" ]; then echo "python source: none ($PY_SYSTEM_NOTE; BOTBOY_PYTHON_RUNTIME=system keeps BotBoy's own Python off)"
      else echo "python source: none ($PY_REASON); ./start.sh sets up BotBoy's own Python in the background"; fi ;;
    *) echo "python source: system $PY_SYSTEM_VERSION at $PY_SYSTEM (BotBoy's own Python is not needed for it)" ;;
  esac
  case "$UV_SOURCE" in
    private) python_runtime_uv_healthy "$PY_UV_DIR"; echo "uv source: private $PR_FOUND_UV_VERSION because $UV_REASON ($PY_UV_DIR/uv)" ;;
    none)
      if [ "$PY_RUNTIME_MODE" = "system" ]; then echo "uv source: none (${UV_SYSTEM_NOTE:-no uv}; BOTBOY_PYTHON_RUNTIME=system keeps BotBoy's own uv off)"
      else echo "uv source: none ($UV_REASON); ./start.sh sets up BotBoy's own uv in the background"; fi ;;
    *) echo "uv source: system $UV_SYSTEM_VERSION at $UV_SYSTEM (BotBoy's own uv is not needed for it)" ;;
  esac
  if ! python_runtime_read_pin; then
    echo "python runtime: the pin cannot be read ($PR_ERROR); folder $shown. Run ./start.sh --update"
  else
    python_runtime_chip
    python_runtime_paths
    pinned="uv $PR_UV_VERSION + CPython $PR_PY_VERSION (build $PR_PY_BUILD, supported until $PR_PY_EOL), $PR_CHIP"
    if python_runtime_uv_healthy "$PR_UV_DIR" && [ "$PR_FOUND_UV_VERSION" = "$PR_UV_VERSION" ] && python_runtime_uv_wrapped "$PR_UV_DIR" && python_runtime_python_healthy "$PR_PY_BIN" && [ "$PR_FOUND_PY_VERSION" = "$PR_PY_VERSION" ]; then
      if [ "$PY_SOURCE" = "private" ] || [ "$UV_SOURCE" = "private" ]; then state="installed in $shown (uv-$PR_UV_VERSION-$PR_CHIP, python/) and in use; no download needed"
      else state="installed in $shown but not in use: this Mac's own Python and uv work (rm -rf $shown/uv-* $shown/python removes it)"; fi
    elif [ "$PY_NEEDS_RUNTIME" = "1" ]; then
      state="not installed; the next ./start.sh downloads it from github.com in the background (about 40 MB, checksums verified, about 1 GB free needed)"
    else
      state="not installed, and not needed: this Mac's own Python and uv work"
    fi
    echo "python runtime: pinned $pinned; $state"
  fi
  files="$(python_runtime_tilde "$PY_USER_BASE")"
  if [ -d "$PY_USER_BASE" ]; then
    size="$(python_runtime_bounded 20 du -sk "$PY_USER_BASE/cache" 2>/dev/null | awk 'NR == 1 { print $1 }')"
    stamp="$(awk 'NR == 1 { $1 = ""; sub(/^ /, ""); print }' "$PY_USER_BASE/.maintenance" 2>/dev/null)"
    echo "python files: $files (uv cache ${size:-0} KB; last upkeep: ${stamp:-not yet})"
  else
    echo "python files: $files not created (it holds what BotBoy's chat and servers install with pip or uv)"
  fi
}

# Test hook output (BOTBOY_TEST_PYTHON_SELECT / _ENSURE / _FLOW): the decision, one key=value per line.
print_python_selection() {
  python_runtime_chip
  echo "python_source=$PY_SOURCE"
  echo "python_reason=$PY_REASON"
  echo "python_system=$PY_SYSTEM"
  echo "python_bin=$PY_BIN_DIR"
  echo "uv_source=$UV_SOURCE"
  echo "uv_reason=$UV_REASON"
  echo "uv_system=$UV_SYSTEM"
  echo "uv_dir=$PY_UV_DIR"
  echo "needs_runtime=$PY_NEEDS_RUNTIME"
  echo "download_allowed=${NODE_DOWNLOAD_OK:-0}"
  echo "mode=$PY_RUNTIME_MODE"
  echo "chip=$PR_CHIP"
  echo "path=$PATH"
}

PYTHON_RUNTIME_LOADED=1
