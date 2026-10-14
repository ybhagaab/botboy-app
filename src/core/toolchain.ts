/**
 * Toolchain discovery — resolve every external CLI tool BotBoy shells out to,
 * persist the resolved map, and extend the process PATH so child processes
 * (run_command, document parsing, OCR, MCP launches) find their tools no
 * matter how BotBoy was launched.
 *
 * Why: .app bundles and launchd start with a minimal PATH, and teammate
 * machines differ (Homebrew under /opt/homebrew, ~/homebrew, or /usr/local;
 * node via `n`, brew, or installer). Hardcoding paths or trusting the ambient
 * PATH breaks tool execution on every machine except the author's.
 *
 * Flow:
 *   initToolchain(db)  — discover, persist to app_settings('toolchain.map'),
 *                        append tool directories to process.env.PATH, and set
 *                        the in-memory snapshot used by the chat prompt.
 *   getToolchainSnapshot() — sync access for prompt building.
 *   formatToolInventory()  — honest prompt block: what exists, what is
 *                            missing, and how to install it.
 */

import { existsSync, statSync, accessSync, constants as fsConstants } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { getSetting, setSetting } from './storage.js';
import { visionHelperStatus } from './deps-check.js';
import { ocrHelperUnavailableLine, readOcrBuildFailure, type OcrBuildFailure } from './ocr-helper-marker.js';
import { refreshCommandLineTools } from './command-line-tools.js';
import { privateUvUse } from './protected-local-resources.js';

export const TOOLCHAIN_SETTING_KEY = 'toolchain.map';

export type ToolRequirement = 'required' | 'recommended' | 'optional';

export interface ToolSpec {
  /** Binary name exactly as BotBoy invokes it. */
  name: string;
  /** One-line purpose, shown in the prompt inventory and diagnostics. */
  purpose: string;
  requirement: ToolRequirement;
  /** Homebrew formula (or cask via installHint) when brew can install it. */
  brewFormula?: string;
  /** Human install guidance when brew is not the answer. */
  installHint?: string;
  /** argv for a fast version probe; omit to skip probing. */
  versionArgs?: string[];
  /** Ships with macOS (or Xcode CLT) — never needs installation. */
  macBuiltin?: boolean;
  /** Exclude from the chat prompt inventory (plumbing the agent never calls). */
  internalOnly?: boolean;
}

export interface ResolvedTool {
  name: string;
  purpose: string;
  requirement: ToolRequirement;
  /** Absolute path, or null when the tool is not installed. */
  path: string | null;
  /** First line of the version output, when probing succeeded. */
  version: string | null;
  brewFormula?: string;
  installHint?: string;
  macBuiltin?: boolean;
  internalOnly?: boolean;
}

export interface ToolchainSnapshot {
  resolvedAt: string;
  /** Directories appended to process.env.PATH by applyToolchainPath. */
  pathAdditions: string[];
  tools: ResolvedTool[];
}

/**
 * Registry of every external binary BotBoy invokes (monitors, parsers, OCR,
 * agent run_command examples). Adding a spawn site to the codebase should add
 * its binary here so discovery, setup, and the prompt stay truthful.
 */
export const TOOL_REGISTRY: readonly ToolSpec[] = Object.freeze([
  // Core runtime
  { name: 'node', purpose: 'JavaScript runtime (BotBoy itself, agent scripts)', requirement: 'required', versionArgs: ['--version'], installHint: 'install Node 24 or newer from nodejs.org (the LTS download; the installer needs no other tools)' },
  { name: 'curl', purpose: 'HTTP fetches (web_search, web_fetch)', requirement: 'required', versionArgs: ['--version'], macBuiltin: true },
  // Capture pipeline
  { name: 'pdftotext', purpose: 'PDF text extraction fallback (poppler; the native vision-ocr helper is primary)', requirement: 'optional', brewFormula: 'poppler', versionArgs: ['-v'] },
  { name: 'pdftoppm', purpose: 'scanned-PDF rasterize fallback (poppler; native CoreGraphics is primary)', requirement: 'optional', brewFormula: 'poppler', versionArgs: ['-v'] },
  { name: 'textutil', purpose: 'Office conversion fallback (never for PDFs: it echoes their bytes)', requirement: 'recommended', macBuiltin: true, internalOnly: true },
  { name: 'libreoffice', purpose: 'Office conversion fallback for .docx/.xlsx/.pptx', requirement: 'optional', installHint: 'brew install --cask libreoffice' },
  // macOS built-ins the monitors use
  { name: 'osascript', purpose: 'AppleScript (active-app monitor)', requirement: 'required', macBuiltin: true, internalOnly: true },
  { name: 'pbpaste', purpose: 'clipboard capture', requirement: 'required', macBuiltin: true, internalOnly: true },
  { name: 'open', purpose: 'open files/URLs from the dashboard', requirement: 'required', macBuiltin: true, internalOnly: true },
  { name: 'security', purpose: 'macOS Keychain (MCP secrets)', requirement: 'required', macBuiltin: true, internalOnly: true },
  // General-purpose agent tools
  // Python on demand (python-runtime.md): on a Mac without a Python 3.10+ or a uv, ./start.sh sets up BotBoy's own.
  { name: 'python3', purpose: 'Python scripts and data crunching', requirement: 'recommended', installHint: 'BotBoy sets up its own Python 3.13 when ./start.sh runs while online (./start.sh --doctor, row "python source"); or install Python 3.10+ from python.org', versionArgs: ['--version'] },
  { name: 'uv', purpose: 'Python packages, tools and Python MCP servers (uv, uvx)', requirement: 'optional', installHint: 'BotBoy sets up its own uv when ./start.sh runs while online (./start.sh --doctor, row "uv source")', versionArgs: ['--version'] },
  { name: 'git', purpose: 'version control', requirement: 'recommended', brewFormula: 'git', versionArgs: ['--version'] },
  { name: 'sqlite3', purpose: 'SQLite CLI', requirement: 'recommended', versionArgs: ['--version'], macBuiltin: true },
  { name: 'jq', purpose: 'JSON processing in shell pipelines', requirement: 'optional', brewFormula: 'jq', versionArgs: ['--version'] },
  { name: 'ffmpeg', purpose: 'audio/video conversion', requirement: 'optional', brewFormula: 'ffmpeg', versionArgs: ['-version'] },
  { name: 'whisper', purpose: 'audio transcription (OpenAI Whisper)', requirement: 'optional', brewFormula: 'openai-whisper' },
  { name: 'ollama', purpose: 'local LLM fallback runtime', requirement: 'optional', brewFormula: 'ollama', versionArgs: ['--version'] },
  { name: 'aws', purpose: 'AWS CLI (only for SigV4 legacy inference and user workflows)', requirement: 'optional', brewFormula: 'awscli', versionArgs: ['--version'] },
  // Amazon-internal tools — detected and reported, never auto-installed
  // (installs and logins are interactive; the Connections page owns those flows).
  { name: 'toolbox', purpose: 'Amazon Toolbox (installs internal tools such as grasp-mcp)', requirement: 'optional', installHint: 'install Amazon Toolbox from the internal builder-tools docs' },
  { name: 'mwinit', purpose: 'Midway authentication (needed before GRASP and other internal tools)', requirement: 'optional', installHint: 'preinstalled on Amazon-managed Macs; see internal Midway docs' },
  { name: 'grasp-mcp', purpose: 'GRASP MCP server (Outlook mail/calendar sync)', requirement: 'optional', installHint: 'install via the Connections page in the dashboard (Amazon Toolbox command shown there)', versionArgs: ['--version'] },
]);

/**
 * Directories checked beyond the ambient PATH, covering every install layout
 * seen on teammate machines. Order matters only for resolution ties; PATH
 * entries always win first.
 */
export function knownToolDirectories(home: string = os.homedir()): string[] {
  return [
    path.dirname(process.execPath), // the running node's bin dir (node, npm, npx)
    path.join(home, 'homebrew', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.toolbox', 'bin'),
    path.join(home, 'bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    '/Library/Apple/usr/bin',
  ];
}

function isExecutableFile(candidate: string): boolean {
  try {
    const st = statSync(candidate);
    if (!st.isFile()) return false;
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveBinary(name: string, pathValue: string, extraDirs: string[]): string | null {
  const seen = new Set<string>();
  const dirs = [...pathValue.split(path.delimiter), ...extraDirs];
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir) || seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

async function probeVersion(binPath: string, args: string[]): Promise<string | null> {
  // child_process is imported lazily so importing this module (e.g. from
  // prompt-manager) never touches process-launch APIs — tests mock
  // child_process with partial exports (same pattern as aws-sigv4).
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileP = promisify(execFile);
  try {
    const { stdout, stderr } = await execFileP(binPath, args, {
      encoding: 'utf-8',
      timeout: 4000,
      maxBuffer: 256 * 1024,
    });
    const line = (stdout || stderr || '').split('\n')[0]?.trim();
    return line || null;
  } catch (e: any) {
    // poppler's `-v` prints to stderr and some tools exit non-zero on version
    // flags; a failed probe still often carries the version text.
    const line = String(e?.stdout || e?.stderr || '').split('\n')[0]?.trim();
    return line || null;
  }
}

/**
 * What to tell the owner about a missing OCR helper. When its build already
 * failed on this Mac (`ocr-helper-marker.ts`), building it again is not the
 * answer, so the hint says what is true instead; when the helper is off for a
 * reason the resolver knows (macOS too old, a damaged file, ...), `offLine` is
 * that reason's sentence, which always names the next action.
 */
export function visionHelperInstallHint(failure: OcrBuildFailure | null, offLine: string | null = null): string {
  if (failure) return ocrHelperUnavailableLine();
  return offLine ?? 'run "npm run bootstrap" to build it';
}

/**
 * /usr/bin/git and /usr/bin/python3 are Xcode shims: on a Mac without the
 * Command Line Tools, running either raises the macOS "install developer
 * tools" dialog (and the version probe would record a stderr line as a
 * "version"). A tool that resolves to exactly that path counts as present only
 * when `xcode-select -p` answers. `BOTBOY_TEST_XCODE_SELECT_BIN` replaces the tool in tests.
 */
const XCODE_SHIM_TOOLS = new Set(['/usr/bin/git', '/usr/bin/python3']);
const XCODE_SHIM_HINT = 'install the Command Line Tools (xcode-select --install)';

function commandLineToolsPresent(): boolean {
  const override = process.env.BOTBOY_TEST_XCODE_SELECT_BIN;
  const bin = override && path.isAbsolute(override) ? override : '/usr/bin/xcode-select';
  try {
    return spawnSync(bin, ['-p'], { stdio: 'ignore', timeout: 15_000, killSignal: 'SIGKILL' }).status === 0;
  } catch {
    return false;
  }
}

/**
 * The boot warning for required tools that are missing, or null when there is
 * nothing to say. The OCR helper whose build already failed on this Mac is left
 * out: "npm run setup" would only repeat that build, and the dependency check
 * (`checkDependencies`) already says what is true, once, on one line.
 */
export function formatMissingRequiredWarning(
  tools: readonly ResolvedTool[],
  options: { ocrFailure?: OcrBuildFailure | null } = {},
): string | null {
  const ocrFailure = options.ocrFailure !== undefined ? options.ocrFailure : readOcrBuildFailure();
  const missing = tools.filter((t) => !t.path && t.requirement === 'required' && !(ocrFailure && t.name === 'vision-ocr'));
  if (missing.length === 0) return null;
  return `⚠️  Missing required tools: ${missing
    .map((t) => `${t.name} (${t.brewFormula ? `brew install ${t.brewFormula}` : t.installHint || 'see README'})`)
    .join(', ')} — run "npm run setup"`;
}

/** Discover every registry tool. Pure read — no PATH mutation, no persistence. */
export async function discoverToolchain(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ToolchainSnapshot> {
  const extraDirs = knownToolDirectories();
  const pathValue = env.PATH ?? '';

  // Asked at most once per discovery, and only if a shim path is actually found.
  let toolsAnswer: boolean | null = null;
  const developerToolsPresent = () => (toolsAnswer ??= commandLineToolsPresent());

  const tools: ResolvedTool[] = await Promise.all(
    TOOL_REGISTRY.map(async (spec) => {
      let resolved = resolveBinary(spec.name, pathValue, extraDirs);
      let installHint = spec.installHint;
      if (resolved && XCODE_SHIM_TOOLS.has(resolved) && !developerToolsPresent()) {
        resolved = null; // never run the shim: it would raise the install dialog
        // python3: BotBoy's own Python is the next step on such a Mac, not Apple's 3.9 (python-runtime.md).
        installHint = spec.name === 'python3' ? spec.installHint : XCODE_SHIM_HINT;
      }
      const version = resolved && spec.versionArgs ? await probeVersion(resolved, spec.versionArgs) : null;
      return {
        name: spec.name,
        purpose: spec.purpose,
        requirement: spec.requirement,
        path: resolved,
        version,
        brewFormula: resolved === null && installHint === XCODE_SHIM_HINT ? undefined : spec.brewFormula,
        installHint,
        macBuiltin: spec.macBuiltin,
        internalOnly: spec.internalOnly,
      };
    }),
  );

  // The Apple Vision OCR helper is a shipped artifact with a fixed path, not a
  // PATH tool — include it so diagnostics and setup see one complete picture.
  // It is RECOMMENDED, not required: BotBoy runs without it (only images and
  // scanned PDFs are unread), so a Mac without it logs no "Missing required
  // tools" warning. Boot-time and read-only: the resolver's verdict, no spawn.
  const status = visionHelperStatus();
  tools.push({
    name: 'vision-ocr',
    purpose: 'Apple Vision OCR helper (ships prebuilt with BotBoy)',
    requirement: 'recommended',
    path: status.ok ? status.path : null,
    version: null,
    installHint: visionHelperInstallHint(status.ok ? null : readOcrBuildFailure(), status.ok ? null : status.offLine),
    internalOnly: true,
  });

  // PATH additions: directories that contain resolved tools, plus standard
  // install dirs that exist on disk (so tools installed mid-session are found
  // without a restart), minus what the PATH already has.
  const currentDirs = new Set(pathValue.split(path.delimiter).filter(Boolean));
  const additions: string[] = [];
  const wanted = new Set<string>();
  for (const t of tools) {
    if (t.path && t.name !== 'vision-ocr') wanted.add(path.dirname(t.path));
  }
  for (const dir of extraDirs.slice(0, 7)) {
    // brew/toolbox/local layouts only — never force system dirs order changes
    if (existsSync(dir)) wanted.add(dir);
  }
  for (const dir of wanted) {
    if (!currentDirs.has(dir)) additions.push(dir);
  }

  return {
    resolvedAt: new Date().toISOString(),
    pathAdditions: additions,
    tools,
  };
}

/** Append discovered tool directories to process.env.PATH (never prepend). */
export function applyToolchainPath(snapshot: ToolchainSnapshot, env: NodeJS.ProcessEnv = process.env): void {
  if (snapshot.pathAdditions.length === 0) return;
  const current = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const merged = [...current];
  for (const dir of snapshot.pathAdditions) {
    if (!merged.includes(dir)) merged.push(dir);
  }
  env.PATH = merged.join(path.delimiter);
}

let activeSnapshot: ToolchainSnapshot | null = null;

/** In-memory snapshot for sync consumers (prompt building). Null before init. */
export function getToolchainSnapshot(): ToolchainSnapshot | null {
  return activeSnapshot;
}

/**
 * Discover, persist, and activate the toolchain. Call once at boot after the
 * DB is ready and before anything spawns child processes; call again to
 * refresh after installing tools (no restart needed).
 */
export async function initToolchain(db: Database.Database): Promise<ToolchainSnapshot> {
  // The cached Command Line Tools answer the sandbox reads (design D6); never awaited here.
  void refreshCommandLineTools();
  const snapshot = await discoverToolchain();
  applyToolchainPath(snapshot);
  activeSnapshot = snapshot;
  try {
    setSetting(db, TOOLCHAIN_SETTING_KEY, snapshot);
  } catch {
    // Persistence is best-effort; the live snapshot still serves this boot.
  }
  return snapshot;
}

/** Last persisted snapshot (for diagnostics when called before init). */
export function loadPersistedToolchain(db: Database.Database): ToolchainSnapshot | null {
  try {
    return getSetting<ToolchainSnapshot>(db, TOOLCHAIN_SETTING_KEY);
  } catch {
    return null;
  }
}

/**
 * Prompt block describing the real, discovered CLI environment. Honest by
 * construction: available tools come from resolution, missing tools carry an
 * install command, and nothing is claimed that discovery did not verify.
 */
export function formatToolInventory(snapshot: ToolchainSnapshot | null, botboyUvInUse: boolean = privateUvUse() !== null): string {
  if (!snapshot) {
    return 'CLI tools: not yet discovered this boot — probe with `command -v <tool>` inside run_command before claiming a tool exists.';
  }
  const visible = snapshot.tools.filter((t) => !t.internalOnly);
  const available = visible.filter((t) => t.path);
  const missing = visible.filter((t) => !t.path);

  const lines: string[] = [];
  const availList = available
    .map((t) => (t.version ? `${t.name} (${shortVersion(t.version)})` : t.name))
    .join(', ');
  lines.push(`Available CLI tools on this Mac (verified at boot, on PATH for run_command): ${availList || 'none'}.`);
  if (missing.length > 0) {
    const missList = missing
      .map((t) => `${t.name} (install: ${t.brewFormula ? `brew install ${t.brewFormula}` : t.installHint || 'see docs'})`)
      .join(', ');
    lines.push(`NOT installed: ${missList}. If a task needs one, say it is not installed and offer the install command — never pretend it ran.`);
  }
  // Python on demand (design review finding 9): BotBoy's uv keeps its own CPython read-only to chat, so another version
  // goes into ~/.botboy-python, and is then named by its path. Sent only while BotBoy's uv is the uv in use.
  if (botboyUvInUse) {
    lines.push('Another Python version: uv python install 3.14 --install-dir ~/.botboy-python/python, then pass --python ~/.botboy-python/bin/python3.14 (by version it is not found).');
  }
  if (available.some((t) => t.name === 'whisper')) {
    lines.push('When asked to transcribe audio, use: whisper "/path/to/file" --model small --output_format txt --output_dir /tmp');
  }
  return lines.join('\n');
}

function shortVersion(line: string): string {
  // "git version 2.39.3 (Apple Git-146)" → "2.39.3"; keep the first
  // number-bearing token so the prompt stays compact.
  const match = line.match(/\d+(?:\.\d+)+/);
  return match ? match[0] : line.slice(0, 24);
}
