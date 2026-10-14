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
#   ./start.sh --rebuild-ocr re-check the OCR helper (it reads text inside images
#                            and scanned PDFs) now and, only when none is usable
#                            and a Swift toolchain exists, build one; ignores an
#                            earlier remembered outcome; wait for the result and
#                            exit without starting anything. BotBoy ships the
#                            helper PREBUILT, so nothing is compiled on a normal
#                            Mac. A normal start never waits for the helper
#                            either: its check (and a last-resort local build,
#                            with a hard time limit, BOTBOY_OCR_BUILD_TIMEOUT_SECONDS,
#                            default 120) runs in the background once the
#                            dashboard window is open, and an outcome is
#                            remembered per machine until the source, the
#                            prebuilt helper, the Swift compiler, or macOS
#                            changes.

FOREGROUND=0
OPEN_WINDOW_ONLY=0
STOP_ONLY=0
DOCTOR=0
RECOVER_SHUTDOWN=0
UPDATE_ONLY=0
REBUILD_OCR=0
[ "$1" = "--foreground" ] && FOREGROUND=1
# --open-window: just focus/open the dashboard window (used when BotBoy.app's
# dock icon is clicked while the tracker is already running).
[ "$1" = "--open-window" ] && OPEN_WINDOW_ONLY=1
[ "$1" = "--stop" ] && STOP_ONLY=1
[ "$1" = "--doctor" ] && DOCTOR=1
[ "$1" = "--recover-shutdown" ] && RECOVER_SHUTDOWN=1
[ "$1" = "--update" ] && UPDATE_ONLY=1
[ "$1" = "--rebuild-ocr" ] && REBUILD_OCR=1

# Resolve the project dir from THIS script's location — never hardcode, or the
# launcher silently breaks the moment the repo moves.
PROJ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Tool paths are variables, not PATH lookups, so tests can substitute them
# (start.sh prepends several directories to PATH, which makes PATH shims
# unreliable). Production never sets the BOTBOY_TEST_* names.
XCODE_SELECT_BIN="${BOTBOY_TEST_XCODE_SELECT_BIN:-/usr/bin/xcode-select}"
XCRUN_BIN="${BOTBOY_TEST_XCRUN_BIN:-/usr/bin/xcrun}"
NPM_BIN="${BOTBOY_TEST_NPM_BIN:-npm}"
GIT_SHIM="${BOTBOY_TEST_GIT_SHIM:-/usr/bin/git}"
ARCH_BIN="${BOTBOY_TEST_ARCH_BIN:-/usr/bin/arch}"
SYSCTL_BIN="${BOTBOY_TEST_SYSCTL_BIN:-/usr/sbin/sysctl}"
FILE_BIN="${BOTBOY_TEST_FILE_BIN:-/usr/bin/file}"
XATTR_BIN="${BOTBOY_TEST_XATTR_BIN:-/usr/bin/xattr}"

# ── Native architecture on Apple Silicon ─────────────────────────────────────
# A shell that runs under Rosetta hands that translation to everything it
# starts: Chrome, Node, npm, and the native modules npm installs. A Rosetta
# Terminal, or a shell-script .app that macOS starts translated, was enough to
# run all of BotBoy 2-5x slower (teammate Mac, 2026-10-12). Three layers keep
# it native:
#   1. The early re-exec below. This is the guaranteed layer: a translated
#      start.sh replaces itself with a native one (same PID, same arguments).
#   2. The prefix arrays (arch_plan): when the re-exec cannot happen
#      (BOTBOY_NO_ARCH_REEXEC=1), Chrome and the server still start native.
#   3. LSArchitecturePriority in BotBoy.app's Info.plist (make-app-bundle.mjs,
#      app_launcher_plan) makes the app itself start native.
# Hardware is judged by `sysctl hw.optional.arm64` (a translated process
# still sees an Intel-looking uname), and ALL probing is skipped on Intel
# Macs, which therefore never run `arch` or `file`. Binaries are inspected
# with /usr/bin/file, never lipo or otool: those are Xcode shims that raise
# the install dialog on a Mac without Command Line Tools.
HW_ARM64=0
SHELL_TRANSLATED=0
ARCH_PROBE_OK=0
REEXEC_NATIVE=0
CHROME_ARCHS=""
NODE_ARCHS=""
WARN_CHROME_INTEL=0
WARN_NODE_INTEL=0
# Command-prefix arrays (bash 3.2). Expanded as ${NAME[@]+"${NAME[@]}"} in
# front of a spawned program, so `$!` stays the program's PID: `arch -arm64`
# replaces itself with the program. Never a function in front of `nohup` or `&`.
CHROME_PREFIX=()
SERVER_PREFIX=()
NODE_PREFIX=()

# Gather the hardware facts. BOTBOY_TEST_HW_ARM64 / _SHELL_TRANSLATED /
# _ARCH_PROBE_OK inject them for tests; production never sets them.
arch_facts() {
  local hw translated
  HW_ARM64=0
  SHELL_TRANSLATED=0
  ARCH_PROBE_OK=0
  if [ -n "${BOTBOY_TEST_HW_ARM64+x}" ]; then
    hw="$BOTBOY_TEST_HW_ARM64"
  else
    hw="$("$SYSCTL_BIN" -n hw.optional.arm64 2>/dev/null)"
  fi
  [ "$hw" = "1" ] || return 0
  HW_ARM64=1
  if [ -n "${BOTBOY_TEST_HW_ARM64+x}" ]; then
    translated="${BOTBOY_TEST_SHELL_TRANSLATED:-0}"
  else
    translated="$("$SYSCTL_BIN" -n sysctl.proc_translated 2>/dev/null)"
  fi
  [ "$translated" = "1" ] && SHELL_TRANSLATED=1
  if [ -n "${BOTBOY_TEST_ARCH_PROBE_OK+x}" ]; then
    [ "$BOTBOY_TEST_ARCH_PROBE_OK" = "1" ] && ARCH_PROBE_OK=1
  elif "$ARCH_BIN" -arm64 /usr/bin/true >/dev/null 2>&1; then
    ARCH_PROBE_OK=1
  fi
  return 0
}

# Pure: should this process replace itself with a native one?
arch_reexec_wanted() {
  [ "$HW_ARM64" = "1" ] || return 1
  [ "$SHELL_TRANSLATED" = "1" ] || return 1
  [ "$ARCH_PROBE_OK" = "1" ] || return 1
  [ -z "${BOTBOY_NATIVE_REEXEC:-}" ] || return 1
  [ "${BOTBOY_NO_ARCH_REEXEC:-0}" != "1" ] || return 1
  return 0
}

# The architectures a Mach-O file holds, space separated and empty when
# unknown (a script, a missing file, an unreadable answer). `file -b` lists a
# universal binary as `[x86_64:Mach-O ...] [arm64:Mach-O ...]` and a thin one
# as `Mach-O 64-bit executable arm64`. Never judged by the word "universal".
file_description_archs() {
  local description="$1" archs
  case "$description" in
    Mach-O*) ;;
    *) return 0 ;;
  esac
  archs="$(printf '%s\n' "$description" | grep -o '\[[a-z0-9_]*:' | tr -d '[:' | tr '\n' ' ')"
  if [ -z "$archs" ]; then
    archs="${description##* }"
  fi
  printf '%s' "${archs% }"
}

binary_archs() {
  local description
  [ -e "$1" ] || return 0
  description="$("$FILE_BIN" -b "$1" 2>/dev/null)" || return 0
  file_description_archs "$description"
}

# Whether a `binary_archs` answer includes an arm64-capable slice (arm64e too).
archs_include_arm64() {
  case " $1 " in
    *" arm64 "*|*" arm64e "*) return 0 ;;
  esac
  return 1
}

# Pure: from HW_ARM64, SHELL_TRANSLATED, ARCH_PROBE_OK, CHROME_ARCHS, and
# NODE_ARCHS, decide the prefixes and the warnings. A program is wrapped only
# while this shell is translated (a native shell's children already run
# natively), only when its own slices include arm64, and only when
# `arch -arm64` demonstrably works. Unknown architectures neither wrap nor warn.
arch_plan() {
  REEXEC_NATIVE=0
  WARN_CHROME_INTEL=0
  WARN_NODE_INTEL=0
  CHROME_PREFIX=()
  SERVER_PREFIX=()
  NODE_PREFIX=()
  [ "$HW_ARM64" = "1" ] || return 0
  arch_reexec_wanted && REEXEC_NATIVE=1
  if [ -n "$CHROME_ARCHS" ] && ! archs_include_arm64 "$CHROME_ARCHS"; then
    WARN_CHROME_INTEL=1
  fi
  if [ -n "$NODE_ARCHS" ] && ! archs_include_arm64 "$NODE_ARCHS"; then
    WARN_NODE_INTEL=1
  fi
  [ "$ARCH_PROBE_OK" = "1" ] || return 0
  [ "$SHELL_TRANSLATED" = "1" ] || return 0
  if archs_include_arm64 "$CHROME_ARCHS"; then
    CHROME_PREFIX=("$ARCH_BIN" -arm64)
  fi
  if archs_include_arm64 "$NODE_ARCHS"; then
    SERVER_PREFIX=("$ARCH_BIN" -arm64)
    NODE_PREFIX=("$ARCH_BIN" -arm64)
  fi
  return 0
}

# Synchronous commands (npm, `node -e`, node scripts) run through the same
# prefix. Spawned programs use the prefix arrays directly instead.
native_exec() {
  if [ "${#NODE_PREFIX[@]}" -gt 0 ]; then
    "${NODE_PREFIX[@]}" "$@"
  else
    "$@"
  fi
}

arch_facts

# Executable test hook: print the plan from injected facts and exit.
if [ "${BOTBOY_TEST_ARCH_PLAN:-0}" = "1" ]; then
  CHROME_ARCHS="${BOTBOY_TEST_CHROME_ARCHS:-}"
  NODE_ARCHS="${BOTBOY_TEST_NODE_ARCHS:-}"
  arch_plan
  echo "hw_arm64=$HW_ARM64 shell_translated=$SHELL_TRANSLATED arch_probe_ok=$ARCH_PROBE_OK"
  echo "reexec=$REEXEC_NATIVE"
  echo "chrome_prefix=${CHROME_PREFIX[*]-}"
  echo "server_prefix=${SERVER_PREFIX[*]-}"
  echo "node_prefix=${NODE_PREFIX[*]-}"
  echo "warn_chrome_intel=$WARN_CHROME_INTEL warn_node_intel=$WARN_NODE_INTEL"
  exit 0
fi

# The early re-exec. Same PID and arguments, so the app launcher's child
# relationship, its SIGINT forwarding, and --foreground behave as before.
# `arch -arm64 /usr/bin/true` already succeeded (ARCH_PROBE_OK), and execfail
# keeps a late failure from ending a non-interactive shell: it falls through
# and the launcher continues translated, with the prefix arrays as backup.
# BOTBOY_NATIVE_REEXEC is the loop guard; BOTBOY_NO_ARCH_REEXEC=1 turns the
# re-exec off. The app launcher discards stdout, so one line also goes to the
# log file directly.
if arch_reexec_wanted; then
  echo "ℹ️  This shell was running under Rosetta; continuing natively on Apple Silicon"
  printf '%s This shell was running under Rosetta; continuing natively on Apple Silicon (start.sh %s)\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "${PPT_LOG_FILE:-/tmp/ppt.log}" 2>/dev/null || true
  export BOTBOY_NATIVE_REEXEC=1
  export BOTBOY_REEXEC_FROM=translated
  shopt -s execfail
  exec "$ARCH_BIN" -arm64 /bin/bash "$0" "$@"
  # Only reached when exec failed: this process stays translated.
  unset BOTBOY_NATIVE_REEXEC BOTBOY_REEXEC_FROM
fi

# Executable test hook: report what this (possibly re-executed) process is,
# keep running so a test can signal it, and start nothing.
if [ "${BOTBOY_TEST_REEXEC_PROBE:-0}" = "1" ]; then
  echo "pid=$$ args=$* guard=${BOTBOY_NATIVE_REEXEC:-} from=${BOTBOY_REEXEC_FROM:-} translated=$("$SYSCTL_BIN" -n sysctl.proc_translated 2>/dev/null)"
  sleep 30 &
  PROBE_SLEEP_PID=$!
  trap 'echo got-INT; kill "$PROBE_SLEEP_PID" 2>/dev/null; exit 0' INT
  wait "$PROBE_SLEEP_PID"
  exit 0
fi

# Whether Xcode Command Line Tools answer. `xcode-select -p` is silent; the
# /usr/bin shims (git, swiftc, lipo, otool) raise the macOS install dialog on a
# Mac without them, so nothing on the start or doctor path may touch a shim
# first.
clt_installed() {
  "$XCODE_SELECT_BIN" -p >/dev/null 2>&1
}

# The Swift compiler is reachable (CLT installed and xcrun finds swiftc).
clt_toolchain_ok() {
  clt_installed && "$XCRUN_BIN" --find swiftc >/dev/null 2>&1
}

# git is safe to run: found, and not the /usr/bin shim without CLT behind it.
git_usable() {
  local found
  found="$(command -v git 2>/dev/null)"
  [ -n "$found" ] || return 1
  if [ "$found" = "$GIT_SHIM" ]; then
    clt_installed
    return $?
  fi
  return 0
}

# Whether the native modules work in the exact Node this launcher runs. One
# `name|ok` or `name|<error>` line per module; nonzero when either fails.
# better-sqlite3 binds its addon only inside `new Database()`, so `require`
# alone proves nothing (the doctor said "loads" on a teammate Mac where it
# could not open a database); node-pty must actually spawn a terminal.
# `repair` first restores the execute bit node-pty 1.1.0's npm tarball drops
# from its macOS spawn-helper (`posix_spawnp failed` otherwise); `check`
# changes nothing.
native_modules_status() {
  (cd "$PROJ_DIR" && native_exec "$NODE" -e '
    const fs = require("fs");
    const path = require("path");
    const repair = process.argv[1] === "repair";
    const cwd = process.cwd() + path.sep;
    const describe = error => String((error && error.message) || error)
      .split(cwd).join("").replace(/\s+/g, " ").replace(/ (Tried:|Require stack:) .*$/, "")
      .trim().slice(0, 300) || "unknown error";
    const results = [];
    let failed = false;
    const record = (name, error) => {
      if (error) failed = true;
      results.push(`${name}|${error ? describe(error) : "ok"}`);
    };
    const finish = () => {
      process.stdout.write(results.join("\n") + "\n");
      process.exit(failed ? 1 : 0);
    };
    try {
      new (require("better-sqlite3"))(":memory:").close();
      record("better-sqlite3");
    } catch (error) {
      record("better-sqlite3", error);
    }
    if (repair) {
      for (const platform of ["darwin-arm64", "darwin-x64"]) {
        const helper = path.join("node_modules", "node-pty", "prebuilds", platform, "spawn-helper");
        try {
          const mode = fs.statSync(helper).mode;
          if ((mode & 0o111) !== 0o111) fs.chmodSync(helper, (mode & 0o777) | 0o755);
        } catch {}
      }
    }
    let terminal;
    try {
      terminal = require("node-pty").spawn("/usr/bin/true", [], { name: "xterm", cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
    } catch (error) {
      record("node-pty", error);
      finish();
    }
    const timer = setTimeout(() => {
      try { terminal.kill(); } catch {}
      record("node-pty", new Error("a test terminal did not exit within 5 seconds"));
      finish();
    }, 5000);
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      record("node-pty", exitCode === 0 ? undefined : new Error(`a test terminal exited with ${exitCode}`));
      finish();
    });
  ' "${1:-check}" 2>/dev/null)
}


# The folders this launcher puts in front of PATH for the Node lookup and for everything it starts (a user-level
# Homebrew, ~/.local, Toolbox, then the two system-wide Homebrew folders). ONE list, read in two places: the real start
# (the PATH export further down) and the Node lookup itself (scripts/node-runtime.sh › node_find_system), so the
# --update prefetch, which runs before that export, finds the same Node a start finds and never downloads BotBoy's
# own copy for a Mac whose Node works. Test hook (production never sets it): BOTBOY_TEST_NO_HOST_BIN_DIRS=1 leaves
# the two system-wide folders out, so a test's lookup does not depend on what is installed on the Mac running it.
if [ "${BOTBOY_TEST_NO_HOST_BIN_DIRS:-0}" = "1" ]; then
  START_EXTRA_PATH="$HOME/homebrew/bin:$HOME/.local/bin:$HOME/.toolbox/bin"
else
  START_EXTRA_PATH="$HOME/homebrew/bin:$HOME/.local/bin:$HOME/.toolbox/bin:/usr/local/bin:/opt/homebrew/bin"
fi

# BotBoy's own Node for a Mac with no usable one: scripts/node-runtime.sh (see its header). It is sourced here, before
# the --update block and the Node lookup below, because both use it. A checkout without the file behaves as before.
NODE_RUNTIME_LOADED=0
NODE_SOURCE=system
NODE_DOWNLOAD_OK=0
[ "$DOCTOR$STOP_ONLY$RECOVER_SHUTDOWN$OPEN_WINDOW_ONLY$REBUILD_OCR" = "00000" ] && NODE_DOWNLOAD_OK=1
if [ -f "$PROJ_DIR/scripts/node-runtime.sh" ]; then
  # shellcheck source=scripts/node-runtime.sh
  . "$PROJ_DIR/scripts/node-runtime.sh"
fi
# BotBoy's own Python (uv + one CPython) for a Mac without a usable Python or uv: scripts/python-runtime.sh (see its
# header). Optional: nothing in it ever stops a start. A checkout without the file behaves as before.
PYTHON_RUNTIME_LOADED=0
if [ -f "$PROJ_DIR/scripts/python-runtime.sh" ]; then
  # shellcheck source=scripts/python-runtime.sh
  . "$PROJ_DIR/scripts/python-runtime.sh"
fi

# Release checkouts are customizable runtime snapshots. Detect from the
# generated marker (current releases) or origin URL (backward compatibility).
BOTBOY_REMOTE_URL=""
if git_usable; then
  BOTBOY_REMOTE_URL="$(git -C "$PROJ_DIR" remote get-url origin 2>/dev/null || true)"
fi
# Executable test hook: prints whether git is usable; the guard above has
# already run, so a stub git that records calls proves it was never invoked.
if [ "${BOTBOY_TEST_GIT_USABLE:-0}" = "1" ]; then
  git_usable && echo "git_usable: yes" || echo "git_usable: no"
  exit 0
fi
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
  if ! git_usable; then
    echo "❌ --update needs git, which needs Xcode Command Line Tools: run xcode-select --install, then ./start.sh --update."
    exit 1
  fi
  if ! git -C "$PROJ_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "❌ This botboy-app install is not a Git checkout. Re-clone it to update."
    exit 1
  fi
  UPDATE_SAFETY_BLOCK="${PPT_STARTUP_SAFETY_BLOCK:-/tmp/ppt-startup-safety-block.json}"
  # With an unverified earlier shutdown, update the code but never start.
  # Updating touches no database, process, or guard, and it brings the newest
  # recovery helper; refusing it left a teammate stuck behind a guard that
  # only a newer helper could clear (2026-10-07).
  UPDATE_GUARDED=0
  if [ -f "$UPDATE_SAFETY_BLOCK" ]; then
    UPDATE_GUARDED=1
    echo "ℹ️  An earlier shutdown is still unverified: updating the code only. BotBoy will not start."
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

  # An update that will not start BotBoy still brings the pinned Node: when this Mac uses (or needs) BotBoy's own
  # copy and the new release pins another version, fetch it now. A start does the same on the normal path below.
  if [ "$NODE_RUNTIME_LOADED" = "1" ] && { [ "$UPDATE_GUARDED" = "1" ] || [ "${BOTBOY_UPDATE_NO_START:-0}" = "1" ]; }; then
    node_runtime_update_prefetch
  fi
  # The same for BotBoy's own Python (uv + CPython). A start fetches it in the background instead.
  if [ "$PYTHON_RUNTIME_LOADED" = "1" ] && { [ "$UPDATE_GUARDED" = "1" ] || [ "${BOTBOY_UPDATE_NO_START:-0}" = "1" ]; }; then
    python_runtime_update_prefetch
  fi
  if [ "$UPDATE_GUARDED" = "1" ]; then
    echo "✅ BotBoy updated. It was not started because an earlier shutdown is still unverified."
    echo "    Next: ./start.sh --recover-shutdown"
    echo "    Then: ./start.sh"
    exit 0
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
# A shared Google client staged by an older importer (that delivery is
# retired); the server deletes it unread at boot (gmail-connection.ts › retireStagedTeamClient).
GMAIL_TEAM_CLIENT_INBOX="$HOME/.personal-productivity-tracker/gmail-team-client.json"
# Connections → Gmail: the owner's own OAuth client and refresh token,
# written by the server (0600). Only --doctor inspects it, inside node.
GMAIL_CREDENTIALS_FILE="$HOME/.personal-productivity-tracker/gmail.json"
STARTUP_SAFETY_BLOCK="${PPT_STARTUP_SAFETY_BLOCK:-/tmp/ppt-startup-safety-block.json}"
SHUTDOWN_RECEIPT_DIR="${PPT_SHUTDOWN_RECEIPT_DIR:-/tmp}"
STARTUP_INT_GRACE_SECONDS="${PPT_STARTUP_INT_GRACE_SECONDS:-20}"
STARTUP_TERM_GRACE_SECONDS="${PPT_STARTUP_TERM_GRACE_SECONDS:-10}"
DEBUG_PROFILE="$HOME/.chrome-debug-profile"
CHROME="${BOTBOY_TEST_CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
export PATH="$START_EXTRA_PATH:$PATH"

# Resolve node without hardcoding any machine-specific path. BotBoy.app
# launches with a minimal PATH, so check PATH first, then the layouts of
# common installers (n, nvm, homebrew, system). The globs pick the newest
# installed version. nvm matters for teammates: nvm only exists after its
# shell init runs, so `command -v node` fails in app launches and bare
# shells — that produced ':x: node not found' on a machine with a
# perfectly good nvm-managed Node 22 (2026-08-24).
if [ "$NODE_RUNTIME_LOADED" = "1" ]; then
  # scripts/node-runtime.sh: this Mac's own Node when it works (always preferred, nothing about it changes), else
  # BotBoy's pinned private copy if it is already installed. Phase 1 never downloads; a real start calls
  # ensure_node_runtime (phase 2) before its first npm or build step.
  node_select_phase1
  [ -n "$NODE" ] || node_none_found
else
  NODE="${BOTBOY_TEST_NODE_BIN:-$(command -v node)}"
  if [ -z "$NODE" ]; then
    for candidate in "$HOME"/n/n/versions/node/*/bin/node "$HOME"/.n/versions/node/*/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
      [ -x "$candidate" ] && NODE="$candidate"
    done
  fi
  if [ -z "$NODE" ]; then
    echo "❌ node not found — install Node 24 or newer from nodejs.org (the LTS download; the installer needs no other tools), then re-run ./start.sh" | tee -a "$LOG_FILE"
    exit 1
  fi
fi

LSOF_BIN="${BOTBOY_TEST_LSOF_BIN:-lsof}"
PS_BIN="${BOTBOY_TEST_PS_BIN:-ps}"

# On Apple Silicon, prefer a Node that holds an arm64 slice over an Intel-only
# one found first on PATH (a leftover Intel Homebrew or an old installer).
# Candidates are inspected with `file`, never run.
pick_native_node() {
  local candidate archs
  [ "$HW_ARM64" = "1" ] || return 0
  [ "$NODE_SOURCE" = "private" ] && return 0
  [ -n "$NODE_ARCHS" ] && ! archs_include_arm64 "$NODE_ARCHS" || return 0
  for candidate in "$HOME/homebrew/bin/node" /opt/homebrew/bin/node \
    "$HOME"/n/n/versions/node/*/bin/node "$HOME"/.n/versions/node/*/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$candidate" ] || continue
    archs="$(binary_archs "$candidate")"
    if archs_include_arm64 "$archs"; then
      NODE="$candidate"
      NODE_ARCHS="$archs"
      return 0
    fi
  done
  return 0
}

# Read the real architectures once (Apple Silicon only), choose the native
# Node, and compute the plan. Warnings are calm, once per start, and never fatal.
arch_prepare() {
  CHROME_ARCHS=""
  NODE_ARCHS=""
  if [ "$HW_ARM64" = "1" ]; then
    CHROME_ARCHS="$(binary_archs "$CHROME")"
    NODE_ARCHS="$(binary_archs "$NODE")"
    pick_native_node
  fi
  arch_plan
}

# The debug Chrome that is already listening on 9222: native, translated,
# none, or unknown. Reads its process flags (bit 0x20000 = translated);
# best effort and fail-open, and it touches nothing.
running_debug_chrome_state() {
  local pid flags
  [ "$HW_ARM64" = "1" ] || { echo unknown; return 0; }
  pid="$("$LSOF_BIN" -nP -iTCP:9222 -sTCP:LISTEN -t 2>/dev/null | head -n 1)"
  [ -n "$pid" ] || { echo none; return 0; }
  flags="$("$PS_BIN" -o flags= -p "$pid" 2>/dev/null | tr -d ' ')"
  [[ "$flags" =~ ^[0-9a-fA-F]+$ ]] || { echo unknown; return 0; }
  if [ $(( 0x$flags & 0x20000 )) -ne 0 ]; then echo translated; else echo native; fi
}

warn_if_running_chrome_translated() {
  [ "$(running_debug_chrome_state)" = "translated" ] || return 0
  echo "⚠️  The running debug Chrome is translated (slow): quit it and run ./start.sh again, or run ./start.sh --doctor" | tee -a "$LOG_FILE"
}

# The once-per-start architecture warnings (start modes only; the doctor has
# its own rows).
arch_print_warnings() {
  if [ "$WARN_CHROME_INTEL" = "1" ]; then
    echo "⚠️  Chrome is the Intel build and runs 2-5x slower on this Mac: download Chrome for Mac with Apple chip from google.com/chrome and replace it" | tee -a "$LOG_FILE"
  fi
  if [ "$WARN_NODE_INTEL" = "1" ]; then
    echo "⚠️  Node is the Intel build and runs under Rosetta: install an Apple-silicon Node (nodejs.org installer for Apple silicon, or Homebrew in /opt/homebrew)" | tee -a "$LOG_FILE"
  fi
}

arch_prepare
if [ "$DOCTOR$STOP_ONLY$RECOVER_SHUTDOWN$OPEN_WINDOW_ONLY$REBUILD_OCR" = "00000" ]; then
  arch_print_warnings
fi

# Make the chosen node's bin dir visible to child processes (npm, npx). For BotBoy's own Node this is what makes
# npm's `#!/usr/bin/env node`, npx, postinstall, the build, the OCR and bootstrap jobs, the server, the in-app
# updater's child and the --foreground flow use it: a $NODE variable alone would not reach them.
if [ -n "$NODE" ]; then
  PATH="$(dirname "$NODE"):$PATH"
  export PATH
fi

# BotBoy's own Python, phase 1 (scripts/python-runtime.sh): which Python and uv this Mac has, and whether BotBoy's own
# pair is installed. It never downloads and never changes PATH beyond removing inherited entries of BotBoy's Python;
# a real start fetches what is missing in the background (python_runtime_fetch_begin) and puts BotBoy's Python on
# PATH just before the server starts (python_runtime_fetch_join).
[ "$PYTHON_RUNTIME_LOADED" != "1" ] || python_select_phase1

# Executable test hooks for the Node choice (scripts/node-runtime.sh). _SELECT prints what phase 1 chose and exits;
# _ENSURE also runs phase 2 (the download) first, as a real start would; _DOCTOR_NODE_RUNTIME prints the two doctor
# rows. None starts anything else.
if [ "$NODE_RUNTIME_LOADED" = "1" ]; then
  if [ "${BOTBOY_TEST_NODE_SELECT:-0}" = "1" ]; then
    print_node_selection
    exit 0
  fi
  if [ "${BOTBOY_TEST_NODE_ENSURE:-0}" = "1" ]; then
    ensure_node_runtime
    print_node_selection
    exit 0
  fi
  if [ "${BOTBOY_TEST_DOCTOR_NODE_RUNTIME:-0}" = "1" ]; then
    doctor_node_runtime_rows
    exit 0
  fi
fi
# Executable test hooks for BotBoy's own Python (scripts/python-runtime.sh). _SELECT prints what phase 1 chose; _ENSURE
# runs the background install as a real start does (begin, then join; BOTBOY_TEST_PYTHON_JOIN_LONG=0 joins like a
# restart with nothing to build); _DOCTOR_PYTHON_RUNTIME prints the doctor rows; _MAINTENANCE runs the upkeep. None
# starts anything else.
if [ "$PYTHON_RUNTIME_LOADED" = "1" ]; then
  if [ "${BOTBOY_TEST_PYTHON_SELECT:-0}" = "1" ]; then
    print_python_selection
    exit 0
  fi
  if [ "${BOTBOY_TEST_PYTHON_ENSURE:-0}" = "1" ]; then
    python_runtime_fetch_begin
    PY_JOIN_LONG="${BOTBOY_TEST_PYTHON_JOIN_LONG:-1}"
    python_runtime_fetch_join
    print_python_selection
    exit 0
  fi
  if [ "${BOTBOY_TEST_DOCTOR_PYTHON_RUNTIME:-0}" = "1" ]; then
    doctor_python_rows
    exit 0
  fi
  if [ "${BOTBOY_TEST_PYTHON_MAINTENANCE:-0}" = "1" ]; then
    python_runtime_maintenance
    exit 0
  fi
fi

# Packages package.json declares that node_modules lacks, or holds at another
# version than an exact pin. Space-separated; empty when everything is there.
missing_npm_dependencies() {
  native_exec "$NODE" -e '
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

# The prebuilt native helpers arrive through git, which sets no download flag
# (com.apple.quarantine). A ZIP downloaded in a browser flags every file, and
# macOS then kills the first run of a flagged helper (about 6 s later, measured)
# or raises a Gatekeeper dialog whose default button is Move to Trash. So the
# flag is cleared on native/ before anything can run a helper, and a file whose
# flag cannot be cleared is never executed (the resolver in
# scripts/native-prebuilt.mjs refuses it). Best effort, never fatal; `xattr` is a
# real OS tool, not an Xcode shim. Cost when nothing is flagged: two xattr calls.
native_download_mark_present() {
  [ -f "$1" ] && "$XATTR_BIN" -p com.apple.quarantine "$1" >/dev/null 2>&1
}
strip_native_download_mark() {
  [ -d "$PROJ_DIR/native" ] || return 0
  native_download_mark_present "$PROJ_DIR/native/vision-ocr/prebuilt/vision-ocr" \
    || native_download_mark_present "$PROJ_DIR/native/botboy-launcher/prebuilt/botboy-launcher" \
    || return 0
  "$XATTR_BIN" -r -d com.apple.quarantine "$PROJ_DIR/native" >/dev/null 2>&1 || true
  if native_download_mark_present "$PROJ_DIR/native/vision-ocr/prebuilt/vision-ocr" \
    || native_download_mark_present "$PROJ_DIR/native/botboy-launcher/prebuilt/botboy-launcher"; then
    echo "Could not clear the download mark on BotBoy's helpers; OCR stays off until it is cleared: xattr -r -d com.apple.quarantine \"$PROJ_DIR/native\"" >> "$LOG_FILE"
  else
    echo "Cleared the download mark on BotBoy's helpers" >> "$LOG_FILE"
  fi
  return 0
}

# Node 20 compiles BotBoy's database module from source on `npm install`, which needs the Xcode
# Command Line Tools; Node 22 and newer download a prebuilt copy (BotBoy now recommends 24: Node 22's npm cannot do a first install of it,
# see scripts/node-runtime.sh). One calm line before an install on a
# Mac that has the first and not the second. It never blocks the install, and an ordinary start (nothing to
# install) never gets here. (An npm "preinstall" script cannot say this early: npm runs a dependency's install
# script before the root package's, measured on npm 10.8.2.)
warn_if_node_needs_tools_to_install() {
  local version major
  version="$("$NODE" --version 2>/dev/null)"
  major="${version#v}"
  major="${major%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] || return 0
  [ "$major" -lt 22 ] || return 0
  clt_installed && return 0
  echo "ℹ  This Mac has Node ${version} and no Command Line Tools. Installing BotBoy's database module has to compile it. Install Node 24 or newer from nodejs.org (the LTS download; no extra tools needed), or run xcode-select --install first." | tee -a "$LOG_FILE"
  return 0
}

# Dependency self-heal. `--update` fast-forwards package.json but never ran
# npm, so a new or re-pinned dependency (BotBoy's pdf.js reader, an SDK pin)
# never reached teammates. Install only when something is missing; a failed
# install warns, and BotBoy starts with what it has. npm can exit nonzero
# (a native build step, say) after every package landed, so the verdict
# comes from a second look at node_modules, not from npm's exit code.
DEPS_INSTALLED=0
heal_missing_npm_dependencies() {
  local missing still
  missing="$(missing_npm_dependencies)"
  [ -n "$missing" ] || return 0
  warn_if_node_needs_tools_to_install
  echo "ℹ️  Installing dependencies ($missing) — npm install" | tee -a "$LOG_FILE"
  # BOTBOY_DEFER_OCR_BUILD: npm's postinstall must not compile the optional OCR
  # helper here, before the window; the background job builds it afterwards.
  if (cd "$PROJ_DIR" && export BOTBOY_DEFER_OCR_BUILD=1 && native_exec "$NPM_BIN" install --no-audit --no-fund >> "$LOG_FILE" 2>&1); then
    echo "✅ Dependencies installed" | tee -a "$LOG_FILE"
    DEPS_INSTALLED=1
    return 0
  fi
  still="$(missing_npm_dependencies)"
  if [ -z "$still" ]; then
    echo "⚠️  npm install reported an error, but every BotBoy package is present (see $LOG_FILE); continuing" | tee -a "$LOG_FILE"
  else
    echo "⚠️  npm install failed — see $LOG_FILE. BotBoy starts without: $still" | tee -a "$LOG_FILE"
  fi
}

# The OCR helper is an optional extra: BotBoy reads PDF text with pdf.js
# without it, and it only adds text from images and scanned PDFs. It ships
# PREBUILT (native/vision-ocr/prebuilt, one universal ad-hoc signed file beside
# native/prebuilt-manifest.json) so nothing is compiled on a teammate's Mac.
# The decision is ONE function, scripts/native-prebuilt.mjs › resolveVisionHelper
# (prebuilt, local build, or none and why); this file only runs it. A local
# compile is the last resort, only when no usable helper exists and a Swift
# toolchain does, and it used to be slow, fail on a Mac whose Command Line Tools
# and macOS do not match, and hang (Maria's Mac, 2026-10-13: every start retried
# a failing compile before the server and window, so opening BotBoy "took
# ages"). So:
#   - Nothing here runs before the dashboard window is open. start_ocr_helper_job
#     runs after it, as a detached background job (about 100 ms of Node, because
#     the check no longer depends on file times), and a start never waits for it.
#   - scripts/bootstrap-deps.mjs --ocr-helper does the work. A current helper
#     ends it at once, silently, without touching any compiler or Xcode shim.
#     Otherwise it owns the hard time limit (BOTBOY_OCR_BUILD_TIMEOUT_SECONDS,
#     default 120), keeps the compiler output to its first 20 and last 5 lines,
#     and remembers the outcome per machine
#     (~/.personal-productivity-tracker/ocr-helper-build.json) so an unchanged
#     source, prebuilt helper, Swift compiler, and macOS build are not retried.
#     One calm note is printed per outcome; a start that skips the work prints
#     nothing.
#   - ./start.sh --rebuild-ocr re-checks on request. A failure keeps the helper
#     in use. Without Xcode CLT nothing is compiled and no shim is ever run.

# One synchronous attempt to bring the OCR helper up to date. $1 = "force" when
# the owner asked (./start.sh --rebuild-ocr): a remembered outcome is ignored
# and every line is shown. Otherwise (the background job) only the calm note
# reaches the terminal, and the compiler detail goes to the log.
rebuild_ocr_helper_if_needed() {
  local mode="${1:-background}"
  if [ ! -f "$PROJ_DIR/scripts/bootstrap-deps.mjs" ]; then
    [ "$mode" != "force" ] || echo "ℹ  scripts/bootstrap-deps.mjs is missing from this BotBoy folder; run ./start.sh --update to restore it" | tee -a "$LOG_FILE"
    return 0
  fi
  if [ "$mode" = "force" ]; then
    echo "ℹ  Checking the OCR helper; building one locally (only when none is usable) can take a minute or two" | tee -a "$LOG_FILE"
    (cd "$PROJ_DIR" && native_exec "$NODE" scripts/bootstrap-deps.mjs --ocr-helper --force-ocr 2>&1) | tee -a "$LOG_FILE"
  else
    (cd "$PROJ_DIR" && native_exec "$NODE" scripts/bootstrap-deps.mjs --ocr-helper 2>> "$LOG_FILE") | tee -a "$LOG_FILE"
  fi
  return 0
}

# Start the OCR helper work as a detached background job and return at once.
# Call it only after the dashboard window is open. The job is a subshell: it has
# no input, ignores a closed Terminal (HUP), is never waited for, and holds
# nothing of this launcher (a subshell does not run the EXIT trap that releases
# the start lock, and it signals no server, so --stop and shutdown receipts are
# unaffected; its process, `node scripts/bootstrap-deps.mjs`, never matches the
# server match `node dist/index.js`). Its output goes to a terminal only: a pipe
# or file a caller waits on would otherwise stay open until the job ends. The
# BotBoy.app launcher waits for this script, not for the job.
start_ocr_helper_job() {
  [ -f "$PROJ_DIR/scripts/bootstrap-deps.mjs" ] || return 0
  (
    trap '' HUP
    exec </dev/null 2>>"$LOG_FILE"
    [ -t 1 ] || exec >/dev/null
    rebuild_ocr_helper_if_needed background
  ) &
  return 0
}

# The remembered BUILD failure of the last OCR helper build as one sentence for
# the doctor, or nothing (an "unavailable" outcome is not a failed build and has
# its words on the `ocr helper:` row). bootstrap-deps.mjs owns the marker format.
ocr_marker_doctor_text() {
  [ -f "$PROJ_DIR/scripts/bootstrap-deps.mjs" ] || return 0
  native_exec "$NODE" "$PROJ_DIR/scripts/bootstrap-deps.mjs" --ocr-marker 2>/dev/null | head -n 1
}

# The `ocr helper:` doctor row, from the same resolver the server and the job
# use. Read-only (a flagged file is reported, never cleared or run). Prints one
# line and returns 0 when a helper is usable; when Node or the module cannot
# answer, an `unknown` row and 1. Nothing here touches Xcode.
ocr_helper_status_row() {
  local line
  if [ -f "$PROJ_DIR/scripts/bootstrap-deps.mjs" ]; then
    line="$(native_exec "$NODE" "$PROJ_DIR/scripts/bootstrap-deps.mjs" --ocr-status 2>/dev/null | head -n 1)"
  fi
  if [ -n "$line" ]; then
    echo "$line"
    case "$line" in "ocr helper: OFF"*|"ocr helper: unknown"*) return 1 ;; esac
    return 0
  fi
  echo "ocr helper: unknown (the check could not run; run ./start.sh --update)"
  return 1
}

# Doctor rows for the Swift toolchain and the readers. The Command Line Tools
# are OPTIONAL now: the helpers ship prebuilt. The xcode-clt row says whether
# the compiler is reachable ("installed (swiftc found)" proves that, nothing
# more) and, only while OCR is not in order, repeats a remembered BUILD failure
# with its date, how long the attempt took, and the first error line.
doctor_toolchain_rows() {
  local ocr_row failure="" helper
  ocr_row="$(ocr_helper_status_row)"
  if clt_toolchain_ok; then
    case "$ocr_row" in
      *", current"*) ;;
      *) failure="$(ocr_marker_doctor_text)" ;;
    esac
    if [ -n "$failure" ]; then
      echo "xcode-clt: installed (swiftc found); $failure"
    else
      echo "xcode-clt: installed (swiftc found)"
    fi
  else
    echo "xcode-clt: not installed (optional: BotBoy's helpers ship prebuilt; the tools are needed only for Node 20's database module, for git, and to build a helper from source)"
  fi
  echo "$ocr_row"
  case "$ocr_row" in
    "ocr helper: prebuilt"*) helper="vision-ocr helper (prebuilt)" ;;
    "ocr helper: local build"*) helper="vision-ocr helper (local build)" ;;
    "ocr helper: OFF"*) helper="vision-ocr helper off (images and scanned PDFs unavailable; see the ocr helper row)" ;;
    *) helper="vision-ocr helper unknown (see the ocr helper row)" ;;
  esac
  echo "pdf readers: $helper; pdftotext $(command -v pdftotext >/dev/null 2>&1 && echo installed || echo absent); pdf.js $([ -f "$PROJ_DIR/node_modules/pdfjs-dist/legacy/build/pdf.mjs" ] && echo installed || echo 'MISSING — run: npm install')"
}

# Executable test hooks for the functions above. They change nothing beyond
# what the function itself does. BOTBOY_TEST_OCR_REBUILD runs the synchronous
# worker (BOTBOY_TEST_OCR_MODE=force for --rebuild-ocr's mode);
# BOTBOY_TEST_OCR_JOB runs only the detached kickoff and returns;
# BOTBOY_TEST_NATIVE_STRIP runs only the download-mark clearing (with
# BOTBOY_TEST_XATTR_BIN standing in for xattr).
if [ "${BOTBOY_TEST_NATIVE_STRIP:-0}" = "1" ]; then
  strip_native_download_mark
  echo "native-strip-done"
  exit 0
fi
if [ "${BOTBOY_TEST_HEAL_DEPS:-0}" = "1" ]; then
  heal_missing_npm_dependencies
  exit 0
fi
if [ "${BOTBOY_TEST_OCR_REBUILD:-0}" = "1" ]; then
  rebuild_ocr_helper_if_needed "${BOTBOY_TEST_OCR_MODE:-background}"
  exit 0
fi
if [ "${BOTBOY_TEST_OCR_JOB:-0}" = "1" ]; then
  start_ocr_helper_job
  echo "ocr-job-kicked-off"
  exit 0
fi
if [ "${BOTBOY_TEST_DOCTOR_TOOLCHAIN:-0}" = "1" ]; then
  doctor_toolchain_rows
  exit 0
fi

# ── --rebuild-ocr: retry the optional OCR helper build now, then exit ──
# Placed before the Chrome and credential steps below, which it does not need.
# It starts and stops no server and takes no start lock.
if [ "$REBUILD_OCR" = "1" ]; then
  rebuild_ocr_helper_if_needed force
  # One result line, from the same resolver: a usable helper means success, and
  # anything else names its reason and next action.
  OCR_RESULT_ROW="$(ocr_helper_status_row)" && OCR_RESULT_OK=1 || OCR_RESULT_OK=0
  if [ "$OCR_RESULT_OK" = "1" ]; then
    echo "✅ OCR helper ready (${OCR_RESULT_ROW#ocr helper: }): BotBoy can read text inside images and scanned PDFs" | tee -a "$LOG_FILE"
    exit 0
  fi
  echo "ℹ  $OCR_RESULT_ROW" | tee -a "$LOG_FILE"
  exit 1
fi

# Doctor rows for this machine. They never fail the doctor, and every warning
# says what to do.
DF_BIN="${BOTBOY_TEST_DF_BIN:-df}"
# Advice about the Node BotBoy runs on. The `node:` line at the top of the doctor already names the path
# and version, so this row exists only when there is something to say:
#  - a Node below 22: Node 20 reached end-of-life on 2026-04-30 and compiles BotBoy's database module on install,
#    which needs the Command Line Tools (design 5.9, F-F);
#  - a Node whose npm is 10.9.x (Node 22): that npm crashes on the FIRST `npm install` of this project (npm/cli#8261:
#    2 of 2 on a clean checkout; 0 of 2 when it only had to add packages to an installed tree, measured 2026-10-14),
#    so the row appears only while nothing is installed yet. A Mac whose BotBoy already runs gets no row
#    (scripts/node-runtime.sh › node_runtime_npm_known_bad; the evidence is in the map).
doctor_node_row() {
  local version major npm_version
  version="$("$NODE" --version 2>/dev/null)"
  major="${version#v}"
  major="${major%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] || return 0
  if [ "$major" -lt 22 ]; then
    echo "node advice: Node ${major} is end-of-life and compiles BotBoy's database module on install, which needs the Command Line Tools. Install Node 24 or newer from nodejs.org (the LTS download); its installer needs no other tools."
    return 0
  fi
  [ "$NODE_RUNTIME_LOADED" = "1" ] || return 0
  npm_version="$(node_runtime_npm_version "$NODE")"
  if [ -n "$npm_version" ] && node_runtime_npm_known_bad "$npm_version" && [ ! -f "$PROJ_DIR/node_modules/better-sqlite3/package.json" ]; then
    echo "node advice: this Node comes with npm ${npm_version}, which can fail the first install of BotBoy's packages with \"Cannot read properties of null (reading 'edgesOut')\", and none are installed yet. Install Node 24 or newer from nodejs.org (the LTS download), or update npm: npm install -g npm@11."
  fi
  return 0
}
doctor_machine_rows() {
  local ram_bytes ram_gb free_kb free_gb pressure level swap_text swap_gb swap_high chrome_state node_text
  if [ "$HW_ARM64" = "1" ]; then
    echo "hardware: Apple Silicon"
  else
    echo "hardware: Intel"
  fi
  if [ "$HW_ARM64" != "1" ]; then
    echo "this shell: native"
  elif [ "$SHELL_TRANSLATED" = "1" ]; then
    if [ "${BOTBOY_NO_ARCH_REEXEC:-0}" = "1" ]; then
      echo "this shell: translated (Rosetta) — BOTBOY_NO_ARCH_REEXEC=1 is set, so start.sh does not re-launch natively; unset it"
    else
      echo "this shell: translated (Rosetta) — start.sh could not re-launch natively; BotBoy runs slower. Open a native Terminal and run ./start.sh"
    fi
  elif [ -n "${BOTBOY_REEXEC_FROM:-}" ]; then
    echo "this shell: native (re-launched from a Rosetta shell)"
  else
    echo "this shell: native"
  fi
  if [ "$HW_ARM64" != "1" ]; then
    echo "chrome arch: not checked (Intel Mac)"
    echo "node arch: not checked (Intel Mac)"
  else
    if [ -z "$CHROME_ARCHS" ]; then
      echo "chrome arch: unknown"
    elif archs_include_arm64 "$CHROME_ARCHS"; then
      echo "chrome arch: $(printf '%s' "$CHROME_ARCHS" | sed 's/ /+/g') (runs native)"
    else
      echo "chrome arch: $CHROME_ARCHS only (Rosetta, 2-5x slower) — download Chrome for Mac with Apple chip from google.com/chrome and replace it"
    fi
    if [ -z "$NODE_ARCHS" ]; then
      node_text="unknown"
    elif archs_include_arm64 "$NODE_ARCHS"; then
      node_text="$(printf '%s' "$NODE_ARCHS" | sed 's/ /+/g') (runs native)"
    else
      node_text="$NODE_ARCHS only (Rosetta) — install an Apple-silicon Node (nodejs.org installer for Apple silicon, or Homebrew in /opt/homebrew)"
    fi
    echo "node arch: $node_text"
  fi
  ram_bytes="$("$SYSCTL_BIN" -n hw.memsize 2>/dev/null)"
  if [[ "$ram_bytes" =~ ^[0-9]+$ ]]; then
    ram_gb="$(awk -v b="$ram_bytes" 'BEGIN { printf "%.0f", b / 1073741824 }')"
    echo "RAM: ${ram_gb} GB"
  else
    ram_bytes=""
    echo "RAM: unknown"
  fi
  free_kb="$("$DF_BIN" -k "$HOME" 2>/dev/null | awk 'NR == 2 { print $4 }')"
  if [[ "$free_kb" =~ ^[0-9]+$ ]]; then
    free_gb="$(awk -v k="$free_kb" 'BEGIN { printf "%.1f", k / 1048576 }')"
    if [ "$free_kb" -lt 5242880 ]; then
      echo "free disk: ${free_gb} GB — WARN: free some space; BotBoy needs room for its database and Chrome profile"
    else
      echo "free disk: ${free_gb} GB"
    fi
  else
    echo "free disk: unknown"
  fi
  level="$("$SYSCTL_BIN" -n kern.memorystatus_vm_pressure_level 2>/dev/null)"
  case "$level" in
    1) pressure="normal" ;;
    2) pressure="warn" ;;
    4) pressure="critical" ;;
    *) pressure="" ;;
  esac
  case "$pressure" in
    normal) echo "memory pressure: normal" ;;
    warn|critical) echo "memory pressure: $pressure — close other apps or restart the Mac; BotBoy slows its browser capture while this lasts" ;;
    *) echo "memory pressure: unknown" ;;
  esac
  # Swap alone is normal on macOS. It warns only while memory pressure is up
  # and more than a quarter of RAM is swapped out.
  swap_text="$("$SYSCTL_BIN" -n vm.swapusage 2>/dev/null)"
  swap_gb="$(printf '%s\n' "$swap_text" | awk '{
    for (i = 1; i <= NF; i++) if ($i == "used" && $(i + 1) == "=") {
      v = $(i + 2); unit = substr(v, length(v)); n = substr(v, 1, length(v) - 1) + 0
      if (unit == "G") printf "%.1f", n; else if (unit == "M") printf "%.1f", n / 1024; else if (unit == "K") printf "%.1f", n / 1048576; else printf "%.1f", 0
    }
  }')"
  if [ -n "$swap_gb" ]; then
    swap_high=0
    if [ -n "$ram_bytes" ] && [ -n "$pressure" ] && [ "$pressure" != "normal" ]; then
      swap_high="$(awk -v s="$swap_gb" -v b="$ram_bytes" 'BEGIN { print (s * 1073741824 > b / 4) ? 1 : 0 }')"
    fi
    if [ "$swap_high" = "1" ]; then
      echo "swap used: ${swap_gb} GB — WARN: more than a quarter of RAM is swapped out while memory pressure is up; close other apps or restart the Mac"
    else
      echo "swap used: ${swap_gb} GB"
    fi
  else
    echo "swap used: unknown"
  fi
  chrome_state="$(running_debug_chrome_state)"
  case "$chrome_state" in
    native) echo "running debug Chrome: native" ;;
    translated) echo "running debug Chrome: translated (slow) — quit it and run ./start.sh again" ;;
    none) echo "running debug Chrome: not running" ;;
    *) echo "running debug Chrome: not checked" ;;
  esac
}

# ── BotBoy.app launcher ──────────────────────────────────────────────────────
# macOS starts a shell-script .app, and a compiled launcher with no arm64
# slice, under Rosetta unless Info.plist prefers arm64 (measured 2026-10-12:
# a plain script app ran with proc_translated=1 and passed it to every
# child; the same bundle with LSArchitecturePriority [arm64, x86_64] ran
# native).
#
# GENERIC LAUNCHER. The app has no folder path built in. It reads the folder it
# opens from ~/.personal-productivity-tracker/app-checkout.v1 (`checkout=<physical
# folder>`), so ONE prebuilt universal launcher serves every checkout, nothing is
# compiled on a teammate's Mac, and a folder that moves is followed: running
# ./start.sh from the new location re-points the file (the `claim` action). A
# generic launcher is recognized by BotBoyLauncherVersion in Info.plist (at least
# scripts/native-prebuilt.mjs › LAUNCHER_VERSION) AND no path embedded in its
# executable; anything else is an older per-Mac launcher.
#
# The plan below is a pure function of facts (so the table is testable). It never
# deletes a bundle and never replaces a working native launcher with the shell
# fallback. Facts: the file kind and slices (`file -b`, Apple Silicon only; an
# Intel Mac reads nothing from the executable: kind=unread), the Info.plist keys,
# the ownership grep, and one Node call (scripts/native-prebuilt.mjs
# launcher-facts) for the manifest and prebuilt state, the recorded folder and any
# embedded path. A second call adds the execution smoke, only when the plan could
# reach "migrate". If Node or the module cannot answer, the plan is `none` (except
# `create`): a bundle that cannot be judged is left alone.
#
# Bundle action, first matching row wins:
#   1  no bundle, or no executable                                 create
#   2  kind unknown                                                none
#   3  not owned by this folder                                    none
#        owned: an older launcher with this folder's start.sh embedded (logical or
#        physical path) or whose embedded folder is gone; a generic one that
#        records this folder, nothing, or a folder whose start.sh is gone
#   4  owned, generic, native executable                           patch_plist when the
#        architecture key is wrong on Apple Silicon, else none
#   5  owned, an older launcher or the script fallback, and --foreground: no swap
#        (the app that is running may be this very launcher): row 8
#   6  ... a recorded failure matches the launcher, builder and manifest
#        signatures                                                warn_harmless
#   7  ... a native launcher is obtainable (the prebuilt one runs here, or a
#        Swift toolchain exists)                                   migrate
#   8  otherwise the earlier rules, Apple Silicon only: an Intel-only compiled
#        launcher warn_harmless, a wrong architecture key patch_plist, else none
# Recorded-folder action (generic launchers only, independent of the row):
#   claim when nothing is recorded or the recorded start.sh is gone; never while
#   another folder's start.sh exists (the app belongs to that checkout).
APP_BUNDLE="${BOTBOY_TEST_APP_BUNDLE:-/Applications/BotBoy.app}"
PLISTBUDDY_BIN="${BOTBOY_TEST_PLISTBUDDY_BIN:-/usr/libexec/PlistBuddy}"
LSREGISTER_BIN="${BOTBOY_TEST_LSREGISTER_BIN:-/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister}"
NATIVE_PREBUILT_JS="$PROJ_DIR/scripts/native-prebuilt.mjs"
APP_EXISTS=0
APP_KIND=none
APP_ARCHS=""
APP_PRIORITY0=""
APP_VERSION=""
APP_FACTS_OK=0
APP_WANT_VERSION=""
APP_PREBUILT=unchecked
APP_PREBUILT_REASON=""
APP_PREBUILT_DETAIL=""
APP_MATCHES_PREBUILT=0
APP_INSTALLED_SMOKE=unchecked
APP_RECORDED=""
APP_RECORDED_LIVE=0
APP_BAKED=""
APP_BAKED_LIVE=0
APP_LEGACY=0
APP_GENERIC=0
APP_OWNED=0
APP_TOOLCHAIN=0
APP_MARKER_BLOCKS=0
APP_PLAN=none
APP_CHECKOUT_ACTION=none
APP_PLIST_CHANGED=0

app_launcher_marker_file() {
  printf '%s/.personal-productivity-tracker/app-launcher.v1' "$HOME"
}

# `size:mtime` of a file, or empty.
app_file_signature() {
  stat -f '%z:%m' "$1" 2>/dev/null || true
}

# A failed upgrade is recorded with the launcher, builder script and prebuilt
# manifest it saw, so a start never retries the same failure: it waits for one of
# the three to change.
app_launcher_marker_blocks() {
  local marker launcher_sig builder_sig manifest_sig recorded_launcher recorded_builder recorded_manifest recorded_result
  marker="$(app_launcher_marker_file)"
  [ -f "$marker" ] || return 1
  launcher_sig="$(app_file_signature "$APP_BUNDLE/Contents/MacOS/BotBoy")"
  builder_sig="$(app_file_signature "$PROJ_DIR/scripts/make-app-bundle.mjs")"
  manifest_sig="$(app_file_signature "$PROJ_DIR/native/prebuilt-manifest.json")"
  recorded_launcher="$(sed -n 's/^launcher=//p' "$marker" | head -n 1)"
  recorded_builder="$(sed -n 's/^builder=//p' "$marker" | head -n 1)"
  recorded_manifest="$(sed -n 's/^manifest=//p' "$marker" | head -n 1)"
  recorded_result="$(sed -n 's/^result=//p' "$marker" | head -n 1)"
  [ "$recorded_result" = "failed" ] || return 1
  [ -n "$launcher_sig" ] && [ "$recorded_launcher" = "$launcher_sig" ] && [ "$recorded_builder" = "$builder_sig" ] && [ "$recorded_manifest" = "$manifest_sig" ]
}

# The reason code the last failed upgrade recorded (empty when none).
app_launcher_marker_reason() {
  sed -n 's/^reason=//p' "$(app_launcher_marker_file)" 2>/dev/null | head -n 1
}

# $1 = ok | failed, $2 = the builder's reason code (failed only).
app_launcher_marker_write() {
  local marker
  marker="$(app_launcher_marker_file)"
  mkdir -p "$(dirname "$marker")" 2>/dev/null || return 0
  {
    echo "launcher=$(app_file_signature "$APP_BUNDLE/Contents/MacOS/BotBoy")"
    echo "builder=$(app_file_signature "$PROJ_DIR/scripts/make-app-bundle.mjs")"
    echo "manifest=$(app_file_signature "$PROJ_DIR/native/prebuilt-manifest.json")"
    echo "result=$1"
    [ -z "${2:-}" ] || echo "reason=$2"
    echo "date=$(date '+%Y-%m-%dT%H:%M:%S')"
  } > "$marker" 2>/dev/null || true
}

# What a builder reason code means for the owner, in one clause.
app_launcher_reason_words() {
  case "$1" in
    os_too_old) echo "this Mac's macOS is older than the prebuilt launcher needs (macOS 13)" ;;
    launcher_smoke_failed|launcher_codesign_failed|launcher_quarantined) echo "macOS would not run the new launcher on this Mac" ;;
    launcher_corrupt|launcher_missing|manifest_missing|manifest_invalid|native_prebuilt_module_missing) echo "the prebuilt launcher in this folder is missing or damaged; run ./start.sh --update" ;;
    no_toolchain) echo "no prebuilt launcher runs here and there are no developer tools to build one" ;;
    app_not_writable) echo "macOS did not allow changes inside $APP_BUNDLE; remove it and run ./start.sh again" ;;
    checkout_file_failed|backup_failed) echo "BotBoy could not write to ~/.personal-productivity-tracker" ;;
    readback_failed|swap_failed) echo "the new launcher did not check out once it was in place, so the previous one was put back" ;;
    restore_failed) echo "the new launcher did not check out and the previous one could not be put back automatically; its copies are in ~/.personal-productivity-tracker/app-launcher-backup" ;;
    start_script_missing) echo "start.sh is missing or not executable in this folder" ;;
    "") echo "see $LOG_FILE" ;;
    *) echo "$1" ;;
  esac
}

# Read `launcher-facts` into the APP_* variables (never eval; a key we do not
# know is ignored). $1 = --smoke to include the execution smoke. Returns 1 when
# Node or the module cannot answer; facts already read are kept.
app_read_node_facts() {
  local output key value
  [ -f "$NATIVE_PREBUILT_JS" ] || return 1
  output="$(native_exec "$NODE" "$NATIVE_PREBUILT_JS" launcher-facts --app "$APP_BUNDLE" --checkout "$PROJ_DIR" $1 2>/dev/null)" || return 1
  [ -n "$output" ] || return 1
  while IFS='=' read -r key value; do
    case "$key" in
      prebuilt_usable) APP_PREBUILT="$value" ;;
      prebuilt_reason) APP_PREBUILT_REASON="$value" ;;
      prebuilt_detail) APP_PREBUILT_DETAIL="$value" ;;
      want_version) APP_WANT_VERSION="$value" ;;
      installed_matches_prebuilt) APP_MATCHES_PREBUILT="$value" ;;
      installed_smoke) APP_INSTALLED_SMOKE="$value" ;;
      recorded_checkout) APP_RECORDED="$value" ;;
      recorded_live) APP_RECORDED_LIVE="$value" ;;
      legacy_baked_path) APP_BAKED="$value" ;;
      legacy_baked_live) APP_BAKED_LIVE="$value" ;;
    esac
  done <<EOF
$output
EOF
  case "$APP_WANT_VERSION" in ''|*[!0-9]*) return 1 ;; esac
  APP_FACTS_OK=1
  return 0
}

# Older launcher or script fallback: something a migration could replace.
app_upgradable() {
  [ "$APP_LEGACY" = "1" ] && return 0
  [ "$APP_GENERIC" = "1" ] && [ "$APP_KIND" = "script" ] && return 0
  return 1
}

# Derive generic/older and ownership from the facts (pure; needs APP_FACTS_OK=1).
app_classify() {
  local exe="$APP_BUNDLE/Contents/MacOS/BotBoy" physical
  APP_LEGACY=0
  APP_GENERIC=0
  APP_OWNED=0
  [ "$APP_FACTS_OK" = "1" ] || return 0
  physical="$(cd "$PROJ_DIR" 2>/dev/null && pwd -P)"
  # A path embedded in the executable, or a marker below the wanted version, is an older launcher
  # (a new Info.plist beside an old executable, left by an interrupted swap, counts as older too).
  if [ -n "$APP_BAKED" ] || [ -z "$APP_VERSION" ] || [ "$APP_VERSION" -lt "$APP_WANT_VERSION" ]; then
    APP_LEGACY=1
  else
    APP_GENERIC=1
  fi
  if [ -n "$APP_BAKED" ]; then
    # grep reads a Mach-O and a script alike; the embedded folder being gone makes it claimable.
    if grep -aqF "$PROJ_DIR/start.sh" "$exe" 2>/dev/null || { [ -n "$physical" ] && grep -aqF "$physical/start.sh" "$exe" 2>/dev/null; }; then
      APP_OWNED=1
    elif [ "$APP_BAKED_LIVE" != "1" ]; then
      APP_OWNED=1
    fi
  else
    # Opens the recorded folder: ours when it is this folder, empty, or its start.sh is gone.
    if [ -z "$APP_RECORDED" ] || [ "$APP_RECORDED_LIVE" != "1" ] || [ "$APP_RECORDED" = "$physical" ] || [ "$APP_RECORDED" = "$PROJ_DIR" ]; then
      APP_OWNED=1
    fi
  fi
  return 0
}

# Gather the facts. On Intel nothing is read from the executable (kind=unread).
app_launcher_facts() {
  local exe plist description
  APP_EXISTS=0
  APP_KIND=none
  APP_ARCHS=""
  APP_PRIORITY0=""
  APP_VERSION=""
  APP_FACTS_OK=0
  APP_WANT_VERSION=""
  APP_PREBUILT=unchecked
  APP_PREBUILT_REASON=""
  APP_PREBUILT_DETAIL=""
  APP_MATCHES_PREBUILT=0
  APP_INSTALLED_SMOKE=unchecked
  APP_RECORDED=""
  APP_RECORDED_LIVE=0
  APP_BAKED=""
  APP_BAKED_LIVE=0
  APP_LEGACY=0
  APP_GENERIC=0
  APP_OWNED=0
  APP_TOOLCHAIN=0
  APP_MARKER_BLOCKS=0
  [ -d "$APP_BUNDLE" ] || return 0
  APP_EXISTS=1
  exe="$APP_BUNDLE/Contents/MacOS/BotBoy"
  plist="$APP_BUNDLE/Contents/Info.plist"
  if [ ! -f "$exe" ]; then
    APP_KIND=missing
    return 0
  fi
  if [ "$HW_ARM64" = "1" ]; then
    description="$("$FILE_BIN" -b "$exe" 2>/dev/null)"
    case "$description" in
      Mach-O*) APP_KIND=macho; APP_ARCHS="$(file_description_archs "$description")" ;;
      *script*|*text*) APP_KIND=script ;;
      *) APP_KIND=unknown ;;
    esac
    APP_PRIORITY0="$("$PLISTBUDDY_BIN" -c 'Print :LSArchitecturePriority:0' "$plist" 2>/dev/null || true)"
  else
    APP_KIND=unread
  fi
  [ "$APP_KIND" != "unknown" ] || return 0
  APP_VERSION="$("$PLISTBUDDY_BIN" -c 'Print :BotBoyLauncherVersion' "$plist" 2>/dev/null || true)"
  case "$APP_VERSION" in *[!0-9]*) APP_VERSION="" ;; esac
  app_read_node_facts || return 0
  app_classify
  app_launcher_marker_blocks && APP_MARKER_BLOCKS=1
  # Whether a native launcher can be had is asked only when the plan could reach it: the execution
  # smoke of the prebuilt launcher costs about a second.
  if [ "$APP_OWNED" = "1" ] && [ "$FOREGROUND" != "1" ] && [ "$APP_MARKER_BLOCKS" != "1" ] && app_upgradable; then
    if [ "$APP_PREBUILT" = "unchecked" ]; then
      app_read_node_facts --smoke || true
    fi
    if [ "$APP_PREBUILT" != "1" ] && clt_toolchain_ok; then
      APP_TOOLCHAIN=1
    fi
  fi
  return 0
}

# Pure: APP_PLAN is create | patch_plist | migrate | warn_harmless | none, and
# APP_CHECKOUT_ACTION is none | claim (see the table above).
app_launcher_plan() {
  APP_PLAN=none
  APP_CHECKOUT_ACTION=none
  if [ "$APP_EXISTS" != "1" ] || [ "$APP_KIND" = "missing" ]; then
    APP_PLAN=create
    return 0
  fi
  [ "$APP_FACTS_OK" = "1" ] || return 0
  [ "$APP_KIND" != "unknown" ] || return 0
  [ "$APP_OWNED" = "1" ] || return 0
  if [ "$APP_GENERIC" = "1" ] && { [ -z "$APP_RECORDED" ] || [ "$APP_RECORDED_LIVE" != "1" ]; }; then
    APP_CHECKOUT_ACTION=claim
  fi
  if [ "$APP_GENERIC" = "1" ] && [ "$APP_KIND" != "script" ]; then
    [ "$HW_ARM64" = "1" ] && [ "$APP_PRIORITY0" != "arm64" ] && APP_PLAN=patch_plist
    return 0
  fi
  if [ "$FOREGROUND" != "1" ]; then
    if [ "$APP_MARKER_BLOCKS" = "1" ]; then
      APP_PLAN=warn_harmless
      return 0
    fi
    if [ "$APP_PREBUILT" = "1" ] || [ "$APP_TOOLCHAIN" = "1" ]; then
      APP_PLAN=migrate
      return 0
    fi
  fi
  # Row 8, the earlier rules for a launcher that stays as it is (Apple Silicon only).
  [ "$HW_ARM64" = "1" ] || return 0
  if [ "$APP_KIND" = "macho" ] && [ -n "$APP_ARCHS" ] && ! archs_include_arm64 "$APP_ARCHS"; then
    APP_PLAN=warn_harmless
  elif [ "$APP_PRIORITY0" != "arm64" ]; then
    APP_PLAN=patch_plist
  fi
  return 0
}

# Make Info.plist prefer arm64 without a compiler. Idempotent and atomic: the
# change is made on a copy, verified by READING it back (PlistBuddy's exit
# codes are not trusted), and moved over the original in one rename. The
# temporary copy never outlives the call. Returns 0 when the plist is right
# afterwards, 1 otherwise; APP_PLIST_CHANGED=1 when it had to be changed.
patch_app_plist_arch() {
  local plist="$APP_BUNDLE/Contents/Info.plist" temp first second third
  APP_PLIST_CHANGED=0
  [ -f "$plist" ] || return 1
  first="$("$PLISTBUDDY_BIN" -c 'Print :LSArchitecturePriority:0' "$plist" 2>/dev/null || true)"
  [ "$first" = "arm64" ] && return 0
  temp="$plist.botboy-new"
  rm -f "$temp"
  cp "$plist" "$temp" 2>/dev/null || { rm -f "$temp"; return 1; }
  "$PLISTBUDDY_BIN" -c 'Delete :LSArchitecturePriority' "$temp" >/dev/null 2>&1 || true
  "$PLISTBUDDY_BIN" -c 'Add :LSArchitecturePriority array' -c 'Add :LSArchitecturePriority:0 string arm64' -c 'Add :LSArchitecturePriority:1 string x86_64' "$temp" >/dev/null 2>&1 || true
  first="$("$PLISTBUDDY_BIN" -c 'Print :LSArchitecturePriority:0' "$temp" 2>/dev/null || true)"
  second="$("$PLISTBUDDY_BIN" -c 'Print :LSArchitecturePriority:1' "$temp" 2>/dev/null || true)"
  third="$("$PLISTBUDDY_BIN" -c 'Print :LSArchitecturePriority:2' "$temp" 2>/dev/null || true)"
  if [ "$first" != "arm64" ] || [ "$second" != "x86_64" ] || [ -n "$third" ]; then
    rm -f "$temp"
    return 1
  fi
  if ! mv -f "$temp" "$plist" 2>/dev/null; then
    rm -f "$temp"
    return 1
  fi
  rm -f "$temp"
  first="$("$PLISTBUDDY_BIN" -c 'Print :LSArchitecturePriority:0' "$plist" 2>/dev/null || true)"
  [ "$first" = "arm64" ] || return 1
  APP_PLIST_CHANGED=1
  touch "$APP_BUNDLE" 2>/dev/null || true
  if [ -f "$APP_BUNDLE/Contents/MacOS/BotBoy" ]; then
    "$LSREGISTER_BIN" -f "$APP_BUNDLE" >/dev/null 2>&1 || true
  fi
  return 0
}

# Record this folder (its physical path) as the one BotBoy.app opens: a temporary
# file, then a rename, mode 0600 in the data folder (created 0700 when missing).
# The format is the one scripts/native-prebuilt.mjs › writeCheckoutFile writes and the
# launcher reads. Returns 1 when it cannot be written; nothing is left behind.
write_app_checkout_file() {
  local physical dir file temp
  physical="$(cd "$PROJ_DIR" 2>/dev/null && pwd -P)"
  case "$physical" in /*) ;; *) return 1 ;; esac
  [ "${#physical}" -lt 4096 ] || return 1
  case "$physical" in *[[:cntrl:]]*) return 1 ;; esac
  dir="$HOME/.personal-productivity-tracker"
  file="$dir/app-checkout.v1"
  temp="$file.$$.tmp"
  ( umask 077; mkdir -p "$dir" ) 2>/dev/null || return 1
  ( umask 077; printf 'checkout=%s\nwritten=%s\n' "$physical" "$(date '+%Y-%m-%dT%H:%M:%S')" > "$temp" ) 2>/dev/null || { rm -f "$temp"; return 1; }
  if ! mv -f "$temp" "$file" 2>/dev/null; then
    rm -f "$temp"
    return 1
  fi
  return 0
}

apply_app_launcher_plan() {
  local builder="$PROJ_DIR/scripts/make-app-bundle.mjs" output status reason
  # The recorded folder lives outside the bundle, so it is written in every mode (--foreground too).
  if [ "$APP_CHECKOUT_ACTION" = "claim" ]; then
    if write_app_checkout_file; then
      echo "ℹ️  BotBoy.app now opens this folder ($PROJ_DIR)" | tee -a "$LOG_FILE"
    else
      echo "ℹ️  Could not record this folder for BotBoy.app (is ~/.personal-productivity-tracker writable?); the app keeps what it had" | tee -a "$LOG_FILE"
    fi
  fi
  case "$APP_PLAN" in
    create)
      echo "ℹ️  Installing BotBoy.app into $(dirname "$APP_BUNDLE") (first run)"
      if native_exec "$NODE" "$builder" --dest "$APP_BUNDLE" >> "$LOG_FILE" 2>&1; then
        echo "✅ BotBoy.app installed — launch from Spotlight or the Dock next time"
      else
        echo "⚠️  Could not install BotBoy.app (see $LOG_FILE) — run: npm run app:bundle"
      fi
      ;;
    patch_plist)
      if patch_app_plist_arch; then
        [ "$APP_PLIST_CHANGED" = "1" ] && echo "ℹ️  BotBoy.app now prefers Apple Silicon; this takes effect at the next app launch: quit and reopen BotBoy" | tee -a "$LOG_FILE"
      else
        echo "ℹ️  Could not update BotBoy.app's architecture setting (harmless: start.sh still runs BotBoy natively)" | tee -a "$LOG_FILE"
      fi
      ;;
    migrate)
      if [ "$APP_PREBUILT" = "1" ]; then
        echo "ℹ️  Upgrading BotBoy.app's launcher so it follows this folder (prebuilt, no developer tools needed)" | tee -a "$LOG_FILE"
      else
        echo "ℹ️  Upgrading BotBoy.app's launcher so it follows this folder (building it on this Mac)" | tee -a "$LOG_FILE"
      fi
      output="$(native_exec "$NODE" "$builder" --launcher-only --dest "$APP_BUNDLE" 2>&1)"
      status=$?
      printf '%s\n' "$output" >> "$LOG_FILE"
      if [ "$status" = "0" ]; then
        app_launcher_marker_write ok
        # The builder wrote the architecture key where it belongs (Apple Silicon only); this only confirms it.
        [ "$HW_ARM64" != "1" ] || patch_app_plist_arch || true
        echo "✅ BotBoy.app upgraded; this takes effect at the next app launch: quit and reopen BotBoy" | tee -a "$LOG_FILE"
      else
        reason="$(printf '%s\n' "$output" | sed -n 's/^reason=//p' | tail -n 1)"
        app_launcher_marker_write failed "$reason"
        if [ "$reason" = "restore_failed" ]; then
          echo "ℹ️  BotBoy.app's launcher could not be upgraded ($(app_launcher_reason_words "$reason")). Next: remove $APP_BUNDLE and run ./start.sh to build it again" | tee -a "$LOG_FILE"
        else
          echo "ℹ️  BotBoy.app's launcher could not be upgraded ($(app_launcher_reason_words "$reason")); the current one keeps working. Next: ./start.sh --doctor" | tee -a "$LOG_FILE"
        fi
      fi
      ;;
    warn_harmless)
      if [ "$APP_KIND" = "macho" ] && [ -n "$APP_ARCHS" ] && ! archs_include_arm64 "$APP_ARCHS"; then
        echo "ℹ️  BotBoy.app's launcher is the Intel build and starts translated; harmless, because start.sh re-launches BotBoy natively" | tee -a "$LOG_FILE"
      else
        echo "ℹ️  BotBoy.app's launcher is the older per-Mac build and the last upgrade did not work here ($(app_launcher_reason_words "$(app_launcher_marker_reason)")); it keeps working. Next: ./start.sh --doctor" | tee -a "$LOG_FILE"
      fi
      ;;
  esac
  return 0
}

# The architecture-priority words of the doctor row.
app_priority_words() {
  if [ "$APP_PRIORITY0" = "arm64" ]; then
    echo "arm64 first"
  elif [ "$APP_KIND" = "macho" ] && archs_include_arm64 "$APP_ARCHS"; then
    echo "missing (harmless for a compiled launcher with an arm64 slice; start.sh adds the key on its next start)"
  else
    echo "missing (the app itself starts translated; BotBoy's own processes are still native because start.sh re-launches natively; start.sh adds the key on its next start)"
  fi
}

doctor_app_launcher_row() {
  local what opens arch_words="" line
  app_launcher_facts
  if [ "$APP_EXISTS" != "1" ] || [ "$APP_KIND" = "missing" ]; then
    echo "app launcher: not installed (./start.sh installs it on its first successful start)"
    return 0
  fi
  if [ "$APP_KIND" = "unknown" ]; then
    echo "app launcher: unknown; architecture priority: $(app_priority_words)"
    return 0
  fi
  if [ "$APP_FACTS_OK" != "1" ]; then
    echo "app launcher: unknown (the check could not run; run ./start.sh --update)"
    return 0
  fi
  # The installed file is run (print-target mode) only when it is byte-identical to the prebuilt launcher:
  # an older launcher has no such mode and would start the app.
  if [ "$APP_MATCHES_PREBUILT" = "1" ]; then
    app_read_node_facts --smoke || true
  fi
  if [ "$APP_KIND" = "macho" ]; then
    if [ -z "$APP_ARCHS" ]; then
      arch_words=""
    elif archs_include_arm64 "$APP_ARCHS"; then
      case " $APP_ARCHS " in
        *" x86_64 "*) arch_words="universal" ;;
        *) arch_words="arm64" ;;
      esac
    else
      arch_words="x86_64 only"
    fi
  fi
  if [ "$APP_GENERIC" = "1" ]; then
    if [ "$APP_MATCHES_PREBUILT" = "1" ]; then
      what="prebuilt universal (v$APP_VERSION)"
    elif [ "$APP_KIND" = "script" ]; then
      what="shell script (v$APP_VERSION)"
    elif [ "$APP_KIND" = "macho" ]; then
      what="compiled on this Mac (v$APP_VERSION${arch_words:+, $arch_words})"
    else
      what="launcher (v$APP_VERSION)"
    fi
    if [ -z "$APP_RECORDED" ]; then
      opens="no folder is recorded yet (run ./start.sh in the BotBoy folder to record it)"
    elif [ "$APP_RECORDED_LIVE" != "1" ]; then
      opens="its folder is gone ($APP_RECORDED): run ./start.sh here to reconnect it"
    elif [ "$APP_OWNED" = "1" ]; then
      opens="opens $APP_RECORDED"
    else
      opens="opens another folder ($APP_RECORDED): run ./start.sh there, or remove $APP_BUNDLE and run ./start.sh here"
    fi
  else
    case "$APP_KIND" in
      script) what="older script launcher" ;;
      macho) what="older compiled launcher${arch_words:+ ($arch_words)}" ;;
      *) what="older launcher" ;;
    esac
    if [ "$APP_OWNED" != "1" ]; then
      opens="belongs to another folder${APP_BAKED:+ ($APP_BAKED)}"
    elif [ "$APP_MARKER_BLOCKS" = "1" ]; then
      opens="the last upgrade did not work here ($(app_launcher_reason_words "$(app_launcher_marker_reason)")); it keeps working"
    else
      opens="upgrades at the next ./start.sh"
    fi
  fi
  line="app launcher: $what; $opens"
  [ "$HW_ARM64" != "1" ] || line="$line; architecture priority: $(app_priority_words)"
  case "$APP_INSTALLED_SMOKE" in
    ok) line="$line; smoke ok" ;;
    failed*) line="$line; smoke FAILED (${APP_INSTALLED_SMOKE#failed: }): run ./start.sh --update, or remove $APP_BUNDLE and run ./start.sh" ;;
  esac
  echo "$line"
}

# Self-heal the Dock/Applications launcher: build /Applications/BotBoy.app on
# the first start after a clone (or after someone deletes the app), upgrade an
# older launcher to the generic prebuilt one, keep the recorded folder current, and on
# Apple Silicon keep an existing one starting natively (app_launcher_plan).
# Runs after the dashboard is already open so it never delays startup, and a
# failure never breaks the tracker: the app is cosmetic + lifecycle
# convenience, not a runtime dependency. It never swaps a launcher in --foreground
# (the app that is running may be this very launcher).
install_app_bundle_if_missing() {
  [ -f "$PROJ_DIR/scripts/make-app-bundle.mjs" ] || return 0
  app_launcher_facts
  app_launcher_plan
  apply_app_launcher_plan
}

# Executable test hooks. They read the facts and print them; the apply hook
# runs the real flow against BOTBOY_TEST_APP_BUNDLE only.
if [ "${BOTBOY_TEST_DOCTOR_NODE:-0}" = "1" ]; then
  doctor_node_row
  exit 0
fi
if [ "${BOTBOY_TEST_DOCTOR_MACHINE:-0}" = "1" ]; then
  doctor_machine_rows
  exit 0
fi
if [ "${BOTBOY_TEST_APP_LAUNCHER_PLAN:-0}" = "1" ]; then
  app_launcher_facts
  app_launcher_plan
  echo "plan=$APP_PLAN"
  echo "checkout_action=$APP_CHECKOUT_ACTION"
  echo "kind=$APP_KIND archs=$APP_ARCHS priority=$APP_PRIORITY0 version=$APP_VERSION facts_ok=$APP_FACTS_OK legacy=$APP_LEGACY generic=$APP_GENERIC owned=$APP_OWNED prebuilt=$APP_PREBUILT toolchain=$APP_TOOLCHAIN marker_blocks=$APP_MARKER_BLOCKS"
  exit 0
fi
if [ "${BOTBOY_TEST_APP_PLIST_PATCH:-0}" = "1" ]; then
  patch_app_plist_arch
  status=$?
  echo "patch_status=$status changed=$APP_PLIST_CHANGED"
  exit 0
fi
if [ "${BOTBOY_TEST_DOCTOR_APP:-0}" = "1" ]; then
  doctor_app_launcher_row
  exit 0
fi
if [ "${BOTBOY_TEST_APP_LAUNCHER_APPLY:-0}" = "1" ]; then
  install_app_bundle_if_missing
  exit 0
fi

# Settings → AI model rows of --doctor (the BOTBOY_TEST_DOCTOR_AI_MODEL hook runs them alone). Node reads the keys
# in its own memory and prints only their last four characters plus the HTTP status of each provider's free
# model-list probe; no key enters this shell, argv, or the output. Every probe uses Node's fetch, the network path the
# app itself takes (curl would follow proxy variables that the app does not read). The Claude probe sends the headers
# the app sends (anthropic-models.ts › AUTH_STYLE / ANTHROPIC_VERSION) and follows no redirect, so the key never goes to
# another address. Tests point it at a loopback stand-in with BOTBOY_TEST_ANTHROPIC_PROBE_URL (production never sets
# it): only http://127.0.0.1:<port> is accepted, and any other value sends nothing.
doctor_ai_model_rows() {
  if [ -f "$AI_MODEL_SETTINGS_FILE" ]; then
    "$NODE" -e '
      const fs = require("fs");
      const file = process.argv[1];
      const probeOverride = process.argv[2] || "";
      const anthropicOrigin = !probeOverride ? "https://api.anthropic.com"
        : /^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(probeOverride) ? probeOverride : "";
      const mode = (fs.statSync(file).mode & 0o777).toString(8);
      let value;
      try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      const pattern = /^sk-[A-Za-z0-9_-]{16,400}$/;
      // Same rule as anthropic-models.ts › ANTHROPIC_KEY_PATTERN: a regular key, never an Admin key.
      const claudePattern = /^sk-ant-(?!admin)[A-Za-z0-9]+-[A-Za-z0-9_-]{16,400}$/;
      const keys = {};
      if (value && value.schemaVersion === 1 && value.provider === "openai") keys.openai = value.apiKey;
      if (value && value.schemaVersion === 2 && value.keys) {
        keys.openai = value.keys.openai && value.keys.openai.apiKey;
        keys.deepseek = value.keys.deepseek && value.keys.deepseek.apiKey;
        keys.anthropic = value.keys.anthropic && value.keys.anthropic.apiKey;
      }
      const probes = [
        ["openai", "OpenAI", "https://api.openai.com/v1/models", "api.openai.com", pattern],
        ["deepseek", "DeepSeek", "https://api.deepseek.com/models", "api.deepseek.com", pattern],
        ["anthropic", "Anthropic (Claude)", `${anthropicOrigin}/v1/models?limit=1`, "api.anthropic.com", claudePattern],
      ].filter(([id, , , , shape]) => typeof keys[id] === "string" && shape.test(keys[id]));
      if (!value || (!probes.length && !(value.roles && Object.keys(value.roles).length))) {
        console.log(`ai-model: Settings file is unreadable (mode ${mode}) — save the key again in Settings → AI model`);
        process.exit(0);
      }
      for (const [id, label] of probes) console.log(`ai-model: ${label} key …${keys[id].slice(-4)} saved in Settings (mode ${mode})`);
      if (!probes.length) console.log(`ai-model: no API key saved; background model choices only (mode ${mode})`);
      const roles = value.roles || {};
      // A hand-edited choice is printed as written, except that anything shaped like a key is masked.
      const shown = text => String(text).replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-…").slice(0, 200);
      const choice = role => shown((roles[role] && roles[role].modelKey) || "automatic");
      console.log(`ai-model: organizing model ${choice("processing")}; document writing ${choice("documents")}`);
      // Claude: the app headers (anthropic-models.ts › AUTH_STYLE, ANTHROPIC_VERSION) and no redirect followed.
      // OpenAI and DeepSeek: a bearer header, as before.
      const request = (id, key) => (id === "anthropic"
        ? { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, redirect: "manual" }
        : { headers: { Authorization: `Bearer ${key}` } });
      Promise.all(probes.map(([id, label, url, host]) => (id === "anthropic" && !anthropicOrigin
        ? Promise.resolve(`${id} probe: not sent (BOTBOY_TEST_ANTHROPIC_PROBE_URL accepts only http://127.0.0.1:<port>)`)
        : fetch(url, { ...request(id, keys[id]), signal: AbortSignal.timeout(10000) })
          .then(response => `${id} probe: HTTP ${response.status} (200=key works, 401=key rejected)`)
          .catch(() => `${id} probe: HTTP 000 (network, proxy, or VPN blocks ${host})`))))
        .then(lines => lines.forEach(line => console.log(line)));
    ' "$AI_MODEL_SETTINGS_FILE" "${BOTBOY_TEST_ANTHROPIC_PROBE_URL:-}" 2>/dev/null || echo "ai-model: could not inspect the Settings file"
  else
    echo "ai-model: no API key saved (add an OpenAI, DeepSeek or Anthropic (Claude) key in Settings → AI model)"
  fi
}

# Teammate machines run the LLM through the gateway with per-person OAuth
# credentials. When neither those nor a Bedrock key are present, BotBoy still
# runs but chat/synthesis are dead — say so at startup instead of letting the
# owner debug "BotBoy has no LLM" from a screenshot. Owner machines with any
# credential source stay silent.
warn_if_no_llm_credentials() {
  # An OpenAI, DeepSeek or Anthropic (Claude) key saved in Settings → AI model powers BotBoy on its
  # own. grep -q only tests for a key field; nothing is read into the shell.
  [ -s "$AI_MODEL_SETTINGS_FILE" ] && grep -q '"apiKey"' "$AI_MODEL_SETTINGS_FILE" 2>/dev/null && return 0
  [ -n "${AWS_BEARER_TOKEN_BEDROCK:-}" ] && return 0
  [ -n "${BOTBOY_INFERENCE_API_KEY:-}" ] && return 0
  if [ -n "${BOTBOY_INFERENCE_OAUTH_CLIENT_ID:-}" ] \
    && [ -n "${BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET:-}" ]; then
    return 0
  fi
  echo "⚠️  No AI model set up yet — chat and background organizing stay off until you add one."
  echo "    In BotBoy, open Settings → AI model and paste an OpenAI, DeepSeek or Anthropic (Claude) API key (it takes effect right away)."
  echo "    Or, if the owner sent you a botboy-credentials file, put it in ~/Downloads and re-run ./start.sh."
}

if [ "${BOTBOY_TEST_DOCTOR_AI_MODEL:-0}" = "1" ]; then
  doctor_ai_model_rows
  exit 0
fi
if [ "${BOTBOY_TEST_LLM_WARNING:-0}" = "1" ]; then
  warn_if_no_llm_credentials
  exit 0
fi
print_native_modules_failure() {
  local status="$1"
  echo "❌ BotBoy did not start: its native modules do not work with Node $("$NODE" --version 2>/dev/null) (npm $(npm --version 2>/dev/null))."
  printf '%s\n' "$status" | grep -v '|ok$' | sed 's/|/: /; s/^/    /'
  echo "    BotBoy never opened its database, so nothing needs recovery."
  if [ "$NODE_SOURCE" = "private" ]; then
    # BotBoy's own Node is on PATH only inside ./start.sh, so "run npm install" would not work from the user's shell.
    echo "    Next: read the last lines of $LOG_FILE (npm install ran with BotBoy's own Node), then run ./start.sh again; if it repeats, send ./start.sh --doctor to the owner."
  else
    echo "    Next: run npm install in $PROJ_DIR, read its last errors, then ./start.sh."
  fi
  if [ "$HW_ARM64" = "1" ]; then
    case "$NODE_ARCHS" in
      "") ;;
      *) if archs_include_arm64 "$NODE_ARCHS"; then
           echo "    This Mac is Apple Silicon and Node is native ($NODE_ARCHS); native modules must be built for arm64."
         else
           echo "    This Mac is Apple Silicon but this Node is the Intel build ($NODE_ARCHS): install an Apple-silicon Node, then npm install."
         fi ;;
    esac
  fi
  echo "    On Node 20, better-sqlite3 is built from source and needs Xcode Command Line Tools (xcode-select --install); Node 22, 24, and 26 use a prebuilt copy."
}

# Executable test hook for the native check. Prints its lines; changes only
# the spawn-helper mode, and only in `repair`.
if [ -n "${BOTBOY_TEST_NATIVE_STATUS:-}" ]; then
  native_modules_status "$BOTBOY_TEST_NATIVE_STATUS"
  exit $?
fi
# BOTBOY_TEST_NATIVE_FAILURE="<status lines>" prints the message a failed native check ends a start with.
if [ -n "${BOTBOY_TEST_NATIVE_FAILURE:-}" ]; then
  print_native_modules_failure "$BOTBOY_TEST_NATIVE_FAILURE"
  exit 0
fi

if [ "$RECOVER_SHUTDOWN" = "1" ]; then
  RECOVERY_SCRIPT="$PROJ_DIR/scripts/recover-shutdown.mjs"
  if [ ! -f "$RECOVERY_SCRIPT" ]; then
    echo "❌ Shutdown recovery helper is missing; update BotBoy without starting, then retry."
    echo "    BOTBOY_UPDATE_NO_START=1 ./start.sh --update"
    exit 1
  fi
  # No npm install here. The helper checks its database copy with
  # better-sqlite3 when that opens a database in this Node, and otherwise with
  # macOS's own /usr/bin/sqlite3, so a fresh clone, npm 12 skipping native
  # builds, or a Node switch cannot block recovery (teammate, 2026-10-07).
  PPT_STARTUP_SAFETY_BLOCK="$STARTUP_SAFETY_BLOCK" \
  PPT_SHUTDOWN_RECEIPT_DIR="$SHUTDOWN_RECEIPT_DIR" \
  PPT_PID_FILE="$PID_FILE" \
    exec "$NODE" "$RECOVERY_SCRIPT"
fi

# Where the dashboard and the debug Chrome's DevTools endpoint are. Tests point both
# at stand-ins (BOTBOY_TEST_APP_ORIGIN, BOTBOY_TEST_CDP_ORIGIN); a real start never
# sets them, so these are always BotBoy's own port and the debug Chrome's port.
DASH_ORIGIN="${BOTBOY_TEST_APP_ORIGIN:-http://localhost:7778}"
CDP_ORIGIN="${BOTBOY_TEST_CDP_ORIGIN:-http://127.0.0.1:9222}"

server_is_ready() {
  local expected_pid="${1:-}"
  local payload=""
  local ready_process_id=""
  # `/` is intentionally 200 during provisional boot so an already-open tab
  # can show the self-refreshing startup page. Only the version API proves the
  # real app handler is installed and startup reached its completion boundary.
  payload=$(curl -fsS --max-time 1 \
    "$DASH_ORIGIN/api/dashboard/version" 2>/dev/null) || return 1
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
if ! curl -s "$CDP_ORIGIN/json" >/dev/null 2>&1; then
  ${CHROME_PREFIX[@]+"${CHROME_PREFIX[@]}"} "$CHROME" \
    --remote-debugging-port=9222 \
    --user-data-dir="$DEBUG_PROFILE" \
    --no-first-run --no-default-browser-check >/dev/null 2>&1 &
  # A cold Chrome start can take well over a fixed sleep (first launch after
  # boot, profile migrations). Wait until the DevTools endpoint actually
  # answers so open_dashboard_window never runs before Chrome is ready —
  # that race is why launches used to open Chrome without a BotBoy window.
  for _ in $(seq 1 20); do
    curl -s --max-time 1 "$CDP_ORIGIN/json/version" >/dev/null 2>&1 && break
    sleep 1
  done
else
  # Already running (started by an older launcher or by hand): say so once if
  # it is a translated Chrome. Best effort; it never stops or restarts it,
  # and the doctor reports it in its own row.
  if [ "$DOCTOR$STOP_ONLY$OPEN_WINDOW_ONLY" = "000" ]; then
    warn_if_running_chrome_translated
  fi
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

# scripts/dashboard-window.mjs: which Chrome page is the dashboard window ("find": a page on
# BotBoy's own address, alive) and loading the dashboard again in a tab that is stuck on
# Chrome's "This site can't be reached" page ("revive"). The answer is on stdout and notes go to
# the log. It never fails the launcher: a missing helper, or no answer from DevTools, is "no such page".
dashboard_window() {
  [ -f "$PROJ_DIR/scripts/dashboard-window.mjs" ] || return 0
  "$NODE" "$PROJ_DIR/scripts/dashboard-window.mjs" "$1" --cdp "$CDP_ORIGIN" --app "$DASH_ORIGIN" 2>>"$LOG_FILE" || true
}

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
    curl -s --max-time 2 "$CDP_ORIGIN/json/version" >/dev/null 2>&1 && { devtools_up=0; break; }
    sleep 1
  done
  if [ "$devtools_up" = "0" ]; then
    # Parse with node (always present — it runs the server); python3 is not a
    # BotBoy prerequisite and may be missing on a fresh machine. Emits
    # "<targetId>\t<url>" so the respawn below can preserve the user's place.
    DASH_INFO=$(dashboard_window find)
    DASH_TARGET="${DASH_INFO%%$'\t'*}"
    DASH_URL="${DASH_INFO#*$'\t'}"
    if [ -n "$DASH_TARGET" ] && [ "$mode" = "focus" ]; then
      # Target.activateTarget: raises the existing app window, page state
      # (route, scroll, drafts) intact.
      curl -s --max-time 3 "$CDP_ORIGIN/json/activate/$DASH_TARGET" >/dev/null
      if ! startup_target_is_ready "$expected_pid"; then
        echo "❌ BotBoy stopped before its dashboard window could be focused."
        echo "    Run: ./start.sh --doctor"
        return 1
      fi
      echo "✅ Dashboard window focused"
      return 0
    fi
    if [ -z "$DASH_TARGET" ]; then
      # No live dashboard page. A tab of ours may be sitting on Chrome's "This site can't be
      # reached" page (the server was down when it loaded): it runs no JavaScript, so it can
      # never recover by itself, and another window would leave it dead beside the new one.
      # Load the dashboard in that same tab, on the same route. Only a tab that Chrome says
      # failed to load BotBoy's own address is touched (scripts/dashboard-window.mjs).
      REVIVED_TARGET=$(dashboard_window revive)
      if [ -n "$REVIVED_TARGET" ]; then
        if ! startup_target_is_ready "$expected_pid"; then
          echo "❌ BotBoy stopped before its dashboard window could be reloaded."
          echo "    Run: ./start.sh --doctor"
          return 1
        fi
        echo "✅ Dashboard window reloaded"
        # A start or restart ends with the line the teammate docs promise, as when it opens a window.
        [ "$mode" = "focus" ] || echo "✅ Dashboard ready: $DASH_ORIGIN"
        return 0
      fi
    fi
    # Real start/restart: the fresh window must load current code, but the
    # user's PLACE should survive — reopen at the old window's URL (the route
    # lives in the hash; a since-removed route degrades to the not-found view
    # via parseRoute). Guard: only genuine dashboard URLs are reused, so a
    # connection-error page (chrome-error://…) is never resurrected.
    REOPEN_URL="$DASH_ORIGIN"
    case "$DASH_URL" in
      "$DASH_ORIGIN"*) REOPEN_URL="$DASH_URL" ;;
    esac
    if [ -n "$DASH_TARGET" ]; then
      curl -s --max-time 3 "$CDP_ORIGIN/json/close/$DASH_TARGET" >/dev/null
      sleep 1
    fi
    # Snapshot every existing page target after the old dashboard is closed.
    # The singleton Chrome process creates one new page for --app; retaining
    # its new ID lets a failed settle close exactly this launch artifact even
    # if its URL has already become chrome-error://.
    PRELAUNCH_TARGET_IDS=$(curl -s --max-time 3 "$CDP_ORIGIN/json/list" \
      | "$NODE" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).filter(x=>x.type==='page').map(x=>String(x.id||'')).filter(Boolean).join('\n'))}catch{}})" 2>/dev/null)
    local window_started=$SECONDS
    ${CHROME_PREFIX[@]+"${CHROME_PREFIX[@]}"} "$CHROME" \
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
      NEW_DASH_TARGET=$(curl -s --max-time 3 "$CDP_ORIGIN/json/list" \
        | BOTBOY_PRELAUNCH_TARGET_IDS="$PRELAUNCH_TARGET_IDS" BOTBOY_DASH_ORIGIN="$DASH_ORIGIN" "$NODE" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const old=new Set(String(process.env.BOTBOY_PRELAUNCH_TARGET_IDS||'').split('\n').filter(Boolean));const launched=u=>u===''||u==='about:blank'||u.startsWith('chrome-error://')||u.startsWith(process.env.BOTBOY_DASH_ORIGIN)||u.startsWith(process.env.BOTBOY_DASH_ORIGIN.replace('//localhost:','//127.0.0.1:'));const t=JSON.parse(d).find(x=>x.type==='page'&&x.id&&!old.has(String(x.id))&&launched(String(x.url||'')));process.stdout.write(String(t?.id||''))}catch{}})" 2>/dev/null)
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
      curl -s --max-time 3 "$CDP_ORIGIN/json/close/$NEW_DASH_TARGET" >/dev/null
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

# One-time database-open marker path for the next server this launcher
# spawns (passed as PPT_DB_OPEN_MARKER). index.ts writes it immediately before
# its first tracker.db open (database-open-marker.ts).
new_db_open_marker_path() {
  local id
  id="$("$NODE" -e 'process.stdout.write(require("crypto").randomUUID())' 2>/dev/null)" || return 1
  [ -n "$id" ] || return 1
  printf '%s/ppt-db-open-%s.json' "$SHUTDOWN_RECEIPT_DIR" "$id"
}

# A failed startup child that is gone and never wrote its marker never opened
# tracker.db, so there is nothing a guard could protect. Only an absent marker
# in a readable directory proves that; an unknown marker path, a live child,
# or any file at the marker path keeps the guard.
child_never_reached_database() {
  local server_pid="$1"
  local marker="${2:-}"
  [ -n "$marker" ] || return 1
  pid_is_live "$server_pid" && return 1
  local marker_dir
  marker_dir="$(dirname "$marker")"
  [ -d "$marker_dir" ] && [ -r "$marker_dir" ] && [ -x "$marker_dir" ] || return 1
  if [ -e "$marker" ] || [ -L "$marker" ]; then
    return 1
  fi
  return 0
}

# Stop an exact candidate child through the same 20/30-second DB-last contract
# as ordinary takeover. Failed readiness/window settlement must never create a
# five-second shortcut around the application's 25-second coordinator.
# Returns 0 clean, 2 forced but DB-closed, 3 stopped before it opened the
# database (no guard), 1 unverified (guard kept).
stop_startup_child() {
  local server_pid="$1"
  local db_open_marker="${2:-}"
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
      [ -z "$db_open_marker" ] || rm -f "$db_open_marker"
      echo "✅ startup pid $server_pid stopped cleanly after failed completion (receipt: $receipt)"
      return 0
      ;;
    "complete|forced|closed"|"complete|failed|closed")
      if ! scrub_shutdown_receipt "$receipt" "$server_pid"; then
        echo "❌ DB closure was proved, but private receipt fields could not be scrubbed."
        return 1
      fi
      rm -f "$STARTUP_SAFETY_BLOCK"
      [ -z "$db_open_marker" ] || rm -f "$db_open_marker"
      echo "⚠️  startup pid $server_pid required bounded cleanup but proved SQLite closed (receipt: $receipt)"
      return 2
      ;;
    *)
      if child_never_reached_database "$server_pid" "$db_open_marker"; then
        rm -f "$STARTUP_SAFETY_BLOCK"
        echo "ℹ️  BotBoy stopped before it opened its database, so nothing needs recovery."
        echo "    The cause is at the end of $LOG_FILE; ./start.sh --doctor runs the checks."
        return 3
      fi
      echo "❌ Failed-start cleanup did not prove exact, fresh DB-last closure ($state)."
      echo "    Replacement starts are blocked by: $STARTUP_SAFETY_BLOCK"
      echo "    Preserve tracker.db + WAL + SHM together and inspect: $receipt"
      [ "$killed" = "0" ] || echo "    The candidate required SIGKILL."
      print_shutdown_recovery_next_steps
      return 1
      ;;
  esac
}

# The PID file only names a candidate. macOS reuses PIDs, and the server never
# removes the file itself, so after a crash or reboot it can name an unrelated
# process. Count it only when it runs the BotBoy server (`<node> dist/index.js`,
# the same match as the pgrep discovery); otherwise BotBoy would signal and,
# after 30 s, kill someone else's process and then wait forever for a receipt.
pid_runs_botboy_server() {
  ps -ww -o command= -p "$1" 2>/dev/null | grep -q 'node dist/index.js'
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

# Live BotBoy servers: the pgrep match plus the PID file's entry when that
# process runs the server too (`pid_runs_botboy_server`).
discover_tracker_pids() {
  local pids file_pid="" discovered_pid live_pids=""
  pids="$(pgrep -f 'node dist/index.js' 2>/dev/null)"
  [ -f "$PID_FILE" ] && file_pid="$(cat "$PID_FILE" 2>/dev/null)"
  if [[ "$file_pid" =~ ^[0-9]+$ ]] && pid_runs_botboy_server "$file_pid"; then
    pids="$pids $file_pid"
  fi
  pids="$(echo "$pids" | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u)"
  for discovered_pid in $pids; do
    pid_is_live "$discovered_pid" && live_pids="$live_pids $discovered_pid"
  done
  echo "$live_pids" | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u
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
    pids="$(discover_tracker_pids)"
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

# Every guard refusal names the command that resolves it. A teammate's clean
# reinstall (2026-10-07) printed only "Inspect … before recovery" and stopped:
# the guard (/tmp) and the database (~/.personal-productivity-tracker) live
# outside the checkout, so deleting and re-cloning it changes nothing.
print_shutdown_recovery_next_steps() {
  echo "    Next: ./start.sh --recover-shutdown"
  echo "      It checks that the old BotBoy is gone, backs up tracker.db with its -wal and -shm files, and clears this guard."
  echo "    Then: ./start.sh"
  echo "    Do not delete the guard or the database files yourself. If recovery refuses, run ./start.sh --doctor and send the owner its \"shutdown recovery\" line."
}

startup_safety_allows_takeover() {
  [ -f "$STARTUP_SAFETY_BLOCK" ] || return 0
  local targets
  targets="$(startup_safety_block_targets)"
  if [ -z "$targets" ] || [ "$targets" = "invalid" ]; then
    echo "❌ Replacement start blocked: the shutdown safety guard is invalid ($STARTUP_SAFETY_BLOCK)."
    echo "    Next: ./start.sh --doctor, then send the owner its \"shutdown recovery\" line."
    echo "    Do not delete the guard or tracker.db, tracker.db-wal, or tracker.db-shm yourself."
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
  echo "    Guard: $STARTUP_SAFETY_BLOCK"
  print_shutdown_recovery_next_steps
  return 1
}

safe_takeover() {
  startup_safety_allows_takeover || return 1
  stop_existing_server
  local result=$?
  if [ "$result" = "1" ]; then
    echo "❌ Replacement start blocked: prior process did not prove exact, fresh DB-last closure."
    echo "    Guard: $STARTUP_SAFETY_BLOCK"
    print_shutdown_recovery_next_steps
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
  stop_startup_child "$BOTBOY_TEST_STARTUP_CLEANUP_PID" "${BOTBOY_TEST_DB_OPEN_MARKER:-}"
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
# Prints what a takeover would signal; signals nothing.
if [ "${BOTBOY_TEST_DISCOVER_TRACKER_PIDS:-0}" = "1" ]; then
  discover_tracker_pids
  exit 0
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
  # BOTBOY_TEST_OPEN_WINDOW_MODE=fresh lets a test run the start/restart window path without a server start.
  if ! open_dashboard_window "${BOTBOY_TEST_OPEN_WINDOW_MODE:-focus}"; then
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
  print_shutdown_recovery_next_steps
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
  if git_usable; then
    TRACKED_DIRTY_COUNT=$(git -C "$PROJ_DIR" status --porcelain --untracked-files=no 2>/dev/null | wc -l | tr -d ' ')
    echo "tracked local changes: ${TRACKED_DIRTY_COUNT:-unknown}$([ "${TRACKED_DIRTY_COUNT:-0}" != "0" ] && echo ' — run ./start.sh --update before pulling' || true)"
  else
    echo "tracked local changes: unknown (git needs Xcode Command Line Tools: xcode-select --install)"
  fi
  if [ "$BOTBOY_RELEASE_CHECKOUT" = "1" ] && git_usable; then
    DOCTOR_HEAD="$(git -C "$PROJ_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    if git -C "$PROJ_DIR" fetch --quiet origin main 2>/dev/null; then
      DOCTOR_BEHIND="$(git -C "$PROJ_DIR" rev-list --count HEAD..origin/main 2>/dev/null || echo '?')"
      echo "release: $DOCTOR_HEAD; $DOCTOR_BEHIND newer release(s) on botboy-app$([ "$DOCTOR_BEHIND" != "0" ] && echo ' — click Update in BotBoy or run ./start.sh --update' || true)"
    else
      echo "release: $DOCTOR_HEAD; could not reach botboy-app to check for updates"
    fi
  fi
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
  doctor_node_row
  [ "$NODE_RUNTIME_LOADED" != "1" ] || doctor_node_runtime_rows
  [ "$PYTHON_RUNTIME_LOADED" != "1" ] || doctor_python_rows
  doctor_machine_rows
  doctor_app_launcher_row
  doctor_toolchain_rows
  [ -x "$CHROME" ] && echo "chrome: installed" || echo "chrome: MISSING at $CHROME"
  [ -f "$PROJ_DIR/dist/index.js" ] && echo "build: dist/index.js present" || echo "build: MISSING — run: npm run build"
  [ -f "$PROJ_DIR/dist/ui/index.html" ] && [ -f "$PROJ_DIR/dist/ui/dashboard.css" ] && echo "ui-assets: present" || echo "ui-assets: MISSING/PARTIAL — run: npm run build"
  DOCTOR_MISSING_DEPS="$(missing_npm_dependencies)"
  if [ -z "$DOCTOR_MISSING_DEPS" ]; then echo "npm dependencies: installed"; else echo "npm dependencies: MISSING $DOCTOR_MISSING_DEPS — run: npm install (./start.sh also tries)"; fi
  # `check` is read-only. better-sqlite3 counts only when it opens a
  # database and node-pty only when it spawns a terminal.
  DOCTOR_NATIVE="$(native_modules_status check)"
  for mod in better-sqlite3 node-pty; do
    DOCTOR_NATIVE_LINE="$(printf '%s\n' "$DOCTOR_NATIVE" | grep "^$mod|" | head -n 1)"
    case "$DOCTOR_NATIVE_LINE" in
      "$mod|ok") echo "native $mod: works";;
      "") echo "native $mod: UNKNOWN — the check did not run";;
      *) echo "native $mod: FAILS — ${DOCTOR_NATIVE_LINE#*|} — run: ./start.sh (it reinstalls native modules once)";;
    esac
  done
  # Folder watching rides FSEvents (native fs.watch recursive): ~1 fd per
  # watched FOLDER, independent of file count. A low limit here no longer
  # implicates watched-folder size — look at sockets/subprocesses instead.
  echo "fd limit: $(ulimit -n) (folder watching costs ~1 fd per folder)"
  # Node's connect attempt limit (src/core/network-defaults.ts). Node 20 gives each
  # address 250 ms to finish its TCP handshake; a route to Google slower than that
  # (seen at ~310 ms) made every request to Google fail with "network error
  # (ETIMEDOUT)" while curl worked. BotBoy raises the limit when it boots. This
  # prints both numbers and times one real TCP connect (no data is sent).
  "$NODE" -e '
    const net = require("net");
    const limit = typeof net.getDefaultAutoSelectFamilyAttemptTimeout === "function" ? net.getDefaultAutoSelectFamilyAttemptTimeout() : null;
    const raw = process.env.BOTBOY_NET_ATTEMPT_TIMEOUT_MS || "";
    const override = /^\s*\d{1,9}\s*$/.test(raw) ? Math.min(10000, Math.max(250, Number(raw))) : null;
    const sets = override !== null ? override : (limit !== null && limit > 2000 ? limit : 2000);
    console.log(`node connect timeout: default ${limit === null ? "n/a (this Node cannot change it)" : `${limit} ms`}; BotBoy sets ${limit === null ? "nothing" : `${sets} ms`} at boot${override !== null ? " (BOTBOY_NET_ATTEMPT_TIMEOUT_MS)" : ""}`);
    const started = Date.now();
    const socket = net.connect({ host: "oauth2.googleapis.com", port: 443, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 5000 });
    const finish = (text) => { console.log(text); socket.destroy(); process.exit(0); };
    socket.setTimeout(10000, () => finish("connect probe: oauth2.googleapis.com:443 gave no answer in 10 s (network, proxy, or VPN blocks it)"));
    socket.once("error", (error) => finish(`connect probe: oauth2.googleapis.com:443 FAILED (${(error && (error.code || (Array.isArray(error.errors) && error.errors.map((inner) => inner.code).join("+")))) || "error"})`));
    socket.once("connect", () => {
      const ms = Date.now() - started;
      let note = "";
      if (ms > 200) {
        note = limit !== null && ms >= limit
          ? ` - SLOW: slower than the ${limit} ms Node limit, so a plain Node request fails here ("network error (ETIMEDOUT)" in Gmail and Drive); BotBoy raises the limit to ${sets} ms at boot`
          : ` - slow (above 200 ms): close to the 250 ms Node default; BotBoy keeps a ${sets} ms limit so requests still connect`;
      }
      finish(`connect probe: oauth2.googleapis.com:443 connected in ${ms} ms (${socket.remoteFamily || "?"})${note}`);
    });
  ' 2>/dev/null || echo "node connect timeout: could not run the check"
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
  # Settings → AI model: key suffixes, role choices and one probe per saved key (doctor_ai_model_rows, defined
  # above beside the test hooks).
  doctor_ai_model_rows
  # Connections → Gmail. Node reads the OAuth client and refresh token in its
  # own memory and prints only which client is active (the own client; a
  # built-in one only if a build fills that slot, which ships empty), the
  # client ID's last characters, the account's domain, the granted access, the
  # file mode, and the HTTP status of one token refresh; no secret or address
  # enters this shell, argv, or the output.
  if [ -f "$GMAIL_TEAM_CLIENT_INBOX" ]; then
    echo "gmail: a Google client staged by an older credential file is waiting; BotBoy deletes it unread at the next start (Gmail uses your own client from Connections → Gmail)"
  fi
  if [ -f "$GMAIL_CREDENTIALS_FILE" ]; then
    "$NODE" -e '
      const fs = require("fs");
      const file = process.argv[1];
      const mode = (fs.lstatSync(file).mode & 0o777).toString(8);
      let value;
      try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      // Same rule as gmail-credentials.ts › usableBuiltInClient: both values set.
      const filled = text => typeof text === "string" && text.trim() !== "";
      const usable = entry => Boolean(entry) && filled(entry.clientId) && filled(entry.clientSecret);
      if (!value || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) {
        console.log(`gmail: credentials file is unreadable (mode ${mode}) — save your Google client again in Connections → Gmail`);
        process.exit(0);
      }
      const own = usable(value.client) ? value.client : null;
      (async () => {
        // A built-in client comes from the build, so the doctor reports the
        // client the server will actually use. The shipped slot is empty.
        const builtIn = await import(require("url").pathToFileURL(process.argv[2]).href)
          .then(module => module.BOTBOY_GOOGLE_CLIENT, () => null);
        const client = own || (usable(builtIn) ? builtIn : null);
        if (!client) {
          console.log(value.teamClient
            ? `gmail: only the retired shared Google client from a credential file is saved (mode ${mode}) — save your own client in Connections → Gmail, then choose Connect Gmail`
            : `gmail: no Google client saved (mode ${mode}) — add your own client in Connections → Gmail`);
          return;
        }
        const source = own ? "own client" : "built-in client";
        const suffix = client.clientId.replace(/\.apps\.googleusercontent\.com$/, "").slice(-6);
        // Schema 1: one connection; schema 2: accounts[] (multi-account).
        const accounts = value.schemaVersion === 1
          ? (value.connection ? [{ label: "", connection: value.connection }] : [])
          : (Array.isArray(value.accounts) ? value.accounts : []);
        const connected = accounts.filter(account => account && account.connection && typeof account.connection.refreshToken === "string" && account.connection.refreshToken);
        if (!connected.length) {
          console.log(`gmail: ${source} …${suffix} ready, not connected (mode ${mode})`);
          return;
        }
        console.log(`gmail: ${source} …${suffix}; ${connected.length} account${connected.length === 1 ? "" : "s"} connected (mode ${mode})`);
        for (const account of connected) {
          const connection = account.connection;
          const domain = String(connection.accountEmail || "").split("@")[1] || "unknown";
          const name = typeof account.label === "string" && account.label ? `"${account.label.replace(/[^ -~]/g, "").slice(0, 40)}" ` : "";
          const scopes = String(connection.scope || "").split(/\s+/);
          const access = scopes.includes("https://www.googleapis.com/auth/gmail.compose") ? "read + compose" : "read only (Reconnect to allow drafting and sending)";
          let response;
          try {
            response = await fetch("https://oauth2.googleapis.com/token", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "refresh_token",
                client_id: client.clientId,
                client_secret: client.clientSecret,
                refresh_token: connection.refreshToken,
              }),
              signal: AbortSignal.timeout(10000),
            });
          } catch {
            console.log(`gmail account ${name}at ${domain}: ${access}; refresh probe HTTP 000 (network, proxy, or VPN blocks oauth2.googleapis.com)`);
            continue;
          }
          let code = "";
          if (!response.ok) {
            try {
              const body = await response.json();
              if (typeof body.error === "string") code = ` ${body.error.replace(/[^a-z_]/g, "").slice(0, 40)}`;
            } catch {}
          }
          console.log(`gmail account ${name}at ${domain}: ${access}; refresh probe HTTP ${response.status}${code} (200=connected, 400 invalid_grant=choose Reconnect in Connections → Gmail)`);
        }
      })();
    ' "$GMAIL_CREDENTIALS_FILE" "$PROJ_DIR/dist/core/gmail-builtin-client.js" 2>/dev/null || echo "gmail: could not inspect the credentials file"
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
# PPT_START_LOCK_DIR is a test hook (production never sets it): a test that runs the real start flow takes a lock of
# its own, never the one a real ./start.sh on the same Mac uses.
LOCK_DIR="${PPT_START_LOCK_DIR:-/tmp/ppt-start.lock}"
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
# A start that ends early (a failed build, a blocked takeover) also stops BotBoy's Python download of this start, so
# no job is left holding its lock; the partial file stays and the next start resumes it.
on_start_exit() {
  release_start_lock
  [ "$PYTHON_RUNTIME_LOADED" != "1" ] || python_runtime_fetch_abort
}
trap on_start_exit EXIT

# Build self-heal. Two triggers:
#   1. dist/index.js missing — fresh clone (dist/ is gitignored). Without
#      this, `node dist/index.js` dies instantly and the launcher still opens
#      a dashboard window onto a dead port.
#   2. dist/.build-commit differs from git HEAD — stale build after git pull.
#      Without this, pulled fixes silently never activate (the server keeps
#      running last week's code and everyone wonders why nothing changed).
#
# BotBoy's own Node, when this Mac has no usable one: the only place a start downloads anything (verified, once).
# It comes before the first npm or build step, which need it.
[ "$NODE_RUNTIME_LOADED" != "1" ] || ensure_node_runtime
# BotBoy's own Python, when this Mac has no usable Python or uv: its download starts here, in the background, so it
# overlaps npm install and the build; python_runtime_fetch_join waits for it just before the server starts.
[ "$PYTHON_RUNTIME_LOADED" != "1" ] || python_runtime_fetch_begin
# Clear the browser-download flag on the prebuilt helpers first: npm's
# postinstall (inside the self-heal) and the server both may run them.
strip_native_download_mark
heal_missing_npm_dependencies
# (The optional OCR helper is NOT built here: start_ocr_helper_job runs it in
# the background after the dashboard window is open.)
# An unresolved shutdown guard blocks every replacement start. Report it now,
# with its next step, instead of after the build.
startup_safety_allows_takeover || exit 1

# Native modules. A server that cannot load better-sqlite3 or node-pty dies
# at import, so check them in this exact Node first and reinstall both once.
# Removing them first means npm writes new files instead of rewriting a
# binary a running BotBoy has loaded. If they still fail, stop here: no child
# starts, so no guard can be left behind (teammate on Node 26 + npm 12,
# 2026-10-07).
NATIVE_REINSTALLED=0
if ! NATIVE_STATUS="$(native_modules_status repair)"; then
  NATIVE_REINSTALLED=1
  warn_if_node_needs_tools_to_install
  echo "ℹ️  Reinstalling native modules for Node $("$NODE" --version 2>/dev/null) — npm install" | tee -a "$LOG_FILE"
  printf '%s\n' "$NATIVE_STATUS" | grep -v '|ok$' | sed 's/|/: /; s/^/    /' | tee -a "$LOG_FILE"
  (cd "$PROJ_DIR" && export BOTBOY_DEFER_OCR_BUILD=1 && rm -rf node_modules/better-sqlite3 node_modules/node-pty \
    && native_exec npm install --no-audit --no-fund >> "$LOG_FILE" 2>&1) || true
  if ! NATIVE_STATUS="$(native_modules_status repair)"; then
    print_native_modules_failure "$NATIVE_STATUS" | tee -a "$LOG_FILE"
    exit 1
  fi
  echo "✅ Native modules reinstalled" | tee -a "$LOG_FILE"
fi

NEED_BUILD=""
if [ "${BOTBOY_FORCE_BUILD:-0}" = "1" ]; then
  NEED_BUILD="updated release/customizations"
elif [ "$DEPS_INSTALLED" = "1" ]; then
  NEED_BUILD="dependencies installed"
elif [ ! -f "$PROJ_DIR/dist/index.js" ]; then
  NEED_BUILD="first run"
else
  CURRENT_COMMIT=""
  if git_usable; then CURRENT_COMMIT=$(git -C "$PROJ_DIR" rev-parse HEAD 2>/dev/null || echo ""); fi
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
  if ! native_exec npm run build >> "$LOG_FILE" 2>&1; then
    echo "❌ Build failed — see $LOG_FILE (try: npm install && npm run build)" | tee -a "$LOG_FILE"
    exit 1
  fi
  echo "✅ Build complete" | tee -a "$LOG_FILE"
fi

# BotBoy's own Python: wait for this start's background download, then put what is installed first on PATH, so the
# server and every MCP server it starts see exactly what exists (scripts/python-runtime.sh, rule 4). The wait lasts
# until the download's deadline when this start installed packages or built, except the start of an update
# (BOTBOY_FORCE_BUILD), which, like a restart with nothing to build, waits at most 20 s; a download that has not
# finished by then is stopped, BotBoy starts without its Python, and the next start resumes it.
if [ "$PYTHON_RUNTIME_LOADED" = "1" ]; then
  PY_JOIN_LONG=0
  if [ "${BOTBOY_FORCE_BUILD:-0}" != "1" ] && { [ -n "$NEED_BUILD" ] || [ "$DEPS_INSTALLED" = "1" ] || [ "$NATIVE_REINSTALLED" = "1" ]; }; then
    PY_JOIN_LONG=1
  fi
  python_runtime_fetch_join
fi
# Test hook (production never sets it): what the server would start with (the decision, its PATH and its environment),
# then stop before any takeover. It works without scripts/python-runtime.sh too, so a test can compare the two.
if [ "${BOTBOY_TEST_PYTHON_AFTER_JOIN:-0}" = "1" ]; then
  [ "$PYTHON_RUNTIME_LOADED" != "1" ] || print_python_selection
  echo "server_path=$PATH"
  env | LC_ALL=C sort | grep -v -E '^(_|SHLVL|OLDPWD|PWD)=' | sed 's/^/server_env: /'
  exit 0
fi

if [ "$FOREGROUND" = "1" ]; then
  # ── Foreground mode (app bundle) ──
  # The server runs as a child of THIS script and the script blocks on it, so
  # the launching .app stays alive (dock icon persists) for as long as the
  # tracker runs. Only one server may own port 7778, so an existing instance is
  # handed over first. This is unconditional: a provisional or wedged process
  # may own the port without satisfying the final-ready endpoint.
  safe_takeover || exit 1
  # Weekly upkeep of BotBoy's Python, now that the old server and its MCP children are gone (bounded; never fails).
  [ "$PYTHON_RUNTIME_LOADED" != "1" ] || python_runtime_maintenance

  DB_OPEN_MARKER="$(new_db_open_marker_path)" || DB_OPEN_MARKER=""
  PPT_DB_OPEN_MARKER="$DB_OPEN_MARKER" ${SERVER_PREFIX[@]+"${SERVER_PREFIX[@]}"} "$NODE" dist/index.js >> "$LOG_FILE" 2>&1 &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$PID_FILE"

  # Forward Quit/Ctrl-C into the same receipt-aware bounded takeover path.
  trap 'foreground_shutdown INT' INT
  trap 'foreground_shutdown TERM' TERM
  trap 'foreground_shutdown HUP' HUP

  if ! wait_for_server "$SERVER_PID"; then
    stop_startup_child "$SERVER_PID" "$DB_OPEN_MARKER"
    exit 1
  fi
  if ! open_dashboard_window fresh "$SERVER_PID"; then
    stop_startup_child "$SERVER_PID" "$DB_OPEN_MARKER"
    exit 1
  fi
  [ -z "$DB_OPEN_MARKER" ] || rm -f "$DB_OPEN_MARKER"

  # Startup is done — release the lock now. Foreground mode blocks for the
  # app's lifetime, and holding the lock that long would wrongly turn away
  # every later ./start.sh (which should just focus the window).
  release_start_lock
  warn_if_no_llm_credentials
  install_app_bundle_if_missing
  start_ocr_helper_job

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
  # Weekly upkeep of BotBoy's Python, now that the old server and its MCP children are gone (bounded; never fails).
  [ "$PYTHON_RUNTIME_LOADED" != "1" ] || python_runtime_maintenance
  DB_OPEN_MARKER="$(new_db_open_marker_path)" || DB_OPEN_MARKER=""
  PPT_DB_OPEN_MARKER="$DB_OPEN_MARKER" nohup ${SERVER_PREFIX[@]+"${SERVER_PREFIX[@]}"} "$NODE" dist/index.js </dev/null >> "$LOG_FILE" 2>&1 &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$PID_FILE"
  if ! wait_for_server "$SERVER_PID"; then
    stop_startup_child "$SERVER_PID" "$DB_OPEN_MARKER"
    exit 1
  fi
fi

if ! open_dashboard_window fresh "$SERVER_PID"; then
  [ -z "$SERVER_PID" ] || stop_startup_child "$SERVER_PID" "${DB_OPEN_MARKER:-}"
  exit 1
fi
[ -z "${DB_OPEN_MARKER:-}" ] || rm -f "$DB_OPEN_MARKER"
warn_if_no_llm_credentials
install_app_bundle_if_missing
start_ocr_helper_job
