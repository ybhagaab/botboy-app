/**
 * Tests for write_file and read_file handlers.
 * Uses isolated temp directories to avoid touching the real files directory.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as fc from 'fast-check';
import { writeFileHandler, readFileHandler } from './tool-executor.js';

let tempDir: string;
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-file-test-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  tempDir = makeTempDir();
});

afterAll(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe('write_file handler', () => {
  it('writes a file in overwrite mode and returns correct metadata', () => {
    const result = writeFileHandler(tempDir, { filename: 'test.html', content: '<h1>Hello</h1>' });
    const parsed = JSON.parse(result);
    expect(parsed.path).toBe(path.resolve(tempDir, 'test.html'));
    expect(parsed.size).toBe(Buffer.byteLength('<h1>Hello</h1>', 'utf-8'));
    expect(parsed.url).toBe('/api/files/test.html');
    expect(fs.readFileSync(path.join(tempDir, 'test.html'), 'utf-8')).toBe('<h1>Hello</h1>');
  });

  it('creates intermediate directories for nested filenames', () => {
    const result = writeFileHandler(tempDir, { filename: 'a/b/c/d/e/deep.txt', content: 'nested' });
    const parsed = JSON.parse(result);
    expect(parsed.url).toBe('/api/files/a/b/c/d/e/deep.txt');
    expect(fs.readFileSync(path.join(tempDir, 'a/b/c/d/e/deep.txt'), 'utf-8')).toBe('nested');
  });

  it('appends content to an existing file', () => {
    writeFileHandler(tempDir, { filename: 'append.txt', content: 'line1\n' });
    const result = writeFileHandler(tempDir, { filename: 'append.txt', content: 'line2\n', mode: 'append' });
    const parsed = JSON.parse(result);
    const content = fs.readFileSync(path.join(tempDir, 'append.txt'), 'utf-8');
    expect(content).toBe('line1\nline2\n');
    expect(parsed.size).toBe(Buffer.byteLength('line1\nline2\n', 'utf-8'));
  });

  it('creates file when appending to non-existent file', () => {
    const result = writeFileHandler(tempDir, { filename: 'new-append.txt', content: 'first', mode: 'append' });
    const parsed = JSON.parse(result);
    expect(parsed.size).toBe(Buffer.byteLength('first', 'utf-8'));
    expect(fs.readFileSync(path.join(tempDir, 'new-append.txt'), 'utf-8')).toBe('first');
  });

  it('rejects empty filename', () => {
    const result = writeFileHandler(tempDir, { filename: '', content: 'x' });
    expect(result).toBe('Error: filename is required');
  });

  it('rejects whitespace-only filename', () => {
    const result = writeFileHandler(tempDir, { filename: '   ', content: 'x' });
    expect(result).toBe('Error: filename is required');
  });

  it('rejects path traversal with ..', () => {
    const result = writeFileHandler(tempDir, { filename: '../escape.txt', content: 'x' });
    expect(result).toBe('Error: path traversal not allowed (..)');
  });

  it('rejects absolute paths', () => {
    const result = writeFileHandler(tempDir, { filename: '/etc/passwd', content: 'x' });
    expect(result).toBe('Error: absolute paths not allowed');
  });
});

describe('write_file property tests', () => {
  // Feature: write-file-tool, Property 1: Write round-trip preserves content
  // Validates: Requirements 2.1, 2.2, 2.6, 3.1
  it('write round-trip preserves content for any valid filename and content', () => {
    const baseNameArb = fc
      .string({ minLength: 1, maxLength: 20, unit: 'grapheme-ascii' })
      .map((s) => s.replace(/[^a-zA-Z0-9_-]/g, ''))
      .filter((s) => s.length > 0);
    const extArb = fc.constantFrom(
      '.html', '.json', '.md', '.txt', '.css', '.js', '.py', '.sh', '.csv'
    );
    const segmentArb = baseNameArb;
    const subdirsArb = fc.array(segmentArb, { minLength: 0, maxLength: 3 });

    const filenameArb = fc
      .tuple(subdirsArb, baseNameArb, extArb)
      .map(([dirs, base, ext]) => [...dirs, base + ext].join('/'));

    // fc.string() produces Unicode strings; filter out null bytes which are
    // invalid on filesystems (this is not what Property 1 is testing).
    const contentArb = fc.string().filter((s) => !s.includes('\0'));

    fc.assert(
      fc.property(filenameArb, contentArb, (filename, content) => {
        const dir = makeTempDir();
        const result = writeFileHandler(dir, { filename, content });

        // Must be a valid JSON success response, not an error string
        expect(result.startsWith('Error:')).toBe(false);
        const parsed = JSON.parse(result);
        expect(parsed.url).toBe(`/api/files/${filename}`);

        // Round-trip: content read from disk matches what was written
        const diskContent = fs.readFileSync(path.join(dir, filename), 'utf-8');
        expect(diskContent).toBe(content);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: write-file-tool, Property 3: Success response contains correct metadata
  // Validates: Requirements 5.1, 5.2, 5.3
  it('success response contains correct path, size, and url metadata', () => {
    const baseNameArb = fc
      .string({ minLength: 1, maxLength: 20, unit: 'grapheme-ascii' })
      .map((s) => s.replace(/[^a-zA-Z0-9_-]/g, ''))
      .filter((s) => s.length > 0);
    const extArb = fc.constantFrom(
      '.html', '.json', '.md', '.txt', '.css', '.js', '.py', '.sh', '.csv'
    );
    const subdirsArb = fc.array(baseNameArb, { minLength: 0, maxLength: 3 });

    const filenameArb = fc
      .tuple(subdirsArb, baseNameArb, extArb)
      .map(([dirs, base, ext]) => [...dirs, base + ext].join('/'));

    // Unicode-safe content, excluding null bytes (invalid on filesystems)
    const contentArb = fc.string().filter((s) => !s.includes('\0'));

    fc.assert(
      fc.property(filenameArb, contentArb, (filename, content) => {
        const dir = makeTempDir();
        const result = writeFileHandler(dir, { filename, content });

        // Must be a valid JSON success response, not an error string
        expect(result.startsWith('Error:')).toBe(false);
        const parsed = JSON.parse(result);

        // Requirement 5.1: path is the full resolved filesystem path
        expect(parsed.path).toBe(path.resolve(dir, filename));

        // Requirement 5.2: size matches the file's byte length on disk
        const diskSize = fs.statSync(path.join(dir, filename)).size;
        expect(parsed.size).toBe(diskSize);
        expect(parsed.size).toBe(Buffer.byteLength(content, 'utf-8'));

        // Requirement 5.3: url equals /api/files/<filename>
        expect(parsed.url).toBe(`/api/files/${filename}`);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: write-file-tool, Property 4: Malicious filenames are rejected and no file is written
  // Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5
  it('rejects malicious filenames and does not create any file on disk', () => {
    // Generator (a): filenames containing `..` at random positions
    const segmentArb = fc
      .string({ minLength: 1, maxLength: 10, unit: 'grapheme-ascii' })
      .map((s) => s.replace(/[^a-zA-Z0-9_-]/g, ''))
      .filter((s) => s.length > 0);
    const dotDotFilenameArb = fc
      .tuple(
        fc.array(segmentArb, { minLength: 0, maxLength: 3 }),
        fc.array(segmentArb, { minLength: 0, maxLength: 3 })
      )
      .map(([before, after]) => [...before, '..', ...after].join('/'))
      .filter((s) => s.length > 0 && !s.startsWith('/'));

    // Generator (b): absolute paths starting with `/`
    const absolutePathArb = fc
      .array(segmentArb, { minLength: 1, maxLength: 4 })
      .map((segs) => '/' + segs.join('/'));

    // Generator (c): empty string
    const emptyArb = fc.constant('');

    // Generator (d): whitespace-only strings
    const whitespaceArb = fc
      .stringMatching(/^[ \t\n\r\v\f]+$/)
      .filter((s) => s.length > 0);

    const contentArb = fc.string().filter((s) => !s.includes('\0'));

    const runCase = (expectedError: string | null) =>
      (filename: string, content: string) => {
        const dir = makeTempDir();
        const before = fs.readdirSync(dir);
        expect(before.length).toBe(0);

        const result = writeFileHandler(dir, { filename, content });

        // Must return an error string, not a JSON success response
        expect(result.startsWith('Error:')).toBe(true);
        if (expectedError) {
          expect(result).toBe(expectedError);
        }

        // No files created in the temp dir
        const after = fs.readdirSync(dir);
        expect(after.length).toBe(0);
      };

    fc.assert(
      fc.property(dotDotFilenameArb, contentArb, runCase('Error: path traversal not allowed (..)')),
      { numRuns: 100 }
    );

    fc.assert(
      fc.property(absolutePathArb, contentArb, runCase('Error: absolute paths not allowed')),
      { numRuns: 100 }
    );

    fc.assert(
      fc.property(emptyArb, contentArb, runCase('Error: filename is required')),
      { numRuns: 100 }
    );

    fc.assert(
      fc.property(whitespaceArb, contentArb, runCase('Error: filename is required')),
      { numRuns: 100 }
    );
  });

  // Feature: write-file-tool, Property 2: Append concatenates content
  // Validates: Requirements 2.3, 5.4
  it('append mode concatenates content and returned size matches A + B byte length', () => {
    const baseNameArb = fc
      .string({ minLength: 1, maxLength: 20, unit: 'grapheme-ascii' })
      .map((s) => s.replace(/[^a-zA-Z0-9_-]/g, ''))
      .filter((s) => s.length > 0);
    const extArb = fc.constantFrom(
      '.html', '.json', '.md', '.txt', '.css', '.js', '.py', '.sh', '.csv'
    );
    const subdirsArb = fc.array(baseNameArb, { minLength: 0, maxLength: 3 });

    const filenameArb = fc
      .tuple(subdirsArb, baseNameArb, extArb)
      .map(([dirs, base, ext]) => [...dirs, base + ext].join('/'));

    // Unicode-safe content, excluding null bytes (invalid on filesystems)
    const contentArb = fc.string().filter((s) => !s.includes('\0'));

    fc.assert(
      fc.property(filenameArb, contentArb, contentArb, (filename, contentA, contentB) => {
        const dir = makeTempDir();

        // Write A in overwrite mode
        const writeResult = writeFileHandler(dir, { filename, content: contentA });
        expect(writeResult.startsWith('Error:')).toBe(false);

        // Append B in append mode
        const appendResult = writeFileHandler(dir, { filename, content: contentB, mode: 'append' });
        expect(appendResult.startsWith('Error:')).toBe(false);
        const appendParsed = JSON.parse(appendResult);

        // File on disk should equal A + B
        const diskContent = fs.readFileSync(path.join(dir, filename), 'utf-8');
        expect(diskContent).toBe(contentA + contentB);

        // Returned size matches byte length of A + B
        expect(appendParsed.size).toBe(Buffer.byteLength(contentA + contentB, 'utf-8'));
      }),
      { numRuns: 100 }
    );
  });
});

describe('multi-chunk write', () => {
  it('writes 3 chunks and verifies concatenation with lastLines and lineCount', () => {
    const chunk1 = '<!DOCTYPE html>\n<html>\n<head>\n  <title>Test</title>\n</head>\n<body>';
    const chunk2 = '\n  <div class="main">\n    <h1>Dashboard</h1>\n    <p>Content here</p>\n  </div>';
    const chunk3 = '\n</body>\n</html>';

    // Chunk 1: overwrite
    const r1 = JSON.parse(writeFileHandler(tempDir, { filename: 'big.html', content: chunk1 }));
    expect(r1.url).toBe('/api/files/big.html');

    // Chunk 2: append
    const r2 = JSON.parse(writeFileHandler(tempDir, { filename: 'big.html', content: chunk2, mode: 'append' }));
    expect(r2.lineCount).toBeGreaterThan(0);
    expect(r2.lastLines).toBeDefined();

    // Chunk 3: append
    const r3 = JSON.parse(writeFileHandler(tempDir, { filename: 'big.html', content: chunk3, mode: 'append' }));
    expect(r3.lastLines).toContain('</html>');

    // Verify full content
    const fullContent = fs.readFileSync(path.join(tempDir, 'big.html'), 'utf-8');
    expect(fullContent).toBe(chunk1 + chunk2 + chunk3);

    // Verify junction via read_file
    const lines = fullContent.split('\n');
    // Read around the junction between chunk1 and chunk2
    const chunk1Lines = chunk1.split('\n').length;
    const junctionRead = readFileHandler(tempDir, { filename: 'big.html', startLine: chunk1Lines - 1, endLine: chunk1Lines + 2 });
    expect(junctionRead).toContain('<body>');
    expect(junctionRead).toContain('<div class="main">');
  });
});

describe('read_file handler', () => {
  it('reads full file content', () => {
    fs.writeFileSync(path.join(tempDir, 'read-test.txt'), 'hello\nworld\nfoo\nbar', 'utf-8');
    const result = readFileHandler(tempDir, { filename: 'read-test.txt' });
    expect(result).toBe('hello\nworld\nfoo\nbar');
  });

  it('reads specific line range with line numbers', () => {
    fs.writeFileSync(path.join(tempDir, 'lines.txt'), 'a\nb\nc\nd\ne', 'utf-8');
    const result = readFileHandler(tempDir, { filename: 'lines.txt', startLine: 2, endLine: 4 });
    expect(result).toBe('2: b\n3: c\n4: d');
  });

  it('reads from startLine to end when no endLine', () => {
    fs.writeFileSync(path.join(tempDir, 'partial.txt'), 'one\ntwo\nthree\nfour', 'utf-8');
    const result = readFileHandler(tempDir, { filename: 'partial.txt', startLine: 3 });
    expect(result).toBe('3: three\n4: four');
  });

  it('rejects path traversal', () => {
    const result = readFileHandler(tempDir, { filename: '../etc/passwd' });
    expect(result).toBe('Error: path traversal not allowed (..)');
  });

  it('returns error for non-existent file', () => {
    const result = readFileHandler(tempDir, { filename: 'nope.txt' });
    expect(result).toContain('Error:');
  });
});

// Feature: write-file-tool, Property 5: Failed file-creation commands include write_file guidance
// Mock child_process so exec fails — this drives the run_command handler into its
// catch branch, where file-creation pattern detection appends the guidance tip.
// run_command uses async exec (callback style); execSync stays mocked for any
// legacy import in the module graph.
vi.mock('child_process', () => ({
  execSync: vi.fn(() => { throw new Error('mocked command failure'); }),
  exec: vi.fn((_cmd: unknown, _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    cb(new Error('mocked command failure'), '', '');
  }),
}));

describe('run_command error guidance property tests', () => {
  // Validates: Requirements 6.1
  it('appends write_file guidance tip when a failed command contains file-creation patterns', async () => {
    // Dynamic imports so the vi.mock above applies to child_process before createToolExecutor pulls it in
    const { createToolExecutor } = await import('./tool-executor.js');

    // Minimal stubs — run_command only touches execSync (mocked) and cwd/env setup
    const fakeDb = {} as unknown as import('better-sqlite3').Database;
    const fakeNodeManager = {} as unknown as import('./node-manager.js').NodeManager;
    const executor = createToolExecutor(fakeDb, fakeNodeManager);

    const GUIDANCE_TIP = 'Tip: Use the write_file tool instead of shell commands for creating files. It handles any content size reliably.';

    // Surrounding text: printable ASCII excluding newlines and the injection char
    // for each pattern (so we don't accidentally break the pattern we're embedding)
    const innocuousSurround = (excludeChars: string) => fc
      .string({ minLength: 0, maxLength: 20, unit: 'grapheme-ascii' })
      .map((s) => s.replace(/[\n\r]/g, ' '))
      .map((s) => {
        let out = s;
        for (const c of excludeChars) out = out.split(c).join('');
        return out;
      });

    const wordArb = fc
      .string({ minLength: 1, maxLength: 10, unit: 'grapheme-ascii' })
      .map((s) => s.replace(/[^a-zA-Z0-9_]/g, ''))
      .filter((s) => s.length > 0);

    // (a) heredoc: matches /<<\s*['"]?\w+/
    const heredocArb = fc
      .tuple(
        innocuousSurround('<>`$'),
        fc.constantFrom('<<', '<< ', '<<  '),
        fc.constantFrom('', "'", '"'),
        wordArb
      )
      .map(([prefix, op, quote, tag]) => `${prefix}${op}${quote}${tag}`);

    // (b) cat >: matches /cat\s*>/
    const catRedirectArb = fc
      .tuple(
        innocuousSurround('<>`$'),
        fc.constantFrom('cat>', 'cat >', 'cat  >'),
        innocuousSurround('<>`$\n').map((s) => ` ${s}file.txt`)
      )
      .map(([prefix, op, tail]) => `${prefix}${op}${tail}`);

    // (c) tee: matches /tee\s/
    const teeArb = fc
      .tuple(
        innocuousSurround('<>`$'),
        fc.constant('tee '),
        innocuousSurround('<>`$\n').map((s) => `${s}file.txt`)
      )
      .map(([prefix, op, tail]) => `${prefix}${op}${tail}`);

    // (d) echo >: matches /echo\s.*>/
    const echoRedirectArb = fc
      .tuple(
        innocuousSurround('<>`$'),
        fc.constant('echo '),
        innocuousSurround('<>`$\n'),
        fc.constantFrom('>', ' >', '  >'),
        innocuousSurround('<>`$\n').map((s) => `${s}file.txt`)
      )
      .map(([prefix, op, mid, redir, tail]) => `${prefix}${op}${mid}${redir}${tail}`);

    const fileCreationCommandArb = fc.oneof(heredocArb, catRedirectArb, teeArb, echoRedirectArb);

    // Filter out commands that would trigger the blocked-pattern check in run_command
    // (rm -rf, sudo, etc.) because those return early BEFORE execSync is called,
    // which means they never hit the guidance path — they'd legitimately fail this test.
    const BLOCKED = [/\brm\s+-rf?\b/i, /\bsudo\b/i, /\brmdir\b/i, /\bunlink\b/i, /\bmkfs\b/i, /\bdd\s+if=/i, /\bshutdown\b/i, /\breboot\b/i, /\bkillall\b/i, /\blaunchctl\b/i, />\s*\/dev\/null/];
    const safeCommandArb = fileCreationCommandArb.filter((cmd) => {
      if (cmd.trim().length === 0) return false;
      return !BLOCKED.some((p) => p.test(cmd));
    });

    await fc.assert(
      fc.asyncProperty(safeCommandArb, async (command) => {
        const result = await executor.executeTool({
          id: 'call_test',
          type: 'function',
          function: { name: 'run_command', arguments: JSON.stringify({ command }) },
        });
        expect(result.content.startsWith('Error:')).toBe(true);
        expect(result.content).toContain(GUIDANCE_TIP);
      }),
      { numRuns: 100 }
    );
  });
});

// -----------------------------------------------------------------------------
// Task 4.7: Unit tests for specific examples and edge cases
// -----------------------------------------------------------------------------

describe('run_command success does NOT append write_file guidance', () => {
  // Validates: Requirement 6.2
  // The guidance tip must only be appended on failure, never on successful execution.
  it('returns command output without guidance when a heredoc-style command succeeds', async () => {
    const { exec } = await import('child_process');
    const { createToolExecutor } = await import('./tool-executor.js');

    // The module-level vi.mock makes exec fail by default. For this test,
    // override the next call so the command succeeds and returns output
    // rather than falling into the catch branch where guidance is appended.
    // (The files-dir mkdir prelude uses fs.mkdirSync, not child_process.)
    vi.mocked(exec).mockImplementationOnce(((_cmd: unknown, _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(null, 'hello world\n', '');
      return undefined as any;
    }) as any);

    const fakeDb = {} as unknown as import('better-sqlite3').Database;
    const fakeNodeManager = {} as unknown as import('./node-manager.js').NodeManager;
    const executor = createToolExecutor(fakeDb, fakeNodeManager);

    const heredocCommand = "cat > out.txt <<'EOF'\nhello world\nEOF";
    const result = await executor.executeTool({
      id: 'call_success',
      type: 'function',
      function: { name: 'run_command', arguments: JSON.stringify({ command: heredocCommand }) },
    });

    // Successful execution: no Error: prefix, no guidance tip appended
    expect(result.content.startsWith('Error:')).toBe(false);
    expect(result.content).not.toContain('Tip: Use the write_file tool');
    expect(result.content).toBe('hello world\n');
  });
});

describe('write_file tool definition schema', () => {
  // Validates: Requirement 1.1
  it('exposes write_file with correct parameters via createPromptManager', async () => {
    const { createPromptManager } = await import('./prompt-manager.js');
    const pm = createPromptManager();
    const chatTools = pm.getToolDefinitions('chat');
    const writeFileDef = chatTools.find((t) => t.function.name === 'write_file');

    expect(writeFileDef).toBeDefined();
    expect(writeFileDef!.type).toBe('function');
    expect(writeFileDef!.function.name).toBe('write_file');

    const params = writeFileDef!.function.parameters as any;
    expect(params.type).toBe('object');

    // filename: string, required
    expect(params.properties.filename).toBeDefined();
    expect(params.properties.filename.type).toBe('string');

    // content: string, required
    expect(params.properties.content).toBeDefined();
    expect(params.properties.content.type).toBe('string');

    // mode: string, optional, enum ['overwrite', 'append']
    expect(params.properties.mode).toBeDefined();
    expect(params.properties.mode.type).toBe('string');
    expect(params.properties.mode.enum).toEqual(['overwrite', 'append']);

    // required array includes filename and content, but NOT mode
    expect(params.required).toContain('filename');
    expect(params.required).toContain('content');
    expect(params.required).not.toContain('mode');
  });
});

describe('write_file in role tool lists', () => {
  // Validates: Requirement 1.2
  it('includes write_file in both chat and orchestrator role tool lists', async () => {
    const { createPromptManager } = await import('./prompt-manager.js');
    const pm = createPromptManager();

    const chatToolNames = pm.getToolDefinitions('chat').map((t) => t.function.name);
    const orchestratorToolNames = pm.getToolDefinitions('orchestrator').map((t) => t.function.name);

    expect(chatToolNames).toContain('write_file');
    expect(orchestratorToolNames).toContain('write_file');
  });
});

describe('chat system prompt write_file usage guidance', () => {
  // Validates: Requirements 7.1, 7.2, 7.3
  it('chat prompt mentions write_file, prefers it over shell redirects, and reserves run_command for non-file ops', async () => {
    const { createPromptManager } = await import('./prompt-manager.js');
    const pm = createPromptManager();
    const prompt = pm.getSystemPrompt('chat');

    // Req 7.1: prompt documents the write_file tool
    expect(prompt).toContain('write_file');

    // Req 7.2: instructs to use write_file instead of run_command heredocs/redirects
    // (accept either phrasing: "heredocs" or "redirects", both must be referenced in
    // the context of preferring write_file)
    expect(prompt.toLowerCase()).toMatch(/write_file.*(heredoc|redirect)|(heredoc|redirect).*write_file/s);

    // Req 7.3: reserves run_command for non-file-creation shell operations
    expect(prompt.toLowerCase()).toContain('non-file-creation');
    expect(prompt).toContain('run_command');
  });
});
