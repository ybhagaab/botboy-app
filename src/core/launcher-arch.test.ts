/**
 * start.sh on Apple Silicon: the early native re-exec, the spawn-prefix arrays,
 * the `file -b` architecture probes, and the doctor machine rows. Tool paths
 * are BOTBOY_TEST_* variables (start.sh prepends several directories to PATH,
 * so PATH shims are unreliable); the hooks exit before any real start.
 * A translated parent is simulated with `arch -x86_64` where Rosetta exists.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Each case spawns the launcher a few times; a loaded Mac needs more than 5 s.
vi.setConfig({ testTimeout: 60_000 });

const launcherPath = fileURLToPath(new URL('../../start.sh', import.meta.url));
const nativePrebuiltPath = fileURLToPath(new URL('../../scripts/native-prebuilt.mjs', import.meta.url));
const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const sysctl = (name: string) => spawnSync('/usr/sbin/sysctl', ['-n', name], { encoding: 'utf8' }).stdout.trim();
const appleSilicon = process.platform === 'darwin' && sysctl('hw.optional.arm64') === '1';
const rosetta = appleSilicon && spawnSync('/usr/bin/arch', ['-x86_64', '/usr/bin/true']).status === 0;
const FAT_CHROME = 'Mach-O universal binary with 2 architectures: [x86_64:Mach-O 64-bit executable x86_64] [arm64:Mach-O 64-bit executable arm64]';
const INTEL_ONLY = 'Mach-O 64-bit executable x86_64';

function box() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-arch-'));
  roots.push(root);
  const dir = path.join(root, 'app');
  const stubs = path.join(root, 'stubs');
  const marks = path.join(root, 'marks');
  const home = path.join(root, 'home');
  for (const d of [dir, stubs, marks, home]) fs.mkdirSync(d);
  fs.copyFileSync(launcherPath, path.join(dir, 'start.sh'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
  const stub = (name: string, body: string) => {
    const file = path.join(stubs, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  /** A stub that records each call in marks/<name> and then answers. */
  const recording = (name: string, answer = '') => stub(name, `echo "$@" >> '${path.join(marks, name)}'\n${answer}`);
  const marked = (name: string) => fs.existsSync(path.join(marks, name));
  // The re-exec is off by default (like every launcher harness); a test that
  // wants it sets BOTBOY_NO_ARCH_REEXEC to an empty string.
  const env = (extra: Record<string, string> = {}) => {
    const base: Record<string, string | undefined> = { ...process.env };
    for (const key of ['BOTBOY_NATIVE_REEXEC', 'BOTBOY_REEXEC_FROM', 'BOTBOY_NO_ARCH_REEXEC']) delete base[key];
    return {
      ...base,
      HOME: home,
      PPT_LOG_FILE: path.join(root, 'launcher.log'),
      BOTBOY_NO_ARCH_REEXEC: '1',
      ...extra,
    } as Record<string, string>;
  };
  const run = (hook: string, extra: Record<string, string> = {}, args: string[] = []) =>
    spawnSync('/bin/bash', [path.join(dir, 'start.sh'), ...args], {
      cwd: dir,
      env: env({ [hook]: '1', ...extra }),
      encoding: 'utf8',
      timeout: 20_000,
    });
  return { root, dir, stubs, marks, home, stub, recording, marked, env, run };
}

const planEnv = (facts: { hw: string; translated?: string; probe?: string; chrome?: string; node?: string; guard?: string; off?: string }) => ({
  BOTBOY_TEST_HW_ARM64: facts.hw,
  BOTBOY_TEST_SHELL_TRANSLATED: facts.translated ?? '0',
  BOTBOY_TEST_ARCH_PROBE_OK: facts.probe ?? '1',
  BOTBOY_TEST_CHROME_ARCHS: facts.chrome ?? '',
  BOTBOY_TEST_NODE_ARCHS: facts.node ?? '',
  ...(facts.guard ? { BOTBOY_NATIVE_REEXEC: facts.guard } : {}),
  BOTBOY_NO_ARCH_REEXEC: facts.off ?? '',
});

describe('start.sh › arch_plan (injected facts)', () => {
  const plan = (facts: Parameters<typeof planEnv>[0]) => {
    const b = box();
    const result = b.run('BOTBOY_TEST_ARCH_PLAN', planEnv(facts));
    expect(result.status).toBe(0);
    return {
      reexec: /^reexec=(\d)$/m.exec(result.stdout)![1],
      chrome: /^chrome_prefix=(.*)$/m.exec(result.stdout)![1],
      server: /^server_prefix=(.*)$/m.exec(result.stdout)![1],
      node: /^node_prefix=(.*)$/m.exec(result.stdout)![1],
      warnChrome: /warn_chrome_intel=(\d)/.exec(result.stdout)![1],
      warnNode: /warn_node_intel=(\d)/.exec(result.stdout)![1],
    };
  };
  const NATIVE = '/usr/bin/arch -arm64';

  it('plans nothing on an Intel Mac, whatever else is injected', () => {
    expect(plan({ hw: '0', translated: '1', chrome: 'x86_64', node: 'x86_64' })).toEqual({
      reexec: '0', chrome: '', server: '', node: '', warnChrome: '0', warnNode: '0',
    });
  });
  it('plans nothing and warns nothing for a native shell with a universal Chrome and arm64 Node', () => {
    expect(plan({ hw: '1', chrome: 'x86_64 arm64', node: 'arm64' })).toEqual({
      reexec: '0', chrome: '', server: '', node: '', warnChrome: '0', warnNode: '0',
    });
  });
  it('re-executes a translated shell and wraps only the programs that hold an arm64 slice', () => {
    expect(plan({ hw: '1', translated: '1', chrome: 'x86_64 arm64', node: 'arm64' })).toEqual({
      reexec: '1', chrome: NATIVE, server: NATIVE, node: NATIVE, warnChrome: '0', warnNode: '0',
    });
    expect(plan({ hw: '1', translated: '1', chrome: 'x86_64 arm64e', node: 'x86_64 arm64e' }).chrome).toBe(NATIVE);
  });
  it('warns once for an Intel-only Chrome and never wraps it', () => {
    expect(plan({ hw: '1', chrome: 'x86_64', node: 'arm64' })).toMatchObject({ chrome: '', warnChrome: '1', warnNode: '0' });
    expect(plan({ hw: '1', translated: '1', chrome: 'x86_64', node: 'arm64' })).toMatchObject({ chrome: '', server: NATIVE, warnChrome: '1' });
  });
  it('warns once for an Intel-only Node and never wraps it', () => {
    expect(plan({ hw: '1', translated: '1', chrome: 'x86_64 arm64', node: 'x86_64' })).toMatchObject({
      chrome: NATIVE, server: '', node: '', warnChrome: '0', warnNode: '1',
    });
  });
  it('neither wraps nor warns when the architectures are unknown', () => {
    expect(plan({ hw: '1', translated: '1', chrome: '', node: '' })).toEqual({
      reexec: '1', chrome: '', server: '', node: '', warnChrome: '0', warnNode: '0',
    });
  });
  it('forces every prefix empty, and no re-exec, when arch -arm64 does not work', () => {
    expect(plan({ hw: '1', translated: '1', probe: '0', chrome: 'x86_64 arm64', node: 'arm64' })).toEqual({
      reexec: '0', chrome: '', server: '', node: '', warnChrome: '0', warnNode: '0',
    });
  });
  it('re-executes at most once and honors the escape hatch', () => {
    expect(plan({ hw: '1', translated: '1', guard: '1', chrome: 'arm64', node: 'arm64' }).reexec).toBe('0');
    expect(plan({ hw: '1', translated: '1', off: '1', chrome: 'arm64', node: 'arm64' }).reexec).toBe('0');
    // With the re-exec off, the prefixes are the backup that keeps children native.
    expect(plan({ hw: '1', translated: '1', off: '1', chrome: 'arm64', node: 'arm64' }).server).toBe(NATIVE);
  });
});

describe('start.sh › Intel Macs run no arch or file command', () => {
  it('records zero arch and file invocations through the whole architecture layer', () => {
    const b = box();
    const sysctlStub = b.stub('sysctl', `case "$2" in hw.optional.arm64) echo 0;; hw.memsize) echo 17179869184;; *) echo ;; esac`);
    const arch = b.recording('arch');
    const file = b.recording('file', `echo '${INTEL_ONLY}'`);
    const env = {
      BOTBOY_TEST_SYSCTL_BIN: sysctlStub,
      BOTBOY_TEST_ARCH_BIN: arch,
      BOTBOY_TEST_FILE_BIN: file,
      BOTBOY_TEST_LSOF_BIN: b.recording('lsof'),
      BOTBOY_TEST_PS_BIN: b.recording('ps'),
      BOTBOY_TEST_APP_BUNDLE: path.join(b.root, 'no-such-bundle'),
    };
    // arch_prepare runs before these hooks; the doctor rows and the app plan read the facts too.
    for (const hook of ['BOTBOY_TEST_HEAL_DEPS', 'BOTBOY_TEST_DOCTOR_MACHINE', 'BOTBOY_TEST_APP_LAUNCHER_PLAN']) {
      const result = b.run(hook, env);
      expect(result.status).toBe(0);
    }
    expect(b.marked('arch')).toBe(false);
    expect(b.marked('file')).toBe(false);
    expect(b.marked('lsof')).toBe(false);
    expect(b.marked('ps')).toBe(false);
  });
  it('says so in the doctor rows without probing anything', () => {
    const b = box();
    const sysctlStub = b.stub('sysctl', `case "$2" in hw.optional.arm64) echo 0;; *) echo ;; esac`);
    const result = b.run('BOTBOY_TEST_DOCTOR_MACHINE', { BOTBOY_TEST_SYSCTL_BIN: sysctlStub });
    expect(result.stdout).toContain('hardware: Intel');
    expect(result.stdout).toContain('this shell: native');
    expect(result.stdout).toContain('chrome arch: not checked (Intel Mac)');
  });
});

describe('start.sh › architecture probes on Apple Silicon (injected hardware)', () => {
  const appleEnv = (b: ReturnType<typeof box>, chrome: string, node: string, extra: Record<string, string> = {}) => {
    const chromeFile = path.join(b.dir, 'chrome-bin');
    const nodeFile = path.join(b.dir, 'node-bin');
    fs.writeFileSync(chromeFile, '');
    fs.writeFileSync(nodeFile, '');
    fs.chmodSync(nodeFile, 0o755);
    const file = b.stub('file', `case "$2" in *chrome-bin) echo '${chrome}';; *node-bin) echo '${node}';; *) echo 'ASCII text';; esac`);
    return {
      BOTBOY_TEST_HW_ARM64: '1',
      BOTBOY_TEST_ARCH_PROBE_OK: '1',
      BOTBOY_TEST_FILE_BIN: file,
      BOTBOY_TEST_CHROME_BIN: chromeFile,
      BOTBOY_TEST_NODE_BIN: nodeFile,
      BOTBOY_TEST_LSOF_BIN: b.stub('lsof', ''),
      ...extra,
    };
  };

  it('prints one Intel-Chrome warning at start and a doctor row that says what to do', () => {
    const b = box();
    const env = appleEnv(b, INTEL_ONLY, 'Mach-O 64-bit executable arm64');
    const start = b.run('BOTBOY_TEST_HEAL_DEPS', env);
    expect(start.stdout.match(/Chrome is the Intel build and runs 2-5x slower/g)).toHaveLength(1);
    expect(start.stdout).toContain('download Chrome for Mac with Apple chip from google.com/chrome');
    expect(start.stdout).not.toContain('Node is the Intel build');
    const doctor = b.run('BOTBOY_TEST_DOCTOR_MACHINE', env, ['--doctor']);
    expect(doctor.stdout).toContain('chrome arch: x86_64 only (Rosetta, 2-5x slower)');
    expect(doctor.stdout).toContain('node arch: arm64 (runs native)');
    // The doctor reports instead of printing the start warnings.
    expect(doctor.stdout).not.toContain('Chrome is the Intel build');
  });
  it('reads a universal binary from its listed slices, not from the word "universal"', () => {
    const b = box();
    const doctor = b.run('BOTBOY_TEST_DOCTOR_MACHINE', appleEnv(b, FAT_CHROME, 'Mach-O 64-bit executable arm64e'));
    expect(doctor.stdout).toContain('chrome arch: x86_64+arm64 (runs native)');
    expect(doctor.stdout).toContain('node arch: arm64e (runs native)');
  });
  it('treats a script or an unreadable answer as unknown: no warning', () => {
    const b = box();
    const env = appleEnv(b, 'Bourne-Again shell script text executable', '');
    const start = b.run('BOTBOY_TEST_HEAL_DEPS', env);
    expect(start.stdout).not.toContain('Intel build');
    const doctor = b.run('BOTBOY_TEST_DOCTOR_MACHINE', env);
    expect(doctor.stdout).toContain('chrome arch: unknown');
    expect(doctor.stdout).toContain('node arch: unknown');
  });
  it('prefers an arm64 Node over an Intel-only one found first', () => {
    const b = box();
    const brewNode = path.join(b.home, 'homebrew', 'bin', 'node');
    fs.mkdirSync(path.dirname(brewNode), { recursive: true });
    fs.writeFileSync(brewNode, '');
    fs.chmodSync(brewNode, 0o755);
    const chromeFile = path.join(b.dir, 'chrome-bin');
    const nodeFile = path.join(b.dir, 'node-bin');
    fs.writeFileSync(chromeFile, '');
    fs.writeFileSync(nodeFile, '');
    fs.chmodSync(nodeFile, 0o755);
    const file = b.stub('file', `case "$2" in *homebrew*) echo 'Mach-O 64-bit executable arm64';; *chrome-bin) echo '${FAT_CHROME}';; *) echo '${INTEL_ONLY}';; esac`);
    const env = {
      BOTBOY_TEST_HW_ARM64: '1', BOTBOY_TEST_ARCH_PROBE_OK: '1', BOTBOY_TEST_FILE_BIN: file,
      BOTBOY_TEST_CHROME_BIN: chromeFile, BOTBOY_TEST_NODE_BIN: nodeFile, BOTBOY_TEST_LSOF_BIN: b.stub('lsof', ''),
    };
    const start = b.run('BOTBOY_TEST_HEAL_DEPS', env);
    expect(start.stdout).not.toContain('Node is the Intel build');
    expect(b.run('BOTBOY_TEST_DOCTOR_MACHINE', env).stdout).toContain('node arch: arm64 (runs native)');
  });
  it('warns once for an Intel-only Node that has no native replacement', () => {
    const b = box();
    const env = appleEnv(b, FAT_CHROME, INTEL_ONLY);
    const start = b.run('BOTBOY_TEST_HEAL_DEPS', env);
    expect(start.stdout.match(/Node is the Intel build and runs under Rosetta/g)).toHaveLength(1);
    expect(b.run('BOTBOY_TEST_DOCTOR_MACHINE', env).stdout).toContain('node arch: x86_64 only (Rosetta)');
  });
});

describe('start.sh › spawn lines', () => {
  const launcher = fs.readFileSync(launcherPath, 'utf8');
  const lines = launcher.split('\n');
  const code = lines.filter((line) => !line.trim().startsWith('#'));

  it('carries the prefix array expansion on every Chrome launch and every server spawn', () => {
    const chromeLaunches = code.filter((line) => /"\$CHROME" \\$/.test(line));
    expect(chromeLaunches).toHaveLength(2);
    for (const line of chromeLaunches) expect(line).toContain('${CHROME_PREFIX[@]+"${CHROME_PREFIX[@]}"} "$CHROME"');
    const servers = code.filter((line) => /"\$NODE" dist\/index\.js/.test(line));
    expect(servers).toHaveLength(2);
    for (const line of servers) {
      expect(line).toContain('${SERVER_PREFIX[@]+"${SERVER_PREFIX[@]}"} "$NODE" dist/index.js');
      expect(line).toContain('PPT_DB_OPEN_MARKER="$DB_OPEN_MARKER"');
    }
    // A prefix is an array, never a function in front of nohup or &.
    expect(code.some((line) => /\bnative_exec\b.*\bnohup\b|\bnohup\b.*\bnative_exec\b/.test(line))).toBe(false);
    expect(code.some((line) => /native_exec .*dist\/index\.js/.test(line))).toBe(false);
  });
  it('runs synchronous node and npm calls through native_exec', () => {
    expect(launcher).toContain('native_exec "$NODE" -e');
    expect(launcher).toContain('native_exec "$NPM_BIN" install');
    expect(launcher).toContain('native_exec npm run build');
    expect(launcher).toContain('native_exec "$NODE" scripts/bootstrap-deps.mjs');
    expect(launcher).toContain('native_exec "$NODE" "$builder"');
  });
  it('probes with file -b and the hardware flag, never lipo, swiftc or otool', () => {
    expect(launcher).toContain('"$FILE_BIN" -b');
    expect(launcher).toContain('hw.optional.arm64');
    expect(launcher).not.toMatch(/\bhw\.machine\b/);
    expect(launcher).toContain('shopt -s execfail');
  });

  /** Runs the real spawn line, with a stub program, and returns what ps shows. */
  function spawnShape(prefixSetup: string, template: (line: string) => string) {
    const b = box();
    const real = lines.find((line) => /nohup \$\{SERVER_PREFIX/.test(line))!;
    const program = b.stub('server', 'sleep 3');
    const arch = b.stub('arch', 'shift\nexec "$@"');
    const script = [
      `NODE='${program}'`,
      `LOG_FILE='${path.join(b.root, 'server.log')}'`,
      `DB_OPEN_MARKER='${path.join(b.root, 'marker')}'`,
      prefixSetup.replace(/ARCH/g, arch),
      template(real),
      'SERVER_PID=$!',
      // Wait for the exec chain (nohup, arch) to settle on the program.
      'for _ in $(seq 1 50); do out="$(ps -ww -o command= -p "$SERVER_PID")"; case "$out" in *stubs/arch*) sleep 0.1;; *) break;; esac; done',
      'echo "$out"',
      'kill "$SERVER_PID" 2>/dev/null',
    ].join('\n');
    const result = spawnSync('/bin/bash', ['-c', script], { cwd: b.dir, encoding: 'utf8', timeout: 10_000 });
    return { stdout: result.stdout.trim(), program };
  }

  it('keeps $! as the server process, with and without the native prefix', () => {
    const empty = spawnShape('SERVER_PREFIX=()', (line) => line);
    const wrapped = spawnShape('SERVER_PREFIX=("ARCH" -arm64)', (line) => line);
    // `arch` execs the program, so the process $! names is the program itself.
    expect(wrapped.stdout).toBe(`/bin/sh ${wrapped.program} dist/index.js`);
    expect(empty.stdout).toBe(`/bin/sh ${empty.program} dist/index.js`);
  });
  it('expands to the exact command line it had before when the plan is empty', () => {
    const unset = spawnShape('SERVER_PREFIX=()', (line) => line);
    const today = spawnShape('', (line) => line.replace('${SERVER_PREFIX[@]+"${SERVER_PREFIX[@]}"} ', ''));
    expect(unset.stdout.replace(unset.program, 'PROGRAM')).toBe(today.stdout.replace(today.program, 'PROGRAM'));
    // Also with the array never assigned and `set -u`, as bash 3.2 requires.
    const strict = spawnShape('set -u', (line) => line);
    expect(strict.stdout).toContain('dist/index.js');
  });
});

describe('start.sh › early native re-exec', () => {
  async function probe(b: ReturnType<typeof box>, args: string[], extra: Record<string, string> = {}, translated = true) {
    const command = translated ? '/usr/bin/arch' : path.join(b.dir, 'start.sh');
    const argv = translated ? ['-x86_64', path.join(b.dir, 'start.sh'), ...args] : args;
    const env = b.env({ BOTBOY_TEST_REEXEC_PROBE: '1', BOTBOY_NO_ARCH_REEXEC: '', ...extra });
    const child = spawn(command, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    const deadline = Date.now() + 8000;
    while (!/pid=\d+ /.test(out) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    // The probe installs its INT trap right after printing; give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const seen = out;
    child.kill('SIGINT');
    const result = await exited;
    return { pid: child.pid, seen, out, ...result };
  }

  it.skipIf(!rosetta)('keeps the PID and the arguments, ends native, and still delivers SIGINT (--foreground)', async () => {
    const b = box();
    const result = await probe(b, ['--foreground']);
    const match = /pid=(\d+) args=(.*) guard=(\S*) from=(\S*) translated=(\d)/.exec(result.seen)!;
    expect(Number(match[1])).toBe(result.pid);
    expect(match[2]).toBe('--foreground');
    expect(match[3]).toBe('1');
    expect(match[4]).toBe('translated');
    expect(match[5]).toBe('0');
    expect(result.seen).toContain('continuing natively on Apple Silicon');
    expect(result.out).toContain('got-INT');
    expect(result.code).toBe(0);
    // The app launcher discards stdout, so the log file records the switch too.
    expect(fs.readFileSync(path.join(b.root, 'launcher.log'), 'utf8')).toMatch(/This shell was running under Rosetta; continuing natively on Apple Silicon \(start\.sh --foreground\)/);
  });
  it.skipIf(!rosetta)('does the same for --open-window', async () => {
    const result = await probe(box(), ['--open-window']);
    const match = /pid=(\d+) args=(.*) guard=(\S*) from=(\S*) translated=(\d)/.exec(result.seen)!;
    expect(Number(match[1])).toBe(result.pid);
    expect(match[2]).toBe('--open-window');
    expect(match[5]).toBe('0');
    expect(result.out).toContain('got-INT');
  });
  it.skipIf(!rosetta)('does not re-execute a second time when the guard is set', async () => {
    const result = await probe(box(), ['--foreground'], { BOTBOY_NATIVE_REEXEC: '1' });
    expect(result.seen).toContain('guard=1 from= translated=1');
    expect(result.seen).not.toContain('continuing natively');
  });
  it.skipIf(!rosetta)('stays translated, and says so, when BOTBOY_NO_ARCH_REEXEC=1', async () => {
    const b = box();
    const env = b.env({ BOTBOY_TEST_DOCTOR_MACHINE: '1', BOTBOY_TEST_LSOF_BIN: b.stub('lsof', '') });
    const result = spawnSync('/usr/bin/arch', ['-x86_64', path.join(b.dir, 'start.sh')], { env, encoding: 'utf8', timeout: 20_000 });
    expect(result.stdout).toContain('this shell: translated (Rosetta)');
    expect(result.stdout).toContain('BOTBOY_NO_ARCH_REEXEC=1 is set');
    expect(result.stdout).not.toContain('continuing natively');
  });
  it.skipIf(!rosetta)('reports a re-launch in the doctor rows', () => {
    const b = box();
    const env = b.env({ BOTBOY_TEST_DOCTOR_MACHINE: '1', BOTBOY_NO_ARCH_REEXEC: '', BOTBOY_TEST_LSOF_BIN: b.stub('lsof', '') });
    const result = spawnSync('/usr/bin/arch', ['-x86_64', path.join(b.dir, 'start.sh')], { env, encoding: 'utf8', timeout: 20_000 });
    expect(result.stdout).toContain('this shell: native (re-launched from a Rosetta shell)');
  });
  it('a failing arch probe skips the re-exec instead of ending the launcher', async () => {
    const b = box();
    const arch = b.recording('arch', 'exit 1');
    const result = await probe(b, ['--foreground'], {
      BOTBOY_TEST_HW_ARM64: '1', BOTBOY_TEST_SHELL_TRANSLATED: '1', BOTBOY_TEST_ARCH_BIN: arch,
    }, false);
    expect(result.seen).toMatch(/pid=\d+ args=--foreground guard= from= /);
    expect(result.out).toContain('got-INT');
    // Only the probe ran; the launcher itself was never replaced.
    expect(fs.readFileSync(path.join(b.marks, 'arch'), 'utf8').trim().split('\n')).toEqual(['-arm64 /usr/bin/true']);
  });
  it('falls through when the exec itself fails late (execfail)', async () => {
    const b = box();
    const result = await probe(b, ['--foreground'], {
      BOTBOY_TEST_HW_ARM64: '1', BOTBOY_TEST_SHELL_TRANSLATED: '1', BOTBOY_TEST_ARCH_PROBE_OK: '1',
      BOTBOY_TEST_ARCH_BIN: path.join(b.root, 'no-such-arch'),
    }, false);
    expect(result.seen).toMatch(/pid=\d+ args=--foreground guard= from= /);
    expect(result.out).toContain('got-INT');
  });
});

describe('start.sh › doctor machine rows', () => {
  function machine(overrides: { pressure?: string; swap?: string; freeKb?: string; ram?: string; lsof?: string; flags?: string }) {
    const b = box();
    const sysctlStub = b.stub('sysctl', `case "$2" in
  hw.optional.arm64) echo 1;;
  sysctl.proc_translated) echo 0;;
  hw.memsize) echo ${overrides.ram ?? 17179869184};;
  kern.memorystatus_vm_pressure_level) echo ${overrides.pressure ?? 1};;
  vm.swapusage) echo '${overrides.swap ?? 'total = 1024.00M  used = 100.00M  free = 924.00M  (encrypted)'}';;
esac`);
    const df = b.stub('df', `echo 'Filesystem 1024-blocks Used Available Capacity Mounted'\necho '/dev/disk3 488245288 400000000 ${overrides.freeKb ?? 83886080} 83% /'`);
    const lsof = b.stub('lsof', overrides.lsof ? `echo ${overrides.lsof}` : '');
    const ps = b.stub('ps', `echo ' ${overrides.flags ?? '4006'}'`);
    const chromeFile = path.join(b.dir, 'chrome-bin');
    fs.writeFileSync(chromeFile, '');
    const file = b.stub('file', `echo '${FAT_CHROME}'`);
    return b.run('BOTBOY_TEST_DOCTOR_MACHINE', {
      BOTBOY_TEST_SYSCTL_BIN: sysctlStub, BOTBOY_TEST_DF_BIN: df, BOTBOY_TEST_LSOF_BIN: lsof, BOTBOY_TEST_PS_BIN: ps,
      BOTBOY_TEST_FILE_BIN: file, BOTBOY_TEST_CHROME_BIN: chromeFile, BOTBOY_TEST_NODE_BIN: process.execPath,
      BOTBOY_TEST_HW_ARM64: '1', BOTBOY_TEST_ARCH_PROBE_OK: '1',
    }).stdout;
  }

  it('prints healthy rows without warnings', () => {
    const out = machine({});
    expect(out).toContain('hardware: Apple Silicon');
    expect(out).toContain('RAM: 16 GB');
    expect(out).toContain('free disk: 80.0 GB');
    expect(out).toContain('memory pressure: normal');
    expect(out).toContain('swap used: 0.1 GB');
    expect(out).toContain('running debug Chrome: not running');
    expect(out).not.toContain('WARN');
  });
  it('warns on a small disk and says what to do', () => {
    const out = machine({ freeKb: '3145728' });
    expect(out).toContain('free disk: 3.0 GB — WARN: free some space; BotBoy needs room for its database and Chrome profile');
  });
  it('warns on memory pressure and on large swap during pressure, each with an action', () => {
    const out = machine({ pressure: '4', swap: 'total = 8192.00M  used = 6144.00M  free = 2048.00M  (encrypted)' });
    expect(out).toContain('memory pressure: critical — close other apps or restart the Mac; BotBoy slows its browser capture while this lasts');
    expect(out).toContain('swap used: 6.0 GB — WARN: more than a quarter of RAM is swapped out while memory pressure is up; close other apps or restart the Mac');
  });
  it('does not warn on swap alone, nor on an absolute swap size', () => {
    const out = machine({ pressure: '1', swap: 'total = 8192.00M  used = 6144.00M  free = 2048.00M  (encrypted)' });
    expect(out).toContain('swap used: 6.0 GB');
    expect(out).not.toContain('swap used: 6.0 GB —');
  });
  it('reads the running debug Chrome from its process flags', () => {
    expect(machine({ lsof: '4242', flags: '34006' })).toContain('running debug Chrome: translated (slow) — quit it and run ./start.sh again');
    expect(machine({ lsof: '4242', flags: '4006' })).toContain('running debug Chrome: native');
    expect(machine({ lsof: '4242', flags: 'garbage' })).toContain('running debug Chrome: not checked');
  });
});

describe('start.sh › no Xcode shim without Command Line Tools', () => {
  it('runs no xcrun, git, lipo, or compiler when xcode-select -p fails', () => {
    const b = box();
    const xcodeSelect = b.recording('xcode-select', 'exit 2');
    const xcrun = b.recording('xcrun', 'exit 1');
    const gitShim = b.recording('git', 'exit 1');
    // Not named *.app: macOS assesses (and may register) anything that looks like an application bundle once something runs from it.
    const bundle = path.join(b.root, 'bundle-under-test');
    fs.mkdirSync(path.join(b.dir, 'scripts'), { recursive: true });
    fs.copyFileSync(nativePrebuiltPath, path.join(b.dir, 'scripts', 'native-prebuilt.mjs'));
    fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'Contents', 'MacOS', 'BotBoy'), '');
    const file = b.stub('file', `echo '${INTEL_ONLY}'`);
    fs.mkdirSync(path.join(b.dir, 'native', 'vision-ocr'), { recursive: true });
    fs.writeFileSync(path.join(b.dir, 'native', 'vision-ocr', 'main.swift'), '// stub\n');
    const env = {
      BOTBOY_TEST_XCODE_SELECT_BIN: xcodeSelect,
      BOTBOY_TEST_XCRUN_BIN: xcrun,
      BOTBOY_TEST_GIT_SHIM: gitShim,
      BOTBOY_TEST_HW_ARM64: '1',
      BOTBOY_TEST_ARCH_PROBE_OK: '1',
      BOTBOY_TEST_FILE_BIN: file,
      BOTBOY_TEST_APP_BUNDLE: bundle,
      BOTBOY_TEST_LSREGISTER_BIN: b.stub('lsregister', ''),
      BOTBOY_TEST_PLISTBUDDY_BIN: b.stub('plistbuddy', ''),
      BOTBOY_TEST_LSOF_BIN: b.stub('lsof', ''),
      PATH: `${b.stubs}:/usr/bin:/bin:/usr/sbin:/sbin:${path.dirname(process.execPath)}`,
    };
    for (const hook of ['BOTBOY_TEST_APP_LAUNCHER_PLAN', 'BOTBOY_TEST_DOCTOR_APP', 'BOTBOY_TEST_DOCTOR_MACHINE', 'BOTBOY_TEST_DOCTOR_TOOLCHAIN', 'BOTBOY_TEST_OCR_REBUILD']) {
      const result = b.run(hook, env);
      expect(result.status, `${hook}: ${result.stderr}`).toBe(0);
    }
    expect(b.marked('xcode-select')).toBe(true);
    expect(b.marked('xcrun')).toBe(false);
    expect(b.marked('git')).toBe(false);
    // The Intel-only launcher is left alone: a warning, never a rebuild.
    expect(b.run('BOTBOY_TEST_APP_LAUNCHER_PLAN', env).stdout).toContain('plan=warn_harmless');
  });
});
