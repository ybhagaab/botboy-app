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
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { getSetting, setSetting } from './storage.js';
import { visionHelperPath } from './deps-check.js';

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
  { name: 'node', purpose: 'JavaScript runtime (BotBoy itself, agent scripts)', requirement: 'required', versionArgs: ['--version'], installHint: 'install Node 20+ (brew install node)' },
  { name: 'curl', purpose: 'HTTP fetches (web_search, web_fetch)', requirement: 'required', versionArgs: ['--version'], macBuiltin: true },
  // Capture pipeline
  { name: 'pdftotext', purpose: 'PDF text extraction fallback (poppler; the native vision-ocr helper is primary)', requirement: 'optional', brewFormula: 'poppler', versionArgs: ['-v'] },
  { name: 'pdftoppm', purpose: 'scanned-PDF rasterize fallback (poppler; native CoreGraphics is primary)', requirement: 'optional', brewFormula: 'poppler', versionArgs: ['-v'] },
  { name: 'textutil', purpose: 'Office/PDF conversion fallback', requirement: 'recommended', macBuiltin: true, internalOnly: true },
  { name: 'libreoffice', purpose: 'Office conversion fallback for .docx/.xlsx/.pptx', requirement: 'optional', installHint: 'brew install --cask libreoffice' },
  // macOS built-ins the monitors use
  { name: 'osascript', purpose: 'AppleScript (active-app monitor)', requirement: 'required', macBuiltin: true, internalOnly: true },
  { name: 'pbpaste', purpose: 'clipboard capture', requirement: 'required', macBuiltin: true, internalOnly: true },
  { name: 'open', purpose: 'open files/URLs from the dashboard', requirement: 'required', macBuiltin: true, internalOnly: true },
  { name: 'security', purpose: 'macOS Keychain (MCP secrets)', requirement: 'required', macBuiltin: true, internalOnly: true },
  // General-purpose agent tools
  { name: 'python3', purpose: 'Python scripts and data crunching', requirement: 'recommended', brewFormula: 'python', versionArgs: ['--version'] },
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

/** Discover every registry tool. Pure read — no PATH mutation, no persistence. */
export async function discoverToolchain(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ToolchainSnapshot> {
  const extraDirs = knownToolDirectories();
  const pathValue = env.PATH ?? '';

  const tools: ResolvedTool[] = await Promise.all(
    TOOL_REGISTRY.map(async (spec) => {
      const resolved = resolveBinary(spec.name, pathValue, extraDirs);
      const version = resolved && spec.versionArgs ? await probeVersion(resolved, spec.versionArgs) : null;
      return {
        name: spec.name,
        purpose: spec.purpose,
        requirement: spec.requirement,
        path: resolved,
        version,
        brewFormula: spec.brewFormula,
        installHint: spec.installHint,
        macBuiltin: spec.macBuiltin,
        internalOnly: spec.internalOnly,
      };
    }),
  );

  // The Apple Vision OCR helper is a built artifact with a fixed path, not a
  // PATH tool — include it so diagnostics and setup see one complete picture.
  const helper = visionHelperPath();
  tools.push({
    name: 'vision-ocr',
    purpose: 'Apple Vision OCR helper (built by npm run bootstrap)',
    requirement: 'required',
    path: existsSync(helper) ? helper : null,
    version: null,
    installHint: 'run "npm run bootstrap" to build it',
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
export function formatToolInventory(snapshot: ToolchainSnapshot | null): string {
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
