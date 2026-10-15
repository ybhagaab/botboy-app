import { lookup } from 'node:dns/promises';
import fs from 'node:fs';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { commandLineToolsKnown } from './command-line-tools.js';

const DEFAULT_APP_PORT = 7778;
const DEFAULT_CDP_PORT = 9222;

function validPort(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : fallback;
}

/** BotBoy's own app port and its browser control (CDP) port, as named values. */
export function protectedLocalPortPolicy(options: { appPort?: number; cdpPort?: number } = {}): { appPort: number; cdpPort: number } {
  return {
    appPort: validPort(options.appPort ?? process.env.PPT_PORT, DEFAULT_APP_PORT),
    cdpPort: validPort(options.cdpPort, DEFAULT_CDP_PORT),
  };
}

export function protectedLocalPorts(options: { appPort?: number; cdpPort?: number } = {}): ReadonlySet<number> {
  return new Set([
    validPort(options.appPort ?? process.env.PPT_PORT, DEFAULT_APP_PORT),
    validPort(options.cdpPort, DEFAULT_CDP_PORT),
  ]);
}

function normalizedHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '').split('%')[0];
}

export function isLoopbackAddress(value: string): boolean {
  const address = normalizedHost(value);
  if (address === 'localhost' || address.endsWith('.localhost')) return true;
  if (address === '::1' || address === '0:0:0:0:0:0:0:1' || address === '::' || address === '0.0.0.0') return true;
  if (address.startsWith('::ffff:')) return isLoopbackAddress(address.slice('::ffff:'.length));
  if (isIP(address) === 4) return address.split('.')[0] === '127';
  return false;
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/**
 * Resolve the destination before allowing a model-controlled HTTP navigation.
 * Only BotBoy's own listener and the debug-Chrome control port are protected;
 * ordinary external pages and unrelated local development ports remain usable.
 */
export async function isProtectedLocalHttpUrl(
  value: string | URL,
  options: { appPort?: number; cdpPort?: number } = {},
): Promise<boolean> {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (!protectedLocalPorts(options).has(effectivePort(url))) return false;
  const host = normalizedHost(url.hostname);
  if (isLoopbackAddress(host)) return true;
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    return addresses.some(result => isLoopbackAddress(result.address));
  } catch {
    // Let the actual browser/fetch surface an unresolved external host. A
    // failed lookup is never treated as proof that a local address is safe.
    return true;
  }
}

function sandboxLiteral(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface ModelCommandSandboxOptions {
  appPort?: number;
  cdpPort?: number;
  privateRoot?: string;
  filesDir?: string;
  shell?: string;
  /**
   * BotBoy's own copy of Node, for a process that has to run it: a user-added MCP server started with `npx`, `npm` or a
   * script whose first line is `#!/usr/bin/env node`. The value is the version folder in use,
   * `<private root>/runtime/node-<version>-<chip>`, as `privateRuntimeDirInUse()` finds it. Absent (the default, and
   * always on a Mac that uses its own Node) the profile is exactly what it was before this option existed. A value that
   * does not resolve to such a folder adds nothing (see `runtimeReadRules`). The MCP manager passes it for user-added
   * servers, and `modelShellLaunch` for run_command and the chat terminal; both only while BotBoy runs on its own Node.
   */
  runtimeReadDir?: string | null;
  /**
   * Folders that must be first on PATH once a LOGIN shell has read the owner's profile files, used by
   * `modelCommandSandboxInvocation` only, and only when the runtime rules above were added. macOS's `path_helper` (in
   * /etc/zprofile) moves the system folders in front of the inherited PATH and a `~/.zprofile` may reset PATH outright;
   * either would lose BotBoy's Node in a `zsh -lc` command, so the command starts with an `export PATH=...`.
   */
  loginPathFirst?: string[];
  /** Folders put at the END of PATH by the same line (npm's global bin for BotBoy's Node). Used only together with `loginPathFirst`. */
  loginPathLast?: string[];
  /**
   * BotBoy's own uv folder in use, `<private root>/runtime/uv-<version>-<chip>`, as `privateUvUse()` finds it (the
   * wrappers and their `libexec/` binaries). Same rules as `runtimeReadDir`: a value that does not resolve to such a
   * folder adds nothing. BotBoy's uv runs only its own managed CPython, so a caller that names it names `pythonReadDir` too.
   */
  uvReadDir?: string | null;
  /** BotBoy's own CPython folder, `<private root>/runtime/python` (uv's install folder): read when BotBoy's uv or Python is in use. */
  pythonReadDir?: string | null;
  /**
   * Design decision D6: on a Mac without the Command Line Tools, deny exec of Apple's two Xcode stand-ins
   * (`/usr/bin/python3`, `/usr/bin/install_name_tool`), so nothing a sandboxed child of BotBoy's Python runs can raise the
   * "install developer tools" dialog. Added only together with the uv or Python read rule.
   */
  denyXcodeStandIns?: boolean;
}

/** Which of BotBoy's runtime folders a profile opened for reading (real paths). Each consumer keys off its own entry. */
export interface RuntimeOpened {
  /** The Node version folder (`runtimeReadDir`). */
  node?: string;
  /** The uv folder (`uvReadDir`). */
  uv?: string;
  /** `runtime/python` (`pythonReadDir`). */
  python?: string;
}

interface ModelSandboxBoundary {
  filesDir: string;
  profile: string;
  /** True when any runtime read rule was added. */
  runtimeRead: boolean;
  /** The folders those rules opened. */
  opened: RuntimeOpened;
}

/** The folder name `scripts/node-runtime.sh` gives an unpacked runtime: `node-<version>-<arm64|x64>`. */
const RUNTIME_VERSION_FOLDER = /^node-\d+\.\d+\.\d+-(?:arm64|x64)$/;
/** The folder name `scripts/python-runtime.sh` gives BotBoy's uv: `uv-<version>-<arm64|x64>`. */
const UV_VERSION_FOLDER = /^uv-\d+\.\d+\.\d+-(?:arm64|x64)$/;
/** A CPython uv installed: `cpython-<x.y.z>-macos-<aarch64|x86_64>-none` (the minor link `cpython-<x.y>-…` resolves to one). */
const CPYTHON_FOLDER = /^cpython-\d+\.\d+\.\d+-macos-(?:aarch64|x86_64)-none$/;
/** Apple's two Xcode stand-ins that the D6 rule keeps sandboxed children from running. */
const XCODE_STAND_INS = ['/usr/bin/python3', '/usr/bin/install_name_tool'] as const;

/**
 * The two extra Seatbelt rules that let a sandboxed child READ the runtime version folder in use, and nothing else.
 * Measured with /usr/bin/sandbox-exec on 2026-10-14 against the profile below: `(allow file-read* process-exec*
 * (subpath <runtime>))` alone is not enough, because Node's realpath lstats every parent folder and `npx` and `npm` then
 * fail with `EPERM: lstat '<home>/.personal-productivity-tracker'`. With these two rules they run, and these stay denied:
 * the saved key and the database (read or stat), a link inside the runtime that points at them, listing the private root
 * or `runtime/`, and every write (inside the runtime, beside it, in the private root, appending to the node binary).
 *   - `file-read*` on the real version folder: read and exec of Node, npm and their files; no write.
 *   - `file-read-metadata` on the private root and `runtime/` as LITERALS: stat for the realpath walk, never a listing.
 * Seatbelt matches resolved paths, so every path here is a real path. Fail closed: if anything cannot be resolved, the
 * runtime folder is not exactly `<real private root>/runtime/node-<version>-<chip>`, or `runtime` itself is a link out of
 * the private root, no rule is added and the profile stays as it was.
 *
 * BotBoy's Python (Python on demand, design §5 Q4 and review finding 3) adds the same kind of rule, per folder: the uv
 * folder in use, and `runtime/python` (uv's install folder: BotBoy's uv runs only its managed CPython, so it is read
 * whenever BotBoy's uv or Python is in use). Measured with sandbox-exec: Python needs only its read rule; uv also needs
 * the metadata rule, because it canonicalizes paths. The order is fixed: Node read, uv read, `runtime/python` read, ONE
 * metadata rule (when any read rule was added), then the D6 deny of the two Xcode stand-ins (with the uv or Python
 * rule only). Each folder is checked on its own, so one that fails closed opens nothing and leaves the others as they are.
 */
function runtimeReadRules(
  privateRoot: string,
  request: { node?: string | null; uv?: string | null; python?: string | null; denyXcodeStandIns?: boolean },
): { rules: string[]; opened: RuntimeOpened } {
  const opened: RuntimeOpened = {};
  if (![request.node, request.uv, request.python].some((dir) => dir && path.isAbsolute(dir))) return { rules: [], opened };
  let realRoot: string;
  let realRuntimeRoot: string;
  try {
    realRoot = fs.realpathSync.native(privateRoot);
    realRuntimeRoot = fs.realpathSync.native(path.join(privateRoot, 'runtime'));
  } catch {
    return { rules: [], opened };
  }
  if (realRuntimeRoot !== path.join(realRoot, 'runtime')) return { rules: [], opened };
  /** The real path of `dir` when it is a folder directly under the real `runtime/` whose name fits, else null. */
  const child = (dir: string | null | undefined, name: RegExp): string | null => {
    if (!dir || !path.isAbsolute(dir)) return null;
    try {
      const real = fs.realpathSync.native(dir);
      if (path.dirname(real) !== realRuntimeRoot || !name.test(path.basename(real))) return null;
      return fs.statSync(real).isDirectory() ? real : null;
    } catch {
      return null;
    }
  };
  const node = child(request.node, RUNTIME_VERSION_FOLDER);
  const uv = child(request.uv, UV_VERSION_FOLDER);
  const python = child(request.python, /^python$/);
  const rules: string[] = [];
  for (const [key, dir] of [['node', node], ['uv', uv], ['python', python]] as const) {
    if (!dir) continue;
    rules.push(`(allow file-read* (subpath ${sandboxLiteral(dir)}))`);
    opened[key] = dir;
  }
  if (rules.length === 0) return { rules, opened };
  rules.push(`(allow file-read-metadata (literal ${sandboxLiteral(realRoot)}) (literal ${sandboxLiteral(realRuntimeRoot)}))`);
  if (request.denyXcodeStandIns && (opened.uv || opened.python)) {
    rules.push(`(deny process-exec ${XCODE_STAND_INS.map((file) => `(literal ${sandboxLiteral(file)})`).join(' ')})`);
  }
  return { rules, opened };
}

/**
 * The folder a model-run process may READ and may not WRITE: the Knowledge library (knowledge-library.md K2, owner
 * decision "option A" of 2026-10-15). A guide in it is Operating Knowledge that steers later turns, and generated
 * presets and lessons now live in it instead of private state, so one `echo >> GUIDE.md` from an injected command
 * would be persistent prompt injection with no owner click. Every write goes through the knowledge tools in the
 * server process, which this profile does not reach.
 *
 * `index.ts` registers the provider right after the database opens, BEFORE the MCP manager launches its custom-command
 * servers (a server keeps the profile it was launched with, for its life). The provider returns the library's
 * canonical root, or null while no library exists, and is asked at each launch, so Change location applies to new
 * launches. With no provider, or a null answer, the profile is byte-identical to what it was before this existed.
 */
export type WriteProtectedRootProvider = () => string | readonly string[] | null;
let writeProtectedRootProvider: WriteProtectedRootProvider | null = null;

export function registerWriteProtectedRoots(provider: WriteProtectedRootProvider | null): void {
  writeProtectedRootProvider = provider;
}

/**
 * The roots a profile built now denies writes to, as real paths (the current root, and for the moment a location change
 * copies into a new one, both). A root that is, contains or lies inside BotBoy's private state is NOT honored: the deny
 * comes after the files-workspace allow, so honoring one that contains the files workspace would block `run_command`'s
 * only writable folder. Activation refuses such roots, so this is a second wall.
 */
export function writeProtectedRootsInEffect(options: { privateRoot?: string; filesDir?: string } = {}): string[] {
  if (!writeProtectedRootProvider) return [];
  let provided: string | readonly string[] | null = null;
  try { provided = writeProtectedRootProvider(); } catch { provided = null; }
  const candidates = Array.isArray(provided) ? provided : [provided];
  const privateRoot = canonicalLocalPath(options.privateRoot ?? path.join(os.homedir(), '.personal-productivity-tracker'));
  const filesDir = canonicalLocalPath(options.filesDir ?? path.join(privateRoot, 'files'));
  const roots: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || /[\0\r\n]/.test(candidate)) continue;
    const root = canonicalLocalPath(candidate);
    if (inside(root, privateRoot) || inside(privateRoot, root) || inside(root, filesDir) || inside(filesDir, root)) continue;
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}

function modelSandboxBoundary(options: ModelCommandSandboxOptions): ModelSandboxBoundary {
  const appPort = validPort(options.appPort ?? process.env.PPT_PORT, DEFAULT_APP_PORT);
  const cdpPort = validPort(options.cdpPort, DEFAULT_CDP_PORT);
  const privateRoot = path.resolve(options.privateRoot ?? path.join(os.homedir(), '.personal-productivity-tracker'));
  const filesDir = path.resolve(options.filesDir ?? path.join(privateRoot, 'files'));
  if (filesDir !== privateRoot && !filesDir.startsWith(`${privateRoot}${path.sep}`)) {
    throw new Error('Model command files directory must remain inside BotBoy private storage.');
  }
  const { rules: runtimeRules, opened } = runtimeReadRules(privateRoot, {
    node: options.runtimeReadDir,
    uv: options.uvReadDir,
    python: options.pythonReadDir,
    denyXcodeStandIns: options.denyXcodeStandIns,
  });
  return {
    filesDir,
    runtimeRead: runtimeRules.length > 0,
    opened,
    profile: [
      '(version 1)',
      '(allow default)',
      `(deny network-outbound (remote ip "localhost:${appPort}"))`,
      `(deny network-outbound (remote ip "localhost:${cdpPort}"))`,
      '(deny appleevent-send)',
      `(deny file-read* file-write* (subpath ${sandboxLiteral(privateRoot)}))`,
      `(allow file-read* file-write* (subpath ${sandboxLiteral(filesDir)}))`,
      // Later rules win in Seatbelt, so these come after the private-root deny. Absent unless a runtime folder was named.
      ...runtimeRules,
      // Last, so nothing above can re-open it. Absent unless the Knowledge library exists (see writeProtectedRootsInEffect).
      ...writeProtectedRootsInEffect({ privateRoot: options.privateRoot, filesDir: options.filesDir })
        .map((root) => `(deny file-write* (subpath ${sandboxLiteral(root)}))`),
    ].join(' '),
  };
}

export interface SandboxInvocation {
  executable: '/usr/bin/sandbox-exec';
  args: string[];
  filesDir: string;
  profile: string;
  runtimeRead: boolean;
  opened: RuntimeOpened;
}

export function modelProcessSandboxInvocation(
  executable: string,
  args: string[],
  options: ModelCommandSandboxOptions = {},
): SandboxInvocation {
  const boundary = modelSandboxBoundary(options);
  return {
    executable: '/usr/bin/sandbox-exec',
    args: ['-p', boundary.profile, executable, ...args],
    ...boundary,
  };
}

/** A string as one shell word, in single quotes. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Only absolute folders without a line break or NUL can go into a login line. */
const usableLoginFolders = (entries: readonly string[] | undefined) => (entries ?? []).filter((entry) => path.isAbsolute(entry) && !/[\0\r\n]/.test(entry));

/**
 * The line a LOGIN shell's command starts with so that `first` folders lead PATH and `last` folders end it after the
 * owner's profile files ran (`/etc/zprofile`'s `path_helper` moves the system folders in front, and a `~/.zprofile` or
 * `~/.bash_profile` may reset PATH). `${PATH:+:"$PATH"}` keeps the rest and adds nothing when a profile left it empty.
 * Every folder is one quoted word. Empty when `first` is empty: then the command is exactly what it was.
 */
export function loginPathLine(first: readonly string[], last: readonly string[] = []): string {
  const lead = usableLoginFolders(first);
  if (lead.length === 0) return '';
  return 'export PATH=' + lead.map(shellQuote).join(':') + '${PATH:+:"$PATH"}' + usableLoginFolders(last).map((entry) => ':' + shellQuote(entry)).join('') + '; ';
}

/** Whether `entry` (a PATH folder) lies inside one of the opened runtime folders, compared on real paths. */
function insideOpened(entry: string, opened: RuntimeOpened): boolean {
  const real = canonicalLocalPath(entry);
  return Object.values(opened).some((dir) => typeof dir === 'string' && inside(real, dir));
}

/**
 * Every model-authored shell runs under one non-waivable macOS Seatbelt
 * profile. Descendants cannot call BotBoy/CDP, automate native UI, or read or
 * mutate BotBoy's private state; the intentional files workspace remains
 * available, including its owner-created source/build links.
 */
export function modelCommandSandboxInvocation(
  command: string,
  options: ModelCommandSandboxOptions = {},
): SandboxInvocation {
  const boundary = modelSandboxBoundary(options);
  // A leading folder counts only when it lies inside a runtime folder this profile opened (a folder the profile denies
  // would give a half-working program); the end folders come only together with one.
  const first = usableLoginFolders(options.loginPathFirst).filter((entry) => insideOpened(entry, boundary.opened));
  const line = loginPathLine(first, options.loginPathLast) + command;
  return {
    executable: '/usr/bin/sandbox-exec',
    args: ['-p', boundary.profile, options.shell ?? '/bin/zsh', '-lc', line],
    ...boundary,
  };
}

/**
 * BotBoy's own inference credentials. The launcher exports them so the server
 * can authenticate to its model provider; model-run commands never need them.
 * Exact names only, so the owner's other tool settings (AWS profiles, PATH,
 * tokens their own CLIs use) keep working inside the sandboxed shell. The
 * Settings → AI model key is never in the environment at all.
 */
export const BOTBOY_CREDENTIAL_ENV_KEYS: readonly string[] = Object.freeze([
  'BOTBOY_INFERENCE_OAUTH_CLIENT_ID',
  'BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET',
  'BOTBOY_INFERENCE_API_KEY',
  'VLLM_API_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
]);

/**
 * Where BotBoy keeps its own copy of Node for a Mac that has none (start.sh › scripts/node-runtime.sh):
 * `~/.personal-productivity-tracker/runtime/node-<version>-<chip>/bin`. start.sh puts that `bin` first on the server's
 * PATH, so BotBoy's own scripts, npm and updater find it.
 */
export function privateRuntimeRoot(home: string = os.homedir()): string {
  return path.join(home, '.personal-productivity-tracker', 'runtime');
}

/**
 * The version folder of BotBoy's own Node (`<private root>/runtime/node-<version>-<chip>`, as a real path) when THIS
 * process runs on it, otherwise null. It is the answer to "does the sandbox for a user-added MCP server need to read the
 * private Node?": on a Mac that uses its own Node this is null and the profile is not touched. Only the real path of
 * `execPath` decides, so a link into the runtime counts and a link out of it does not; anything that cannot be resolved,
 * or a file that lies outside a `node-<version>-<chip>` folder directly under `runtime/`, gives null.
 */
export function privateRuntimeDirInUse(options: { execPath?: string; privateRoot?: string } = {}): string | null {
  try {
    const privateRoot = options.privateRoot ?? path.join(os.homedir(), '.personal-productivity-tracker');
    const runtimeRoot = path.join(fs.realpathSync.native(privateRoot), 'runtime');
    const executable = fs.realpathSync.native(options.execPath ?? process.execPath);
    const relative = path.relative(runtimeRoot, executable);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    const folder = relative.split(path.sep)[0];
    return RUNTIME_VERSION_FOLDER.test(folder) ? path.join(runtimeRoot, folder) : null;
  } catch {
    return null;
  }
}

/** What a child of this process needs to know when BotBoy runs on its own Node. */
export interface PrivateNodeUse {
  /** Real path of the runtime version folder in use: `<private root>/runtime/node-<version>-<chip>`. */
  runtimeDir: string;
  /** `<runtimeDir>/bin`: where `node`, `npm` and `npx` are. */
  runtimeBin: string;
  /** Where `npm install -g` puts packages for sandboxed children (the runtime is read-only to them): `~/.npm-global`. */
  globalPrefix: string;
  /** `<globalPrefix>/bin`: where those packages' commands land. */
  globalBin: string;
}

/**
 * Null on a Mac that uses its own Node (then nothing about a child changes), otherwise the runtime BotBoy runs on.
 * One answer for the pieces that must agree: the sandbox profile (`runtimeReadDir`), the login-shell PATH line
 * (`loginPathFirst`) and the child's environment (`modelChildEnvironment`).
 */
export function privateNodeUse(options: { execPath?: string; privateRoot?: string } = {}): PrivateNodeUse | null {
  const runtimeDir = privateRuntimeDirInUse(options);
  if (!runtimeDir) return null;
  // The global prefix sits beside the private root, in the same home folder (the default root is ~/.personal-productivity-tracker).
  const home = path.dirname(path.resolve(options.privateRoot ?? path.join(os.homedir(), '.personal-productivity-tracker')));
  const globalPrefix = path.join(home, '.npm-global');
  return { runtimeDir, runtimeBin: path.join(runtimeDir, 'bin'), globalPrefix, globalBin: path.join(globalPrefix, 'bin') };
}

/**
 * npm's own fix for EACCES on global installs, for a SANDBOXED child of BotBoy's Node (chat commands, the chat terminal,
 * a user-added MCP server): `npm install -g` would write into the runtime, which the sandbox keeps read-only, so the
 * prefix becomes `~/.npm-global` (created here, on first use) and its bin goes at the END of PATH, so a global package
 * can add a command and never shadow one found earlier. `declared` is the environment the owner declared for a user-added
 * server: a prefix set there is kept. Never applied to BotBoy's own process or to a child that runs without the sandbox
 * (a program there must not resolve from a folder that sandboxed code can write).
 */
export function npmGlobalEnvironment<T extends Record<string, string | undefined>>(
  env: T,
  use: PrivateNodeUse,
  declared: Record<string, string | undefined> = {},
): T {
  try { fs.mkdirSync(use.globalBin, { recursive: true }); } catch { /* npm creates it on the first install */ }
  const next: Record<string, string | undefined> = { ...env };
  if (typeof next.PATH === 'string' && next.PATH !== '' && !next.PATH.split(path.delimiter).includes(use.globalBin)) {
    next.PATH = `${next.PATH}${path.delimiter}${use.globalBin}`;
  }
  if (!('npm_config_prefix' in declared) && !('NPM_CONFIG_PREFIX' in declared)) {
    delete next.NPM_CONFIG_PREFIX;
    next.npm_config_prefix = use.globalPrefix;
  }
  return next as T;
}

/**
 * A PATH without the entries under BotBoy's private runtime folder, for a child whose sandbox cannot read that folder:
 * the profile denies private state, so a Node found there would be half-working (a denied entry is skipped when another
 * `node` follows, but when nothing follows, `node` still starts by exec while `npm` fails to read its own files:
 * measured with sandbox-exec on 2026-10-14). While BotBoy runs on its own Node, chat commands, the chat terminal and
 * user-added MCP servers are NOT such children: their profile can read the runtime folder in use (`runtimeReadDir`)
 * and keep the entry. Order, empty entries and every other entry are kept.
 * `keep`: runtime folders the child's profile opened (real paths, `RuntimeOpened`); an entry inside one of them stays.
 * The same holds for BotBoy's Python: a `python3` entry the profile cannot read would fall through to the next
 * `python3` on PATH, which on a bare Mac is Apple's stand-in (measured with a tripwire, design review finding 4).
 */
export function pathWithoutPrivateRuntime(pathValue: string, root: string = privateRuntimeRoot(), keep: readonly (string | undefined)[] = []): string {
  const canonicalRoot = canonicalLocalPath(root);
  const kept = keep.filter((dir): dir is string => typeof dir === 'string' && dir !== '');
  return pathValue
    .split(path.delimiter)
    .filter((entry) => {
      if (entry === '') return true;
      const real = canonicalLocalPath(entry);
      if (!(inside(entry, root) || inside(real, canonicalRoot))) return true;
      return kept.some((dir) => inside(real, dir));
    })
    .join(path.delimiter);
}

/**
 * Environment for a model-run child: the server's environment minus BotBoy credentials. `extra` is applied last, as
 * before. `use` (required: pass `null` for "BotBoy's Node not in use, or not opened by this child's profile") and
 * `python` (what the profile opened of BotBoy's uv and CPython; default none) say which of BotBoy's runtimes the child's
 * sandbox can read. PATH keeps the entries under the private runtime folder that lie inside those folders and loses
 * every other one (`pathWithoutPrivateRuntime`), because a folder the profile denies would give a half-working program.
 * Node adds npm's global prefix (`npmGlobalEnvironment`); BotBoy's uv or Python adds `~/.botboy-python`
 * (`pythonUserEnvironment`). With nothing of BotBoy's in use the environment is what it was.
 */
export function modelChildEnvironment(
  extra: Record<string, string>,
  base: NodeJS.ProcessEnv,
  use: PrivateNodeUse | null,
  python: PythonChildAccess | null = null,
): Record<string, string> {
  const denied = new Set(BOTBOY_CREDENTIAL_ENV_KEYS);
  let env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === 'string' && !denied.has(key)) env[key] = value;
  }
  if (typeof env.PATH === 'string') env.PATH = pathWithoutPrivateRuntime(env.PATH, privateRuntimeRoot(), [use?.runtimeDir, python?.uvDir ?? undefined, python?.pythonRoot ?? undefined]);
  if (use) env = npmGlobalEnvironment(env, use);
  if (python) env = pythonUserEnvironment(env, python);
  return { ...env, ...extra };
}

/** BotBoy's own uv, when it is the `uv` on this process's PATH (start.sh puts it there on a Mac without a usable uv). */
export interface PrivateUvUse {
  /** Real path of the uv folder in use: `<private root>/runtime/uv-<version>-<chip>` (the wrappers and `libexec/`). */
  uvDir: string;
  /** Real path of `<private root>/runtime/python`: the CPython BotBoy's uv runs (its only managed Python). */
  pythonRoot: string;
}

/** BotBoy's own CPython, when it is the `python3` on this process's PATH (a Mac without a usable Python). */
export interface PrivatePythonUse {
  /** Real path of `<private root>/runtime/python`. */
  pythonRoot: string;
  /** The PATH folder that holds it, as start.sh wrote it (the minor link's `bin`, so a patch update keeps it valid). */
  pythonBin: string;
}

/** What a child needs to know when BotBoy's own uv or CPython is in use; null when neither is. */
export interface PythonRuntimeUse {
  uv: PrivateUvUse | null;
  python: PrivatePythonUse | null;
  /** `~/.botboy-python`: the ONE folder BotBoy's Python work writes (uv cache and tools, `pip --user`), outside the private root. */
  userBase: string;
  /** `<userBase>/bin`: where `uv tool install` and `pip install --user` put commands. */
  userBin: string;
}

/** The first executable regular file called `name` in the absolute folders of `pathValue`, or null. Nothing is run. */
function firstExecutableOnPath(name: string, pathValue: string): string | null {
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function realRuntimeRootOf(privateRoot: string | undefined): string | null {
  try {
    const root = fs.realpathSync.native(privateRoot ?? path.join(os.homedir(), '.personal-productivity-tracker'));
    const runtime = fs.realpathSync.native(path.join(root, 'runtime'));
    return runtime === path.join(root, 'runtime') ? runtime : null;
  } catch {
    return null;
  }
}

/**
 * BotBoy's uv folder when the first `uv` on PATH (default: this process's) is its wrapper: its real path's folder is a
 * `uv-<version>-<chip>` folder directly under the real `runtime/`. Anything else, or anything unresolved, gives null, and
 * nothing about a child changes.
 */
export function privateUvUse(options: { pathValue?: string; privateRoot?: string } = {}): PrivateUvUse | null {
  const runtime = realRuntimeRootOf(options.privateRoot);
  if (!runtime) return null;
  const hit = firstExecutableOnPath('uv', options.pathValue ?? process.env.PATH ?? '');
  if (!hit) return null;
  try {
    const dir = path.dirname(fs.realpathSync.native(hit));
    if (path.dirname(dir) !== runtime || !UV_VERSION_FOLDER.test(path.basename(dir))) return null;
    return { uvDir: dir, pythonRoot: path.join(runtime, 'python') };
  } catch {
    return null;
  }
}

/**
 * BotBoy's CPython when the first `python3` on PATH (default: this process's) is it: its real path lies in
 * `<real runtime>/python/cpython-<x.y.z>-macos-<chip>-none/bin/`. Anything else gives null.
 */
export function privatePythonUse(options: { pathValue?: string; privateRoot?: string } = {}): PrivatePythonUse | null {
  const runtime = realRuntimeRootOf(options.privateRoot);
  if (!runtime) return null;
  const hit = firstExecutableOnPath('python3', options.pathValue ?? process.env.PATH ?? '');
  if (!hit) return null;
  try {
    const pythonRoot = path.join(runtime, 'python');
    const parts = path.relative(pythonRoot, fs.realpathSync.native(hit)).split(path.sep);
    if (parts.length !== 3 || parts[1] !== 'bin' || !CPYTHON_FOLDER.test(parts[0])) return null;
    return { pythonRoot, pythonBin: path.dirname(hit) };
  } catch {
    return null;
  }
}

/** Null when neither BotBoy's uv nor its CPython is in use (a Mac whose own Python and uv work); otherwise both answers. */
export function pythonRuntimeUse(options: { pathValue?: string; privateRoot?: string } = {}): PythonRuntimeUse | null {
  const uv = privateUvUse(options);
  const python = privatePythonUse(options);
  if (!uv && !python) return null;
  const home = path.dirname(path.resolve(options.privateRoot ?? path.join(os.homedir(), '.personal-productivity-tracker')));
  const userBase = path.join(home, '.botboy-python');
  return { uv, python, userBase, userBin: path.join(userBase, 'bin') };
}

/** The sandbox options for what `pythonRuntimeUse()` found: uv's folder, and `runtime/python` for uv or Python. */
export function pythonSandboxOptions(use: PythonRuntimeUse | null, denyXcodeStandIns: boolean): Pick<ModelCommandSandboxOptions, 'uvReadDir' | 'pythonReadDir' | 'denyXcodeStandIns'> {
  if (!use) return {};
  return {
    uvReadDir: use.uv?.uvDir ?? null,
    pythonReadDir: (use.uv ?? use.python)!.pythonRoot,
    denyXcodeStandIns,
  };
}

/** What a sandboxed child may use of BotBoy's uv and CPython: only what its profile opened (`RuntimeOpened`). */
export interface PythonChildAccess {
  /** The opened uv folder, when BotBoy's uv is in use. */
  uvDir: string | null;
  /** The opened `runtime/python` (read for BotBoy's uv or Python). */
  pythonRoot: string | null;
  /** True only when BotBoy's CPython is the `python3` children resolve AND its folder was opened ("in use", not just "readable"). */
  pythonInUse: boolean;
  userBase: string;
  userBin: string;
}

/** The access a child gets from what is in use and what its profile opened; null when nothing of BotBoy's Python is open. */
export function pythonChildAccess(use: PythonRuntimeUse | null, opened: RuntimeOpened): PythonChildAccess | null {
  if (!use) return null;
  const uvDir = use.uv && opened.uv ? opened.uv : null;
  const pythonRoot = opened.python ?? null;
  const pythonInUse = Boolean(use.python && pythonRoot);
  if (!uvDir && !pythonInUse) return null;
  return { uvDir, pythonRoot, pythonInUse, userBase: use.userBase, userBin: use.userBin };
}

/**
 * `~/.botboy-python` for a SANDBOXED child of BotBoy's uv or Python (chat commands, the chat terminal, a user-added MCP
 * server): the folder is created on first use with mode 0700, and its `bin` goes at the END of PATH (after npm's global
 * bin), so `uv tool install` and `pip install --user` commands are found and never shadow one found earlier. Only while
 * BotBoy's CPython is the Python in use (`pythonInUse`, design review finding 8 and the orchestrator's clarification 1):
 * `PYTHONUSERBASE=~/.botboy-python` (pip's user scripts land in that same `bin`) and `PIP_BREAK_SYSTEM_PACKAGES=1`, so a
 * plain `pip install <package>` goes to the user site in one round (BotBoy's runtime stays read-only; a venv is
 * unaffected). Never `PIP_USER` (it breaks pip in a venv). `declared` is the environment the owner declared for a server:
 * a value set there is kept. Never applied to BotBoy's own process or to a child that runs without the sandbox, and never
 * when this Mac's own Python is the one in use (its pip must behave exactly as before).
 */
export function pythonUserEnvironment<T extends Record<string, string | undefined>>(
  env: T,
  access: PythonChildAccess,
  declared: Record<string, string | undefined> = {},
): T {
  try {
    fs.mkdirSync(access.userBase, { recursive: true, mode: 0o700 });
    fs.mkdirSync(access.userBin, { recursive: true, mode: 0o700 });
  } catch {
    // uv and pip create what they need
  }
  const next: Record<string, string | undefined> = { ...env };
  if (typeof next.PATH === 'string' && next.PATH !== '' && !next.PATH.split(path.delimiter).includes(access.userBin)) {
    next.PATH = `${next.PATH}${path.delimiter}${access.userBin}`;
  }
  if (access.pythonInUse) {
    if (!('PYTHONUSERBASE' in declared)) next.PYTHONUSERBASE = access.userBase;
    if (!('PIP_BREAK_SYSTEM_PACKAGES' in declared)) next.PIP_BREAK_SYSTEM_PACKAGES = '1';
  }
  return next as T;
}

export interface ModelShellLaunch {
  executable: '/usr/bin/sandbox-exec';
  args: string[];
  filesDir: string;
  profile: string;
  env: Record<string, string>;
}

/**
 * The sandboxed `zsh -lc <command>` of run_command and of the chat terminal, with its environment, in one place so the
 * profile, the PATH line and the environment cannot disagree. While BotBoy runs on its own Node (`use`, default
 * `privateNodeUse()`), the child can READ that runtime (`runtimeReadDir`), its command starts with a PATH line that puts
 * the runtime's bin first after the login files ran (`loginPathFirst`), and its environment keeps the runtime on PATH.
 * On a Mac that uses its own Node none of that is added: profile, command line and environment are what they were.
 * `base` is the environment to start from (default: this process's), `extraEnv` is applied last.
 */
export function modelShellLaunch(
  command: string,
  options: ModelCommandSandboxOptions & {
    extraEnv?: Record<string, string>;
    base?: NodeJS.ProcessEnv;
    use?: PrivateNodeUse | null;
    /** BotBoy's uv and CPython (default `pythonRuntimeUse()`; `null` for "not in use"). */
    pythonUse?: PythonRuntimeUse | null;
  } = {},
): ModelShellLaunch {
  const { extraEnv, base, use: given, pythonUse: givenPython, ...sandbox } = options;
  const use = given === undefined ? privateNodeUse() : given;
  const pythonUse = givenPython === undefined ? pythonRuntimeUse() : givenPython;
  // D6 is judged only while BotBoy's uv or Python is in use, from a cached answer (never a process on this path).
  const deny = pythonUse ? (sandbox.denyXcodeStandIns ?? commandLineToolsKnown() !== true) : false;
  const readDirs: ModelCommandSandboxOptions = {
    ...(use ? { runtimeReadDir: use.runtimeDir } : {}),
    ...pythonSandboxOptions(pythonUse, deny),
  };
  // Which folders the profile really opens decides the PATH line and the environment (design review finding 3).
  const { opened } = modelSandboxBoundary({ ...sandbox, ...readDirs });
  const python = pythonChildAccess(pythonUse, opened);
  const nodeOpen = use && opened.node ? use : null;
  // Server order: BotBoy's Python bin, its uv folder, its Node bin; then npm's global bin and ~/.botboy-python/bin at the end.
  const first = [
    ...(python?.pythonInUse && pythonUse?.python ? [pythonUse.python.pythonBin] : []),
    ...(python?.uvDir ? [python.uvDir] : []),
    ...(nodeOpen ? [nodeOpen.runtimeBin] : []),
  ];
  const last = [...(nodeOpen ? [nodeOpen.globalBin] : []), ...(python ? [python.userBin] : [])];
  const invocation = modelCommandSandboxInvocation(command, { ...sandbox, ...readDirs, loginPathFirst: first, loginPathLast: last });
  const env = modelChildEnvironment({ BOTBOY_FILES: invocation.filesDir, ...(extraEnv ?? {}) }, base ?? process.env, nodeOpen, python);
  return {
    executable: invocation.executable,
    args: invocation.args,
    filesDir: invocation.filesDir,
    profile: invocation.profile,
    env,
  };
}

/**
 * Canonical on-disk path. The native resolver matters on macOS: its volumes
 * fold letter case, and the JavaScript resolver keeps whatever case a caller
 * or link spelled, so `.PERSONAL-productivity-tracker/.env` would open the
 * real file while failing a case-sensitive containment check.
 */
export function canonicalLocalPath(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  }
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * True when `target`, after resolving every link, lands in BotBoy private
 * state outside the files workspace: the same boundary the model-command
 * Seatbelt profile enforces for child processes, applied to in-process file
 * tools (which run outside the sandbox). Links to the BotBoy source/build
 * checkout or anywhere outside private state are unaffected.
 */
export function resolvesIntoPrivateState(
  target: string,
  options: { privateRoot?: string; filesDir?: string } = {},
): boolean {
  const privateRoot = canonicalLocalPath(options.privateRoot ?? path.join(os.homedir(), '.personal-productivity-tracker'));
  const filesDir = canonicalLocalPath(options.filesDir ?? path.join(privateRoot, 'files'));
  const real = canonicalLocalPath(target);
  return inside(real, privateRoot) && !inside(real, filesDir);
}
