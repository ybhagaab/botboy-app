/**
 * Persistent ACP Client — JSON-RPC 2.0 over stdio with kiro-cli.
 * Maintains a long-lived kiro-cli process for fast LLM calls (<1s vs 5-10s).
 * Protocol proven via test script: initialize → session/new → session/prompt.
 */

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import { AcpChatMessage, AcpResponse } from './types.js';

export interface AcpClient {
  initialize(): Promise<void>;
  sendPrompt(prompt: string): Promise<AcpResponse>;
  sendMessage(messages: AcpChatMessage[]): Promise<AcpResponse>;
  isAvailable(): boolean;
  close(): void;
}

function resolveKiroBin(): string {
  const home = process.env.HOME || '';
  for (const p of [`${home}/.local/bin/kiro-cli`, `${home}/.toolbox/bin/kiro-cli`]) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return 'kiro-cli';
}

interface PendingReq {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createPersistentAcpClient(opts?: {
  workDir?: string;
  agent?: string;
}): AcpClient {
  const home = process.env.HOME || '';
  const workDir = opts?.workDir || `${home}/.personal-productivity-tracker/workspace`;
  const agent = opts?.agent || 'ppt-agent';
  const bin = resolveKiroBin();
  const sessionFile = `${workDir}/.last-session-id`;

  let proc: ChildProcess | null = null;
  let sessionId: string | null = null;
  let available = false;
  let nextId = 0;
  let buf = '';
  const pending = new Map<number, PendingReq>();
  const chunkListeners: ((method: string, params: any) => void)[] = [];

  function saveSessionId(id: string): void {
    try { fs.writeFileSync(sessionFile, id); } catch {}
  }

  function loadPreviousSessionId(): string | null {
    try { return fs.readFileSync(sessionFile, 'utf-8').trim(); } catch { return null; }
  }

  function sendRpc(id: number, method: string, params: any): void {
    if (!proc?.stdin) return;
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  }

  function sendResponse(id: any, result: any): void {
    if (!proc?.stdin) return;
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  function request(method: string, params: any, timeoutMs = 120000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
        timer,
      });
      sendRpc(id, method, params);
    });
  }

  function onLine(line: string): void {
    let d: any;
    try { d = JSON.parse(line); } catch { return; }

    // Response to our request (has id, no method)
    if (d.id !== undefined && d.id !== null && !d.method && pending.has(d.id)) {
      const p = pending.get(d.id)!;
      pending.delete(d.id);
      if (d.error) p.reject(new Error(d.error.message || JSON.stringify(d.error)));
      else p.resolve(d.result || {});
      return;
    }

    // Permission request — auto-approve
    if (d.method === 'session/request_permission' && d.id !== undefined) {
      sendResponse(d.id, { outcome: { outcome: 'selected', optionId: 'allow_once' } });
      return;
    }

    // Notifications (method, no id) — forward to chunk listeners
    // This includes tool execution updates, which count as activity
    if (d.method) {
      for (const fn of chunkListeners) fn(d.method, d.params);
    }
  }

  async function doInitialize(): Promise<void> {
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

    // Load MCP server config — only chrome-devtools for browser content fetching
    // NOTE: Passing MCP servers to session/new causes 120s+ timeout.
    // Instead, we pass empty and let the agent use bash + CDP protocol directly.
    // The agent config has includeMcpJson:true which may load them separately.
    const mcpList: any[] = [];

    proc = spawn(bin, ['acp', '--agent', agent, '--trust-all-tools'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workDir,
      env: { ...process.env, PATH: `${home}/.local/bin:${home}/.toolbox/bin:${process.env.PATH}` },
    });

    proc.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const l of lines) { if (l.trim()) onLine(l.trim()); }
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg && (msg.includes('ERROR') || msg.includes('error'))) {
        console.log('[ACP] stderr:', msg.slice(0, 200));
      }
    });

    proc.on('exit', code => {
      console.log(`[ACP] kiro-cli exited (code=${code})`);
      available = false;
      proc = null;
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('ACP process exited')); }
      pending.clear();
    });

    // Step 1: Initialize
    const initResult = await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: 'ppt', version: '0.2.0' },
    }, 30000);
    console.log('[ACP] Initialized, protocol:', initResult.protocolVersion);

    // Step 2: Try to resume previous session, fall back to new
    const prevSessionId = loadPreviousSessionId();
    let resumed = false;

    if (prevSessionId) {
      const sessionFilePath = `${home}/.kiro/sessions/cli/${prevSessionId}.json`;
      if (fs.existsSync(sessionFilePath)) {
        try {
          const loadResult = await request('session/load', {
            sessionId: prevSessionId,
            cwd: workDir,
            mcpServers: mcpList,
            _meta: { '_kiro.dev/session_file': sessionFilePath },
          }, 30000);
          if (loadResult.modes) {
            sessionId = prevSessionId;
            resumed = true;
            console.log('[ACP] Session RESUMED:', sessionId);
          }
        } catch {
          console.log('[ACP] Session load failed, creating new');
        }
      }
    }

    if (!resumed) {
      const sessResult = await request('session/new', { cwd: workDir, mcpServers: mcpList }, 120000);
      sessionId = sessResult.sessionId;
      console.log('[ACP] Session NEW:', sessionId);
    }

    if (sessionId) saveSessionId(sessionId);

    // Step 3: Drain MCP init notifications (5s for MCP servers to connect)
    await new Promise(r => setTimeout(r, 5000));
    available = true;
    console.log('[ACP] ✅ Ready (persistent connection)');
  }

  let acpLock = false;

  function isProcessAlive(): boolean {
    if (!proc || !proc.pid) return false;
    try { process.kill(proc.pid, 0); return true; } catch { return false; }
  }

  return {
    async initialize(): Promise<void> {
      try {
        await doInitialize();
      } catch (err) {
        console.warn('[ACP] Init failed:', (err as Error).message);
        available = false;
      }
    },

    async sendPrompt(prompt: string): Promise<AcpResponse> {
      // Wait for any in-flight call to finish (max 30s wait)
      let lockWait = 0;
      while (acpLock) {
        await new Promise(r => setTimeout(r, 500));
        lockWait += 500;
        if (lockWait > 30000) { throw new Error('ACP lock timeout — another call is stuck'); }
      }
      acpLock = true;

      // Check if process is actually alive before trying
      if (!isProcessAlive()) {
        console.log('[ACP] Process is dead, forcing reconnect...');
        available = false;
        proc = null;
        sessionId = null;
      }

      // Auto-reconnect if session is dead
      if (!available || !sessionId) {
        console.log('[ACP] Session dead, reconnecting...');
        if (proc) { try { proc.kill(); } catch {} proc = null; }
        available = false;
        sessionId = null;
        try { await doInitialize(); } catch { acpLock = false; throw new Error('ACP reconnect failed'); }
      }
      if (!available || !sessionId) { acpLock = false; throw new Error('ACP not available'); }

      const chunks: string[] = [];
      let done = false;

      // Activity-based timeout: reset every time we see any activity from the agent.
      // This lets long tool-heavy turns run as long as the agent is actively working.
      const IDLE_TIMEOUT = 120000; // 2 min of silence = dead
      const MAX_TIMEOUT = 600000;  // 10 min absolute max
      let lastActivityTime = Date.now();

      const listener = (method: string, params: any) => {
        lastActivityTime = Date.now(); // ANY notification = agent is alive
        if (method === 'session/update' || method === 'session/notification') {
          const update = params?.update || params;
          const st = update?.sessionUpdate;
          if (st === 'AgentMessageChunk' || st === 'agent_message_chunk') {
            const t = update?.content?.text;
            if (t) { chunks.push(t); }
          }
          if (st === 'TurnEnd') done = true;
        }
      };
      chunkListeners.push(listener);

      // Stall detection: only abort if truly idle (no activity for IDLE_TIMEOUT)
      // AND process is dead, OR we've exceeded MAX_TIMEOUT
      const stallChecker = setInterval(() => {
        const idleMs = Date.now() - lastActivityTime;
        const totalMs = Date.now() - promptStartTime;
        if (done) return;
        if (idleMs > IDLE_TIMEOUT && !isProcessAlive()) {
          console.log(`[ACP] Process died during prompt (idle ${Math.round(idleMs/1000)}s), aborting`);
          available = false;
          for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('ACP process died mid-prompt')); }
          pending.clear();
        } else if (totalMs > MAX_TIMEOUT) {
          console.log(`[ACP] Absolute timeout (${Math.round(totalMs/1000)}s), aborting`);
          for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`ACP prompt exceeded ${MAX_TIMEOUT/1000}s max`)); }
          pending.clear();
        }
      }, 10000);

      const promptStartTime = Date.now();

      try {
        // Use a long hard timeout — the stall checker handles the real timeout logic
        const result = await request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: prompt }],
        }, MAX_TIMEOUT);

        // Wait briefly for remaining chunks
        if (!done) await new Promise(r => setTimeout(r, 1000));

        return { content: chunks.join('') || result?.text || '' };
      } catch (err: any) {
        // Mark session as dead so next call triggers reconnect
        console.log('[ACP] Prompt error:', err.message);
        available = false;
        throw err;
      } finally {
        clearInterval(stallChecker);
        const idx = chunkListeners.indexOf(listener);
        if (idx >= 0) chunkListeners.splice(idx, 1);
        acpLock = false;
      }
    },

    async sendMessage(messages: AcpChatMessage[]): Promise<AcpResponse> {
      const text = messages.map(m => m.content).join('\n');
      return this.sendPrompt(text);
    },

    isAvailable: () => available,

    close(): void {
      if (proc) { try { proc.kill(); } catch {} proc = null; }
      available = false;
      sessionId = null;
      for (const p of pending.values()) { clearTimeout(p.timer); }
      pending.clear();
    },
  };
}

// Backward-compatible alias
export const createAcpClient = createPersistentAcpClient;
