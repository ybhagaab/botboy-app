/**
 * Python on demand (design §5 Q4; design review findings 3, 4, 8, 10 and 11; orchestrator clarifications 1, 3 and 4):
 * the sandbox around chat commands, the chat terminal and user-added MCP servers may READ BotBoy's own uv folder
 * (`runtime/uv-<version>-<chip>`) and `runtime/python`, per folder and fail closed, plus the one metadata rule Node
 * already adds. Two notions stay apart:
 *  - "readable": the `runtime/python` rule, opened whenever BotBoy's uv OR BotBoy's Python is in use (uv runs only its
 *    managed CPython);
 *  - "in use": BotBoy's CPython is the `python3` children resolve. Only then do they get PYTHONUSERBASE,
 *    PIP_BREAK_SYSTEM_PACKAGES=1 and BotBoy's Python bin on the login line. A Mac with its own Python and BotBoy's uv
 *    keeps its own pip exactly as it was.
 * `~/.botboy-python` (mode 0700) is where sandboxed Python work writes; its `bin` goes at the END of PATH.
 *
 * The hermetic cases use a stand-in runtime (shell scripts named like uv and CPython) under a temporary HOME and private
 * root, with the real /usr/bin/sandbox-exec and the real /bin/zsh. The cases marked "real pinned runtime" need a
 * runtime folder that scripts/python-runtime.sh installed (BOTBOY_TEST_PYTHON_FIXTURE=<…>/runtime) and are skipped
 * otherwise, as livePrivateNode does for Node. Nothing here runs Apple's python3 or install_name_tool stand-ins.
 */
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandLineToolsKnown, refreshCommandLineTools, resetCommandLineToolsForTests } from './command-line-tools.js';
import {
  loginPathLine,
  modelChildEnvironment,
  modelCommandSandboxInvocation,
  modelProcessSandboxInvocation,
  modelShellLaunch,
  pathWithoutPrivateRuntime,
  privatePythonUse,
  privateUvUse,
  pythonChildAccess,
  pythonRuntimeUse,
  pythonSandboxOptions,
  pythonUserEnvironment,
  type PrivateNodeUse,
  type PythonRuntimeUse,
} from './protected-local-resources.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORTS = { appPort: 7778, cdpPort: 9222 };
const sandboxLive = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');
const realRuntime = process.env.BOTBOY_TEST_PYTHON_FIXTURE ?? '';
const liveRealPython = sandboxLive && path.isAbsolute(realRuntime) && fs.existsSync(path.join(realRuntime, 'python'));
/** Apple's second Xcode stand-in, spelled so that no test file holds its literal path (test-hygiene.test.ts). */
const INSTALL_NAME_TOOL = path.join('/usr/bin', 'install_name_tool');
const DENY = `(deny process-exec (literal "/usr/bin/python3") (literal "${INSTALL_NAME_TOOL}"))`;
const baseline = (root: string, files: string) =>
  `(version 1) (allow default) (deny network-outbound (remote ip "localhost:7778")) (deny network-outbound (remote ip "localhost:9222")) (deny appleevent-send) (deny file-read* file-write* (subpath "${root}")) (allow file-read* file-write* (subpath "${files}"))`;
const read = (dir: string) => ` (allow file-read* (subpath "${dir}"))`;

interface Fixture {
  home: string;
  privateRoot: string;
  filesDir: string;
  runtimeRoot: string;
  nodeDir: string;
  uvDir: string;
  pythonRoot: string;
  patchDir: string;
  /** `runtime/python/cpython-3.13-…/bin`: the minor link's bin, as start.sh puts it on PATH. */
  pythonBin: string;
  userBase: string;
  userBin: string;
  /** A folder that stands for this Mac's own Python (Homebrew-like), with a `python3` that says so. */
  ownPythonBin: string;
}

const script = (file: string, body: string) => fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });

/** A stand-in runtime: folders named exactly as scripts/python-runtime.sh names them, holding shell scripts. */
function createFixture(): Fixture {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-py-sandbox-')));
  const privateRoot = path.join(home, '.personal-productivity-tracker');
  const filesDir = path.join(privateRoot, 'files');
  const runtimeRoot = path.join(privateRoot, 'runtime');
  const nodeDir = path.join(runtimeRoot, 'node-24.21.0-arm64');
  const uvDir = path.join(runtimeRoot, 'uv-0.13.0-arm64');
  const pythonRoot = path.join(runtimeRoot, 'python');
  const patchDir = path.join(pythonRoot, 'cpython-3.13.16-macos-aarch64-none');
  const minorLink = path.join(pythonRoot, 'cpython-3.13-macos-aarch64-none');
  const ownPythonBin = path.join(home, 'homebrew', 'bin');
  for (const dir of [filesDir, path.join(nodeDir, 'bin'), path.join(uvDir, 'libexec'), path.join(patchDir, 'bin'), ownPythonBin]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.symlinkSync(patchDir, minorLink); // absolute, as start.sh makes it
  script(path.join(patchDir, 'bin', 'python3.13'), 'echo "botboy-cpython 3.13.16"');
  fs.symlinkSync('python3.13', path.join(patchDir, 'bin', 'python3'));
  script(path.join(uvDir, 'libexec', 'uv'), 'echo "uv 0.13.0"');
  script(path.join(uvDir, 'libexec', 'uvx'), 'echo "uvx 0.13.0"');
  script(path.join(uvDir, 'uv'), `exec '${path.join(uvDir, 'libexec', 'uv')}' "$@"`);
  script(path.join(uvDir, 'uvx'), `exec '${path.join(uvDir, 'libexec', 'uvx')}' "$@"`);
  script(path.join(ownPythonBin, 'python3'), 'echo "own-python 3.14.7"');
  fs.writeFileSync(path.join(privateRoot, 'ai-model.json'), '{"apiKey":"secretkey"}');
  fs.writeFileSync(path.join(privateRoot, 'tracker.db'), 'secretkey database');
  const userBase = path.join(home, '.botboy-python');
  return {
    home, privateRoot, filesDir, runtimeRoot, nodeDir, uvDir, pythonRoot, patchDir,
    pythonBin: path.join(minorLink, 'bin'), userBase, userBin: path.join(userBase, 'bin'), ownPythonBin,
  };
}

let fx: Fixture;
const roots: string[] = [];
beforeAll(() => {
  fx = createFixture();
  roots.push(fx.home);
});
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  // The server's HOME is the private root's: os.homedir() (the default private root of the PATH strip) must say so too.
  vi.stubEnv('HOME', fx.home);
  resetCommandLineToolsForTests(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetCommandLineToolsForTests(null);
  fs.rmSync(path.join(fx.home, '.zprofile'), { force: true });
  fs.rmSync(fx.userBase, { recursive: true, force: true });
});

const profileOf = (options: Parameters<typeof modelProcessSandboxInvocation>[2] = {}) =>
  modelProcessSandboxInvocation('/usr/bin/true', [], { privateRoot: fx.privateRoot, filesDir: fx.filesDir, ...PORTS, ...options }).profile;
const nodeUse = (): PrivateNodeUse => ({
  runtimeDir: fx.nodeDir,
  runtimeBin: path.join(fx.nodeDir, 'bin'),
  globalPrefix: path.join(fx.home, '.npm-global'),
  globalBin: path.join(fx.home, '.npm-global', 'bin'),
});
/** What pythonRuntimeUse() finds on a PATH, for the fixture's private root. */
const useOn = (pathValue: string) => pythonRuntimeUse({ pathValue, privateRoot: fx.privateRoot });
const bothPath = () => [fx.pythonBin, fx.uvDir, '/usr/bin', '/bin'].join(path.delimiter);
const uvOnlyPath = () => [fx.uvDir, fx.ownPythonBin, '/usr/bin', '/bin'].join(path.delimiter);
const pythonOnlyPath = () => [fx.pythonBin, '/usr/bin', '/bin'].join(path.delimiter);

describe('the profile: golden strings for none, Node, Python, uv and all', () => {
  const meta = () => ` (allow file-read-metadata (literal "${fx.privateRoot}") (literal "${fx.runtimeRoot}"))`;

  it('none: byte-identical to the profile before Python existed, whatever is not named or is empty', () => {
    const expected = baseline(fx.privateRoot, fx.filesDir);
    expect(profileOf()).toBe(expected);
    expect(profileOf({ uvReadDir: null, pythonReadDir: null })).toBe(expected);
    expect(profileOf({ uvReadDir: '', pythonReadDir: '' })).toBe(expected);
    // The D6 deny never comes alone.
    expect(profileOf({ denyXcodeStandIns: true })).toBe(expected);
    expect(modelCommandSandboxInvocation('true', { privateRoot: fx.privateRoot, filesDir: fx.filesDir, ...PORTS }).profile).toBe(expected);
  });

  it('Node: its read rule and the metadata rule, and never the D6 deny (it belongs to uv and Python)', () => {
    expect(profileOf({ runtimeReadDir: fx.nodeDir, denyXcodeStandIns: true })).toBe(baseline(fx.privateRoot, fx.filesDir) + read(fx.nodeDir) + meta());
  });

  it('Python: the runtime/python read rule and the metadata rule; the deny only when asked', () => {
    expect(profileOf({ pythonReadDir: fx.pythonRoot })).toBe(baseline(fx.privateRoot, fx.filesDir) + read(fx.pythonRoot) + meta());
    expect(profileOf({ pythonReadDir: fx.pythonRoot, denyXcodeStandIns: true })).toBe(baseline(fx.privateRoot, fx.filesDir) + read(fx.pythonRoot) + meta() + ` ${DENY}`);
  });

  it('uv: its folder\'s read rule and the metadata rule (uv canonicalizes paths); the deny only when asked', () => {
    expect(profileOf({ uvReadDir: fx.uvDir })).toBe(baseline(fx.privateRoot, fx.filesDir) + read(fx.uvDir) + meta());
    expect(profileOf({ uvReadDir: fx.uvDir, denyXcodeStandIns: true })).toBe(baseline(fx.privateRoot, fx.filesDir) + read(fx.uvDir) + meta() + ` ${DENY}`);
  });

  it('all: Node read, uv read, runtime/python read, ONE metadata rule, then the deny, in that order', () => {
    const invocation = modelProcessSandboxInvocation('/usr/bin/true', [], {
      privateRoot: fx.privateRoot, filesDir: fx.filesDir, ...PORTS,
      runtimeReadDir: fx.nodeDir, uvReadDir: fx.uvDir, pythonReadDir: fx.pythonRoot, denyXcodeStandIns: true,
    });
    expect(invocation.profile).toBe(baseline(fx.privateRoot, fx.filesDir) + read(fx.nodeDir) + read(fx.uvDir) + read(fx.pythonRoot) + meta() + ` ${DENY}`);
    expect(invocation.opened).toEqual({ node: fx.nodeDir, uv: fx.uvDir, python: fx.pythonRoot });
    expect(invocation.runtimeRead).toBe(true);
    // Read only: no write, no exec allow, and metadata only for the two parents.
    const added = invocation.profile.slice(baseline(fx.privateRoot, fx.filesDir).length);
    expect(added).not.toMatch(/file-write|allow process-exec|file-read-data|file-read\* \(literal/);
    expect(added.match(/file-read-metadata/g)).toHaveLength(1);
  });

  it('names real paths: a link to the uv folder or a private root reached through a link is resolved', () => {
    fs.symlinkSync(fx.uvDir, path.join(fx.runtimeRoot, 'uv-0.12.9-arm64'));
    try {
      expect(profileOf({ uvReadDir: path.join(fx.runtimeRoot, 'uv-0.12.9-arm64') })).toContain(read(fx.uvDir));
      const linkedRoot = path.join(fx.home, 'rootlink');
      fs.symlinkSync(fx.privateRoot, linkedRoot);
      const viaLink = modelProcessSandboxInvocation('/usr/bin/true', [], { privateRoot: linkedRoot, ...PORTS, pythonReadDir: path.join(linkedRoot, 'runtime', 'python') });
      expect(viaLink.opened).toEqual({ python: fx.pythonRoot });
      expect(viaLink.profile).toContain(`${read(fx.pythonRoot)} (allow file-read-metadata (literal "${fx.privateRoot}") (literal "${fx.runtimeRoot}"))`);
    } finally {
      fs.rmSync(path.join(fx.runtimeRoot, 'uv-0.12.9-arm64'), { force: true });
      fs.rmSync(path.join(fx.home, 'rootlink'), { force: true });
    }
  });
});

describe('fail closed, per folder: a folder that is not exactly BotBoy\'s opens nothing and leaves the others as they are', () => {
  const outside = () => path.join(fx.home, 'elsewhere');
  beforeAll(() => {
    fs.mkdirSync(path.join(outside(), 'uv-0.13.0-arm64'), { recursive: true });
    fs.mkdirSync(path.join(outside(), 'python'), { recursive: true });
    fs.mkdirSync(path.join(fx.runtimeRoot, 'uv-0.13-arm64'), { recursive: true });
    fs.mkdirSync(path.join(fx.runtimeRoot, 'python3'), { recursive: true });
    fs.writeFileSync(path.join(fx.runtimeRoot, 'uv-1.0.0-arm64'), 'a file');
    fs.symlinkSync(path.join(outside(), 'uv-0.13.0-arm64'), path.join(fx.runtimeRoot, 'uv-2.0.0-arm64'));
  });
  const nodeOnly = () => baseline(fx.privateRoot, fx.filesDir) + read(fx.nodeDir) + ` (allow file-read-metadata (literal "${fx.privateRoot}") (literal "${fx.runtimeRoot}"))`;
  const uvCases: [string, () => string][] = [
    ['a relative path', () => 'runtime/uv-0.13.0-arm64'],
    ['a uv folder that does not exist', () => path.join(fx.runtimeRoot, 'uv-9.9.9-arm64')],
    ['a name without a patch number', () => path.join(fx.runtimeRoot, 'uv-0.13-arm64')],
    ['a file named like a uv folder', () => path.join(fx.runtimeRoot, 'uv-1.0.0-arm64')],
    ['a link named like a uv folder that leads out of runtime/', () => path.join(fx.runtimeRoot, 'uv-2.0.0-arm64')],
    ['a uv folder outside the private root', () => path.join(outside(), 'uv-0.13.0-arm64')],
    ['the uv folder\'s libexec', () => path.join(fx.uvDir, 'libexec')],
    ['runtime/ itself', () => fx.runtimeRoot],
    ['runtime/python named as the uv folder', () => fx.pythonRoot],
  ];
  for (const [name, folder] of uvCases) {
    it(`uv: ${name}`, () => {
      expect(profileOf({ runtimeReadDir: fx.nodeDir, uvReadDir: folder(), denyXcodeStandIns: true })).toBe(nodeOnly());
    });
  }
  const pythonCases: [string, () => string][] = [
    ['a relative path', () => 'runtime/python'],
    ['another name under runtime/', () => path.join(fx.runtimeRoot, 'python3')],
    ['a CPython folder inside runtime/python', () => fx.patchDir],
    ['a python folder outside the private root', () => path.join(outside(), 'python')],
    ['the uv folder named as runtime/python', () => fx.uvDir],
  ];
  for (const [name, folder] of pythonCases) {
    it(`Python: ${name}`, () => {
      expect(profileOf({ runtimeReadDir: fx.nodeDir, pythonReadDir: folder(), denyXcodeStandIns: true })).toBe(nodeOnly());
    });
  }

  it('runtime/python that is a link out of runtime/ opens nothing, and uv\'s rule stays', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-py-linked-')));
    roots.push(root);
    const privateRoot = path.join(root, '.personal-productivity-tracker');
    const uv = path.join(privateRoot, 'runtime', 'uv-0.13.0-arm64');
    fs.mkdirSync(uv, { recursive: true });
    fs.mkdirSync(path.join(root, 'out', 'python'), { recursive: true });
    fs.symlinkSync(path.join(root, 'out', 'python'), path.join(privateRoot, 'runtime', 'python'));
    const invocation = modelProcessSandboxInvocation('/usr/bin/true', [], { privateRoot, ...PORTS, uvReadDir: uv, pythonReadDir: path.join(privateRoot, 'runtime', 'python'), denyXcodeStandIns: true });
    expect(invocation.opened).toEqual({ uv });
    expect(invocation.profile).toBe(baseline(privateRoot, path.join(privateRoot, 'files')) + read(uv)
      + ` (allow file-read-metadata (literal "${privateRoot}") (literal "${path.join(privateRoot, 'runtime')}")) ${DENY}`);
  });

  it('a runtime/ that is a link out of the private root opens nothing at all', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-py-linked-runtime-')));
    roots.push(root);
    const privateRoot = path.join(root, '.personal-productivity-tracker');
    fs.mkdirSync(privateRoot, { recursive: true });
    fs.mkdirSync(path.join(root, 'out', 'runtime', 'uv-0.13.0-arm64'), { recursive: true });
    fs.mkdirSync(path.join(root, 'out', 'runtime', 'python'), { recursive: true });
    fs.symlinkSync(path.join(root, 'out', 'runtime'), path.join(privateRoot, 'runtime'));
    const invocation = modelProcessSandboxInvocation('/usr/bin/true', [], {
      privateRoot, ...PORTS, uvReadDir: path.join(privateRoot, 'runtime', 'uv-0.13.0-arm64'), pythonReadDir: path.join(privateRoot, 'runtime', 'python'), denyXcodeStandIns: true,
    });
    expect(invocation.profile).toBe(baseline(privateRoot, path.join(privateRoot, 'files')));
    expect(invocation.opened).toEqual({});
    expect(invocation.runtimeRead).toBe(false);
  });
});

describe('which of BotBoy\'s runtimes is in use (decided by the first uv and python3 on PATH, by real path)', () => {
  it('BotBoy\'s uv: the wrapper\'s folder; its python root is runtime/python', () => {
    expect(privateUvUse({ pathValue: bothPath(), privateRoot: fx.privateRoot })).toEqual({ uvDir: fx.uvDir, pythonRoot: fx.pythonRoot });
  });
  it('a link to the wrapper elsewhere on PATH counts (the real path decides); the real binary in libexec/ does not', () => {
    const bin = path.join(fx.home, 'linkbin');
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync(path.join(fx.uvDir, 'uv'), path.join(bin, 'uv'));
    try {
      expect(privateUvUse({ pathValue: `${bin}${path.delimiter}/usr/bin`, privateRoot: fx.privateRoot })?.uvDir).toBe(fx.uvDir);
      expect(privateUvUse({ pathValue: `${path.join(fx.uvDir, 'libexec')}${path.delimiter}/usr/bin`, privateRoot: fx.privateRoot })).toBeNull();
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
  it('another uv first on PATH: not in use', () => {
    const bin = path.join(fx.home, 'otheruv');
    fs.mkdirSync(bin, { recursive: true });
    script(path.join(bin, 'uv'), 'echo uv 0.10.6');
    try {
      expect(privateUvUse({ pathValue: `${bin}${path.delimiter}${fx.uvDir}`, privateRoot: fx.privateRoot })).toBeNull();
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
  it('BotBoy\'s CPython: the PATH folder as written (the minor link\'s bin) and the real runtime/python', () => {
    expect(privatePythonUse({ pathValue: pythonOnlyPath(), privateRoot: fx.privateRoot })).toEqual({ pythonRoot: fx.pythonRoot, pythonBin: fx.pythonBin });
    expect(privatePythonUse({ pathValue: path.join(fx.patchDir, 'bin'), privateRoot: fx.privateRoot })?.pythonBin).toBe(path.join(fx.patchDir, 'bin'));
  });
  it('this Mac\'s own python3 first on PATH, or a python3 at another depth in runtime/python: not in use', () => {
    expect(privatePythonUse({ pathValue: `${fx.ownPythonBin}${path.delimiter}${fx.pythonBin}`, privateRoot: fx.privateRoot })).toBeNull();
    const deep = path.join(fx.patchDir, 'lib', 'bin');
    fs.mkdirSync(deep, { recursive: true });
    script(path.join(deep, 'python3'), 'echo deep');
    try {
      expect(privatePythonUse({ pathValue: deep, privateRoot: fx.privateRoot })).toBeNull();
    } finally {
      fs.rmSync(path.join(fx.patchDir, 'lib'), { recursive: true, force: true });
    }
  });
  it('pythonRuntimeUse: null when neither is in use; otherwise both answers and ~/.botboy-python beside the private root', () => {
    expect(useOn(`${fx.ownPythonBin}${path.delimiter}/usr/bin${path.delimiter}/bin`)).toBeNull();
    expect(useOn(bothPath())).toEqual({
      uv: { uvDir: fx.uvDir, pythonRoot: fx.pythonRoot },
      python: { pythonRoot: fx.pythonRoot, pythonBin: fx.pythonBin },
      userBase: fx.userBase,
      userBin: fx.userBin,
    });
    expect(useOn(uvOnlyPath())).toMatchObject({ uv: { uvDir: fx.uvDir }, python: null });
  });
  it('the sandbox options: uv\'s folder and runtime/python for uv; runtime/python alone for Python; nothing for none', () => {
    expect(pythonSandboxOptions(null, true)).toEqual({});
    expect(pythonSandboxOptions(useOn(uvOnlyPath()), true)).toEqual({ uvReadDir: fx.uvDir, pythonReadDir: fx.pythonRoot, denyXcodeStandIns: true });
    expect(pythonSandboxOptions(useOn(pythonOnlyPath()), false)).toEqual({ uvReadDir: null, pythonReadDir: fx.pythonRoot, denyXcodeStandIns: false });
  });
});

describe('the child environment (modelChildEnvironment, pythonUserEnvironment)', () => {
  const creds = { BOTBOY_INFERENCE_API_KEY: 'secret', AWS_BEARER_TOKEN_BEDROCK: 'secret' };
  const mode = (dir: string) => fs.statSync(dir).mode & 0o777;

  it('nothing of BotBoy\'s in use: byte-identical to before (credentials gone, PATH as it was, runtime entries removed)', () => {
    const base = { PATH: `${fx.ownPythonBin}${path.delimiter}/usr/bin`, HOME: fx.home, ...creds };
    expect(modelChildEnvironment({ BOTBOY_FILES: fx.filesDir }, base, null, null)).toEqual({ PATH: base.PATH, HOME: fx.home, BOTBOY_FILES: fx.filesDir });
    const withRuntime = { ...base, PATH: [fx.pythonBin, fx.uvDir, path.join(fx.nodeDir, 'bin'), '/usr/bin'].join(path.delimiter) };
    expect(modelChildEnvironment({}, withRuntime, null, null).PATH).toBe('/usr/bin');
    expect(fs.existsSync(fx.userBase)).toBe(false);
  });

  it('BotBoy\'s Python in use and opened: its bin stays, ~/.botboy-python/bin at the END, PYTHONUSERBASE and PIP_BREAK_SYSTEM_PACKAGES=1, never PIP_USER', () => {
    const use = useOn(bothPath())!;
    const access = pythonChildAccess(use, { uv: fx.uvDir, python: fx.pythonRoot })!;
    expect(access).toEqual({ uvDir: fx.uvDir, pythonRoot: fx.pythonRoot, pythonInUse: true, userBase: fx.userBase, userBin: fx.userBin });
    const env = modelChildEnvironment({}, { PATH: bothPath(), HOME: fx.home }, null, access);
    expect(env.PATH).toBe(`${bothPath()}${path.delimiter}${fx.userBin}`);
    expect(env.PYTHONUSERBASE).toBe(fx.userBase);
    expect(env.PIP_BREAK_SYSTEM_PACKAGES).toBe('1');
    expect(env).not.toHaveProperty('PIP_USER');
    // No UV_* in the environment: BotBoy's uv wrappers carry those (review finding 10), so another uv is never redirected.
    expect(Object.keys(env).filter((key) => key.startsWith('UV_'))).toEqual([]);
    // Created on first use, private to the owner.
    expect(mode(fx.userBase)).toBe(0o700);
    expect(mode(fx.userBin)).toBe(0o700);
  });

  it('BotBoy\'s uv with this Mac\'s own Python (clarification 1): uv\'s folder stays and the bin is added, but pip settings are untouched', () => {
    const use = useOn(uvOnlyPath())!;
    const access = pythonChildAccess(use, { uv: fx.uvDir, python: fx.pythonRoot })!;
    expect(access.pythonInUse).toBe(false);
    const env = modelChildEnvironment({}, { PATH: uvOnlyPath(), HOME: fx.home }, null, access);
    expect(env.PATH).toBe(`${uvOnlyPath()}${path.delimiter}${fx.userBin}`);
    expect(env).not.toHaveProperty('PYTHONUSERBASE');
    expect(env).not.toHaveProperty('PIP_BREAK_SYSTEM_PACKAGES');
    // The Mac's own python3 is still the first python3 on that PATH.
    expect(privatePythonUse({ pathValue: env.PATH, privateRoot: fx.privateRoot })).toBeNull();
  });

  it('a profile that opened no Python folder (fail closed, review finding 4): no access, and the runtime entries leave PATH', () => {
    const use = useOn(bothPath())!;
    expect(pythonChildAccess(use, {})).toBeNull();
    expect(pythonChildAccess(use, { node: fx.nodeDir })).toBeNull();
    const env = modelChildEnvironment({}, { PATH: bothPath(), HOME: fx.home }, null, null);
    expect(env.PATH).toBe(['/usr/bin', '/bin'].join(path.delimiter));
    expect(env).not.toHaveProperty('PYTHONUSERBASE');
  });

  it('only the opened folders keep their entries: uv opened but not runtime/python keeps uv and drops the Python bin', () => {
    const use = useOn(bothPath())!;
    const access = pythonChildAccess(use, { uv: fx.uvDir })!;
    expect(access).toMatchObject({ uvDir: fx.uvDir, pythonRoot: null, pythonInUse: false });
    const env = modelChildEnvironment({}, { PATH: bothPath(), HOME: fx.home }, null, access);
    expect(env.PATH).toBe([fx.uvDir, '/usr/bin', '/bin', fx.userBin].join(path.delimiter));
    expect(env).not.toHaveProperty('PIP_BREAK_SYSTEM_PACKAGES');
  });

  it('the Python entries survive with the system Node (use = null), and Node\'s entries survive with Python none', () => {
    const access = pythonChildAccess(useOn(pythonOnlyPath()), { python: fx.pythonRoot })!;
    const env = modelChildEnvironment({}, { PATH: pythonOnlyPath(), HOME: fx.home }, null, access);
    expect(env.PATH!.split(path.delimiter)[0]).toBe(fx.pythonBin);
    const node = nodeUse();
    const nodeEnv = modelChildEnvironment({}, { PATH: `${node.runtimeBin}${path.delimiter}${fx.pythonBin}${path.delimiter}/usr/bin`, HOME: fx.home }, node, null);
    expect(nodeEnv.PATH).toBe([node.runtimeBin, '/usr/bin', node.globalBin].join(path.delimiter));
  });

  it('a value the owner declared for a server is kept; the bin is added once', () => {
    const access = pythonChildAccess(useOn(pythonOnlyPath()), { python: fx.pythonRoot })!;
    const env = pythonUserEnvironment({ PATH: `/usr/bin${path.delimiter}${fx.userBin}`, PYTHONUSERBASE: '/declared', PIP_BREAK_SYSTEM_PACKAGES: '0' }, access, { PYTHONUSERBASE: '/declared', PIP_BREAK_SYSTEM_PACKAGES: '0' });
    expect(env).toEqual({ PATH: `/usr/bin${path.delimiter}${fx.userBin}`, PYTHONUSERBASE: '/declared', PIP_BREAK_SYSTEM_PACKAGES: '0' });
  });

  it('pathWithoutPrivateRuntime keeps an entry only inside a kept folder, compared on real paths', () => {
    const value = [fx.pythonBin, fx.uvDir, path.join(fx.nodeDir, 'bin'), '', '/usr/bin'].join(path.delimiter);
    expect(pathWithoutPrivateRuntime(value, fx.runtimeRoot, [fx.pythonRoot])).toBe([fx.pythonBin, '', '/usr/bin'].join(path.delimiter));
    expect(pathWithoutPrivateRuntime(value, fx.runtimeRoot, [fx.uvDir, undefined, ''])).toBe([fx.uvDir, '', '/usr/bin'].join(path.delimiter));
    expect(pathWithoutPrivateRuntime(value, fx.runtimeRoot)).toBe(['', '/usr/bin'].join(path.delimiter));
  });
});

describe('modelShellLaunch: one answer for the profile, the login line and the environment', () => {
  const launch = (command: string, pythonUse: PythonRuntimeUse | null, extra: Partial<Parameters<typeof modelShellLaunch>[1]> = {}) =>
    modelShellLaunch(command, { privateRoot: fx.privateRoot, filesDir: fx.filesDir, ...PORTS, use: null, pythonUse, base: { HOME: fx.home, PATH: bothPath() }, ...extra });

  it('nothing in use: profile, command line and environment are what they were', () => {
    const result = modelShellLaunch('true', { privateRoot: fx.privateRoot, filesDir: fx.filesDir, ...PORTS, use: null, pythonUse: null, base: { HOME: fx.home, PATH: '/usr/bin' } });
    expect(result.args).toEqual(['-p', baseline(fx.privateRoot, fx.filesDir), '/bin/zsh', '-lc', 'true']);
    expect(result.env).toEqual({ HOME: fx.home, PATH: '/usr/bin', BOTBOY_FILES: fx.filesDir });
  });

  it('all three in use: the line puts Python\'s bin, uv\'s folder and Node\'s bin first, npm\'s global bin and ~/.botboy-python/bin last', () => {
    const node = nodeUse();
    const result = launch('python3 -V', useOn(bothPath()), { use: node, base: { HOME: fx.home, PATH: `${bothPath()}${path.delimiter}${node.runtimeBin}` } });
    expect(result.args[4]).toBe(`export PATH='${fx.pythonBin}':'${fx.uvDir}':'${node.runtimeBin}'\${PATH:+:"$PATH"}:'${node.globalBin}':'${fx.userBin}'; python3 -V`);
    expect(result.args[4]).toBe(loginPathLine([fx.pythonBin, fx.uvDir, node.runtimeBin], [node.globalBin, fx.userBin]) + 'python3 -V');
    expect(result.args[1]).toBe(baseline(fx.privateRoot, fx.filesDir) + read(fx.nodeDir) + read(fx.uvDir) + read(fx.pythonRoot) + ` (allow file-read-metadata (literal "${fx.privateRoot}") (literal "${fx.runtimeRoot}"))`);
    expect(result.env.PYTHONUSERBASE).toBe(fx.userBase);
    expect(result.env.PATH!.split(path.delimiter).slice(-2)).toEqual([node.globalBin, fx.userBin]);
  });

  it('BotBoy\'s uv with this Mac\'s own Python: only uv\'s folder leads, and pip settings are untouched', () => {
    const result = launch('uv --version', useOn(uvOnlyPath()), { base: { HOME: fx.home, PATH: uvOnlyPath() } });
    expect(result.args[4]).toBe(`export PATH='${fx.uvDir}'\${PATH:+:"$PATH"}:'${fx.userBin}'; uv --version`);
    expect(result.env).not.toHaveProperty('PYTHONUSERBASE');
    expect(result.env).not.toHaveProperty('PIP_BREAK_SYSTEM_PACKAGES');
  });

  it('a use whose folders the profile cannot open (another private root) adds no line, no rule and no setting', () => {
    const other = createFixture();
    roots.push(other.home);
    const foreign = pythonRuntimeUse({ pathValue: [other.pythonBin, other.uvDir].join(path.delimiter), privateRoot: other.privateRoot });
    expect(foreign).not.toBeNull();
    const result = launch('true', foreign, { base: { HOME: fx.home, PATH: '/usr/bin' } });
    expect(result.args).toEqual(['-p', baseline(fx.privateRoot, fx.filesDir), '/bin/zsh', '-lc', 'true']);
    expect(result.env).toEqual({ HOME: fx.home, PATH: '/usr/bin', BOTBOY_FILES: fx.filesDir });
  });

  describe('the D6 deny comes from the cached Command Line Tools answer (review finding 11)', () => {
    const stub = () => {
      const file = path.join(fx.home, 'xcode-select-stub');
      const log = path.join(fx.home, 'xcode-select.log');
      script(file, `echo ran >> '${log}'\nexit 1`);
      vi.stubEnv('BOTBOY_TEST_XCODE_SELECT_BIN', file);
      fs.rmSync(log, { force: true });
      return log;
    };
    it('tools present: no deny', () => {
      resetCommandLineToolsForTests(true);
      expect(launch('true', useOn(bothPath())).args[1]).not.toContain('deny process-exec');
    });
    it('tools absent, or not known yet: the deny (unknown is safe), and never a process on this path', async () => {
      const log = stub();
      resetCommandLineToolsForTests(false);
      expect(launch('true', useOn(bothPath())).args[1]).toContain(DENY);
      resetCommandLineToolsForTests(null);
      expect(launch('true', useOn(bothPath())).args[1]).toContain(DENY);
      // The unknown answer started ONE background refresh; nothing waited for it.
      await vi.waitFor(() => expect(fs.readFileSync(log, 'utf8')).toBe('ran\n'), { timeout: 10_000 });
      await refreshCommandLineTools(); // settle it here, so it cannot land in the next test
    });
    it('nothing of BotBoy\'s Python in use: no deny, whatever the answer', () => {
      resetCommandLineToolsForTests(false);
      expect(launch('true', null).args[1]).toBe(baseline(fx.privateRoot, fx.filesDir));
    });
    it('a stale answer is served at once and refreshed in the background; a later tools install lifts the deny', async () => {
      const log = stub();
      resetCommandLineToolsForTests(true, Date.now() - 61_000);
      expect(commandLineToolsKnown()).toBe(true);
      await vi.waitFor(() => expect(commandLineToolsKnown()).toBe(false), { timeout: 10_000 });
      expect(fs.readFileSync(log, 'utf8')).toBe('ran\n');
      script(path.join(fx.home, 'xcode-select-stub'), 'exit 0');
      expect(await refreshCommandLineTools()).toBe(true);
      expect(launch('true', useOn(bothPath())).args[1]).not.toContain('deny process-exec');
    });
  });
});

const run = async (invocation: { executable: string; args: string[]; env?: Record<string, string> }, env: Record<string, string>, cwd = fx.filesDir) => {
  try {
    const done = await execFileAsync(invocation.executable, invocation.args, { cwd, env, timeout: 90_000 });
    return { ok: true, out: `${done.stdout}${done.stderr}` };
  } catch (error: any) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}${error.message ?? ''}` };
  }
};
const profileFile = (text: string) => fs.writeFileSync(path.join(fx.home, '.zprofile'), text);
/**
 * A shell prefix that stops (exit 97) unless `python3` resolves inside `bin`: a test whose login line regressed then
 * fails instead of running whatever python3 the login files left first (on a bare Mac, Apple's stand-in).
 */
const onlyBotBoysPython = (bin: string) => `case "$(command -v python3)" in '${bin}'/*) ;; *) echo "python3 is not BotBoy's: $(command -v python3)"; exit 97 ;; esac; `;

describe.runIf(sandboxLive)('chat commands on BotBoy\'s Python (the real /bin/zsh -lc under sandbox-exec, stand-in runtime, temp HOME)', () => {
  const launch = (command: string, pathValue = bothPath()) =>
    modelShellLaunch(command, { privateRoot: fx.privateRoot, filesDir: fx.filesDir, ...PORTS, use: null, pythonUse: useOn(pathValue), base: { HOME: fx.home, USER: 'tester', PATH: pathValue } });
  const go = (command: string, pathValue = bothPath()) => {
    const invocation = launch(command, pathValue);
    return run(invocation, invocation.env);
  };

  it('finds and runs BotBoy\'s python3 and uv after an empty ~/.zprofile, though path_helper moved the system folders first', async () => {
    profileFile('');
    const result = await go(`command -v python3; command -v uv; ${onlyBotBoysPython(fx.pythonBin)}python3; uv; echo "$PATH"`);
    expect(result.ok, result.out).toBe(true);
    const out = result.out.trim().split('\n');
    expect(out.slice(0, 4)).toEqual([path.join(fx.pythonBin, 'python3'), path.join(fx.uvDir, 'uv'), 'botboy-cpython 3.13.16', 'uv 0.13.0']);
    expect(out[4].split(path.delimiter).slice(0, 2)).toEqual([fx.pythonBin, fx.uvDir]);
    expect(out[4].split(path.delimiter).at(-1)).toBe(fx.userBin);
  });

  it('still finds them when ~/.zprofile resets PATH outright, or puts another python3 in front', async () => {
    profileFile('PATH=/usr/bin:/bin\n');
    const reset = await go(`command -v python3; ${onlyBotBoysPython(fx.pythonBin)}python3`);
    expect(reset.ok, reset.out).toBe(true);
    expect(reset.out.trim().split('\n')).toEqual([path.join(fx.pythonBin, 'python3'), 'botboy-cpython 3.13.16']);
    profileFile(`export PATH="${fx.ownPythonBin}:$PATH"\n`);
    const other = await go('command -v python3');
    expect(other.out.trim()).toBe(path.join(fx.pythonBin, 'python3'));
  });

  it('control: without the line, a profile that resets PATH loses BotBoy\'s python3 (the hazard; nothing is run)', async () => {
    profileFile('PATH=/usr/bin:/bin\n');
    const invocation = modelCommandSandboxInvocation('command -v python3 || echo none', { privateRoot: fx.privateRoot, filesDir: fx.filesDir, ...PORTS, pythonReadDir: fx.pythonRoot });
    const result = await run(invocation, { HOME: fx.home, PATH: bothPath() });
    expect(result.out.trim()).not.toBe(path.join(fx.pythonBin, 'python3'));
  });

  it('BotBoy\'s uv with this Mac\'s own Python: uv is BotBoy\'s, python3 stays the Mac\'s own (a ~/.zprofile like brew shellenv)', async () => {
    profileFile(`export PATH="${fx.ownPythonBin}:$PATH"\n`);
    const result = await go('command -v uv; command -v python3', uvOnlyPath());
    expect(result.ok, result.out).toBe(true);
    expect(result.out.trim().split('\n')).toEqual([path.join(fx.uvDir, 'uv'), path.join(fx.ownPythonBin, 'python3')]);
  });

  it('keeps the rest of the sandbox (design M4): secrets, listing and every write in the runtime denied; runtime/python listable; files/ works', async () => {
    profileFile('');
    for (const secret of ['ai-model.json', 'tracker.db']) {
      const result = await go(`cat "${path.join(fx.privateRoot, secret)}"`);
      expect(result.ok, result.out).toBe(false);
      expect(result.out).toMatch(/operation not permitted/i);
      expect(result.out).not.toContain('secretkey');
    }
    for (const listing of [fx.privateRoot, fx.runtimeRoot]) {
      const result = await go(`ls "${listing}"`);
      expect(result.ok, `${listing}: ${result.out}`).toBe(false);
    }
    fs.symlinkSync(path.join(fx.privateRoot, 'ai-model.json'), path.join(fx.pythonRoot, 'leak.json'));
    try {
      const leak = await go(`cat "${path.join(fx.pythonRoot, 'leak.json')}"`);
      expect(leak.ok, leak.out).toBe(false);
      expect(leak.out).not.toContain('secretkey');
    } finally {
      fs.rmSync(path.join(fx.pythonRoot, 'leak.json'), { force: true });
    }
    for (const target of [path.join(fx.pythonRoot, 'new.txt'), path.join(fx.runtimeRoot, 'beside.txt'), path.join(fx.patchDir, 'bin', 'new.txt')]) {
      const result = await go(`echo x > "${target}"`);
      expect(result.ok, `${target}: ${result.out}`).toBe(false);
      expect(fs.existsSync(target)).toBe(false);
    }
    const append = await go(`echo x >> "${path.join(fx.uvDir, 'uv')}"`);
    expect(append.ok, append.out).toBe(false);
    const listed = await go(`ls "${fx.pythonRoot}"`);
    expect(listed.ok, listed.out).toBe(true);
    expect(listed.out).toContain('cpython-3.13.16-macos-aarch64-none');
    const ok = await go(`echo workspace > "${path.join(fx.filesDir, 'py.txt')}" && cat "${path.join(fx.filesDir, 'py.txt')}"`);
    expect(ok.ok, ok.out).toBe(true);
    expect(ok.out.trim()).toBe('workspace');
  });

  it('the D6 rule\'s shape works in Seatbelt: exec of a denied literal is refused and the program never runs (shown on a tripwire, never on Apple\'s stand-ins)', async () => {
    const tripwire = path.join(fx.filesDir, 'tripwire-python3');
    const marker = path.join(fx.filesDir, 'tripwire-ran');
    script(tripwire, `echo ran > '${marker}'`);
    resetCommandLineToolsForTests(false);
    const real = launch('true').args[1];
    expect(real).toContain(DENY);
    const asTripwire = real.replace('(literal "/usr/bin/python3")', `(literal "${tripwire}")`);
    expect(asTripwire).not.toBe(real);
    const denied = await run({ executable: '/usr/bin/sandbox-exec', args: ['-p', asTripwire, tripwire] }, { HOME: fx.home, PATH: '/usr/bin:/bin' });
    expect(denied.ok, denied.out).toBe(false);
    expect(denied.out).toMatch(/operation not permitted/i);
    expect(fs.existsSync(marker)).toBe(false);
    // Control: the same profile without the rule runs it.
    const allowed = await run({ executable: '/usr/bin/sandbox-exec', args: ['-p', asTripwire.replace(/ \(deny process-exec [^\n]*\)\)$/, ''), tripwire] }, { HOME: fx.home, PATH: '/usr/bin:/bin' });
    expect(allowed.ok, allowed.out).toBe(true);
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker, { force: true });
  });
});

/** Copies the real pinned runtime into this test's private root (an APFS clone where it can) and rewrites what names its old place. */
function installRealRuntime(target: Fixture): { uvDir: string; pythonBin: string; version: string } {
  const uvName = fs.readdirSync(realRuntime).find((name) => /^uv-\d+\.\d+\.\d+-(?:arm64|x64)$/.test(name));
  if (!uvName) throw new Error(`BOTBOY_TEST_PYTHON_FIXTURE has no uv folder: ${realRuntime}`);
  const runtime = path.join(target.home, 'real', '.personal-productivity-tracker', 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  for (const name of [uvName, 'python']) {
    const copied = spawnSync('/bin/cp', ['-cR', path.join(realRuntime, name), path.join(runtime, name)]);
    if (copied.status !== 0) expect(spawnSync('/bin/cp', ['-R', path.join(realRuntime, name), path.join(runtime, name)]).status).toBe(0);
  }
  const pythonRoot = path.join(runtime, 'python');
  let minor = '';
  for (const entry of fs.readdirSync(pythonRoot)) {
    const full = path.join(pythonRoot, entry);
    if (!fs.lstatSync(full).isSymbolicLink()) continue;
    const pointsAt = path.basename(fs.readlinkSync(full));
    fs.unlinkSync(full);
    fs.symlinkSync(path.join(pythonRoot, pointsAt), full); // absolute, as start.sh makes it
    minor = entry;
  }
  const wrote = spawnSync('/bin/bash', ['-c', 'source "$1/scripts/python-runtime.sh" && python_runtime_write_wrappers "$2" "$2"', '_', packageRoot, path.join(runtime, uvName)], {
    env: { HOME: path.join(target.home, 'real'), PATH: '/usr/bin:/bin', PROJ_DIR: packageRoot, PPT_LOG_FILE: path.join(target.home, 'py.log') },
    encoding: 'utf8',
  });
  expect(wrote.status, wrote.stderr).toBe(0);
  const version = /^python\.version=(.+)$/m.exec(fs.readFileSync(path.join(packageRoot, 'python-runtime.pin'), 'utf8'))![1];
  return { uvDir: path.join(runtime, uvName), pythonBin: path.join(pythonRoot, minor, 'bin'), version };
}

describe.runIf(liveRealPython)('the real pinned uv and CPython under sandbox-exec (BOTBOY_TEST_PYTHON_FIXTURE)', () => {
  let home: string;
  let privateRoot: string;
  let filesDir: string;
  let real: { uvDir: string; pythonBin: string; version: string };
  let pathValue: string;
  const go = (command: string, extraEnv: Record<string, string> = {}) => {
    const invocation = modelShellLaunch(command, {
      privateRoot, filesDir, ...PORTS, use: null, shell: '/bin/zsh',
      pythonUse: pythonRuntimeUse({ pathValue, privateRoot }), base: { HOME: home, USER: 'tester', PATH: pathValue }, extraEnv,
    });
    return run(invocation, invocation.env, filesDir);
  };
  beforeAll(() => {
    real = installRealRuntime(fx);
    home = path.join(fx.home, 'real');
    privateRoot = path.join(home, '.personal-productivity-tracker');
    filesDir = path.join(privateRoot, 'files');
    fs.mkdirSync(filesDir, { recursive: true });
    fs.writeFileSync(path.join(privateRoot, 'ai-model.json'), '{"apiKey":"secretkey"}');
    pathValue = [real.pythonBin, real.uvDir, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);
  }, 180_000);
  beforeEach(() => vi.stubEnv('HOME', home));

  it('python3 runs (the pinned version) and uv python find returns the pinned copy through the metadata rule', async () => {
    const python = await go(`${onlyBotBoysPython(real.pythonBin)}python3 -I -c 'import ssl, sqlite3, venv, ctypes, zlib, sys; print(sys.version.split()[0])'`);
    expect(python.ok, python.out).toBe(true);
    expect(python.out.trim()).toBe(real.version);
    const find = await go('uv python find');
    expect(find.ok, find.out).toBe(true);
    expect(find.out.trim()).toBe(path.join(real.pythonBin, `python${real.version.split('.').slice(0, 2).join('.')}`));
    const versions = await go('uv --version && uvx --version');
    expect(versions.ok, versions.out).toBe(true);
  });

  it('uv python find never runs a python3 it meets on PATH (the wrappers\' managed-only default)', async () => {
    const trip = path.join(filesDir, 'trip');
    fs.mkdirSync(trip, { recursive: true });
    script(path.join(trip, 'python3'), `echo ran >> '${path.join(filesDir, 'trip.log')}'; exit 1`);
    const find = await go(`PATH="${trip}:$PATH" uv python find`);
    expect(find.ok, find.out).toBe(true);
    expect(fs.existsSync(path.join(filesDir, 'trip.log'))).toBe(false);
  });

  it('a plain pip install goes past BotBoy\'s EXTERNALLY-MANAGED marker in chat (PIP_BREAK_SYSTEM_PACKAGES=1), and names the next action without it', async () => {
    const empty = path.join(filesDir, 'no-index');
    fs.mkdirSync(empty, { recursive: true });
    const quiet = { PIP_DISABLE_PIP_VERSION_CHECK: '1' };
    const chat = await go(`${onlyBotBoysPython(real.pythonBin)}python3 -m pip install --no-index --find-links "${empty}" botboy-absent-package`, quiet);
    expect(chat.ok).toBe(false);
    expect(chat.out).toMatch(/No matching distribution found for botboy-absent-package/);
    expect(chat.out).not.toMatch(/externally-managed-environment/);
    const outside = await go(`${onlyBotBoysPython(real.pythonBin)}python3 -m pip install --no-index --find-links "${empty}" botboy-absent-package`, { ...quiet, PIP_BREAK_SYSTEM_PACKAGES: '0' });
    expect(outside.ok).toBe(false);
    expect(outside.out).toMatch(/externally-managed-environment/);
    expect(outside.out).toContain('BotBoy keeps its own Python read-only.');
  });

  it('a venv in files/ works and its pip is untouched by the chat settings', async () => {
    const venv = path.join(filesDir, 'venv');
    const made = await go(`${onlyBotBoysPython(real.pythonBin)}python3 -m venv "${venv}" && "${venv}/bin/python" -c 'import sys; print(sys.prefix)' && "${venv}/bin/pip" --version`);
    expect(made.ok, made.out).toBe(true);
    expect(made.out.split('\n')[0].trim()).toBe(venv);
    expect(made.out).toMatch(new RegExp(`pip \\S+ from ${venv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('the runtime stays read-only and private state stays denied (design M4, real binaries)', async () => {
    const key = await go(`cat "${path.join(privateRoot, 'ai-model.json')}"`);
    expect(key.ok).toBe(false);
    expect(key.out).not.toContain('secretkey');
    const site = path.join(fs.realpathSync(real.pythonBin), '..', 'lib', `python${real.version.split('.').slice(0, 2).join('.')}`, 'site-packages', 'botboy-write.txt');
    const write = await go(`echo x > "${site}"`);
    expect(write.ok, write.out).toBe(false);
    expect(fs.existsSync(site)).toBe(false);
  });
});
