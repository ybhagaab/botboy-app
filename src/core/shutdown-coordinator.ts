import fs from 'fs';
import path from 'path';
import type http from 'http';
import type net from 'net';

export type ShutdownOutcome = 'pending' | 'clean' | 'forced' | 'failed';
export type ShutdownStageStatus = 'running' | 'completed' | 'timed_out' | 'forced' | 'failed' | 'skipped';

export interface ShutdownStageReceipt {
  name: string;
  status: ShutdownStageStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  timeoutMs: number;
  error: string | null;
}

export interface ShutdownFileBoundary {
  exists: boolean;
  bytes: number | null;
  mtimeMs: number | null;
}

export interface ShutdownDatabaseBoundary {
  db: ShutdownFileBoundary;
  wal: ShutdownFileBoundary;
  shm: ShutdownFileBoundary;
}

export interface ShutdownWorkRegistration {
  id: string;
  kind: string;
  abort?: () => void;
}

export interface ShutdownRuntimeContext {
  readonly signal: AbortSignal;
  isShuttingDown(): boolean;
  registerWork(work: ShutdownWorkRegistration): () => void;
}

export interface ShutdownCloseStage {
  name: string;
  timeoutMs: number;
  close: () => void | Promise<unknown>;
  force?: () => void | Promise<unknown>;
}

export interface ShutdownReceipt {
  schemaVersion: 1;
  pid: number;
  status: 'running' | 'complete' | 'incomplete';
  outcome: ShutdownOutcome;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  hardDeadlineAt: string;
  signals: Array<{ name: NodeJS.Signals; at: string; ordinal: number }>;
  escalation: { requested: boolean; at: string | null; reason: string | null };
  admission: { closed: boolean; closedAt: string | null; shutdownSignalAborted: boolean };
  http: {
    listenerCloseStarted: boolean;
    listenerClosed: boolean;
    socketsAtStart: number;
    requestsAtStart: Array<{ id: string; method: string; path: string; socketId: string }>;
    idleConnectionsClosed: boolean;
    destroyedSocketCount: number;
    remainingSocketIds: string[];
    remainingRequestIds: string[];
  };
  work: {
    activeAtStart: Array<{ id: string; kind: string }>;
    remainingAtFinish: Array<{ id: string; kind: string }>;
    durable: Array<{ id: string; kind: string; disposition: string }>;
    limitations: string[];
  };
  externalChromeOwned: false;
  database: {
    flushQueueCompleted: boolean;
    closeStartedAt: string | null;
    closedAt: string | null;
    closed: boolean;
    before: ShutdownDatabaseBoundary | null;
    after: ShutdownDatabaseBoundary | null;
  };
  forcedReasons: string[];
  stages: ShutdownStageReceipt[];
}

export interface ShutdownCoordinatorOptions {
  server: http.Server;
  databasePath: string;
  flushQueue: () => void;
  closeDatabase: () => void;
  quiesce: () => void;
  closeStages: ShutdownCloseStage[];
  beforeDatabaseClose?: () => void;
  onEscalate?: () => void;
  durableWorkSnapshot?: () => Array<{ id: string; kind: string; disposition: string }>;
  limitations?: string[];
  receiptPath?: string;
  pid?: number;
  httpGraceMs?: number;
  httpSettleMs?: number;
  hardDeadlineMs?: number;
  exit?: (code: number) => void;
  now?: () => number;
}

export interface ShutdownCoordinator {
  readonly context: ShutdownRuntimeContext;
  wrapRequestHandler(handler: http.RequestListener): http.RequestListener;
  begin(signal: NodeJS.Signals): Promise<ShutdownReceipt>;
  escalate(signal: NodeJS.Signals, reason?: string): void;
  receipt(): ShutdownReceipt | null;
}

class StageTimeoutError extends Error {
  constructor(readonly stageName: string, readonly timeoutMs: number) {
    super(`${stageName} did not complete within ${timeoutMs}ms`);
    this.name = 'StageTimeoutError';
  }
}

function safeError(error: unknown): string {
  return String((error as any)?.message ?? error ?? 'unknown error').replace(/\s+/g, ' ').slice(0, 500);
}

function pathnameOnly(url: string | undefined): string {
  const value = String(url ?? '/');
  const end = value.search(/[?#]/);
  return (end >= 0 ? value.slice(0, end) : value).slice(0, 300) || '/';
}

function statBoundary(filePath: string): ShutdownFileBoundary {
  try {
    const stat = fs.statSync(filePath);
    return { exists: true, bytes: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { exists: false, bytes: null, mtimeMs: null };
  }
}

function databaseBoundary(databasePath: string): ShutdownDatabaseBoundary {
  if (!databasePath || databasePath === ':memory:') {
    const absent = { exists: false, bytes: null, mtimeMs: null };
    return { db: { ...absent }, wal: { ...absent }, shm: { ...absent } };
  }
  return {
    db: statBoundary(databasePath),
    wal: statBoundary(`${databasePath}-wal`),
    shm: statBoundary(`${databasePath}-shm`),
  };
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

async function within<T>(name: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new StageTimeoutError(name, timeoutMs)), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createShutdownCoordinator(options: ShutdownCoordinatorOptions): ShutdownCoordinator {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const receiptPath = options.receiptPath ?? `/tmp/ppt-shutdown-${pid}.json`;
  const httpGraceMs = Math.max(1, options.httpGraceMs ?? 5_000);
  const httpSettleMs = Math.max(1, options.httpSettleMs ?? 2_000);
  const hardDeadlineMs = Math.max(httpGraceMs + httpSettleMs, options.hardDeadlineMs ?? 25_000);
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const shutdownController = new AbortController();
  const activeWork = new Map<string, ShutdownWorkRegistration>();
  const sockets = new Map<net.Socket, string>();
  const requests = new Map<string, { id: string; method: string; path: string; socketId: string }>();
  const forcedReasons = new Set<string>();
  let socketCounter = 0;
  let requestCounter = 0;
  let phase: 'idle' | 'running' | 'finalizing' | 'complete' = 'idle';
  let currentReceipt: ShutdownReceipt | null = null;
  let beginPromise: Promise<ShutdownReceipt> | null = null;
  let resolveCompletion: ((receipt: ShutdownReceipt) => void) | null = null;
  let finishPromise: Promise<ShutdownReceipt> | null = null;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  let escalationTimer: ReturnType<typeof setTimeout> | null = null;
  let serverClosePromise: Promise<void> | null = null;
  let resolveServerClose: (() => void) | null = null;
  let receiptWriteFailed = false;

  function iso(value = now()): string {
    return new Date(value).toISOString();
  }

  function socketId(socket: net.Socket): string {
    let id = sockets.get(socket);
    if (!id) {
      id = `sock-${++socketCounter}`;
      sockets.set(socket, id);
      socket.once('close', () => sockets.delete(socket));
    }
    return id;
  }

  options.server.on('connection', socket => { socketId(socket); });

  function syncDynamicReceipt(): void {
    if (!currentReceipt) return;
    currentReceipt.updatedAt = iso();
    currentReceipt.http.remainingSocketIds = [...sockets.values()].sort();
    currentReceipt.http.remainingRequestIds = [...requests.keys()].sort();
    currentReceipt.work.remainingAtFinish = [...activeWork.values()]
      .map(work => ({ id: work.id, kind: work.kind }))
      .sort((left, right) => left.id.localeCompare(right.id));
    currentReceipt.forcedReasons = [...forcedReasons].sort();
  }

  function writeReceipt(): void {
    if (!currentReceipt || phase === 'complete') return;
    syncDynamicReceipt();
    try {
      atomicWriteJson(receiptPath, currentReceipt);
    } catch (error) {
      receiptWriteFailed = true;
      console.error(`[Shutdown] Could not write ${receiptPath}: ${safeError(error)}`);
    }
  }

  function markForced(reason: string): void {
    forcedReasons.add(reason);
    if (!currentReceipt) return;
    currentReceipt.outcome = 'forced';
    if (!currentReceipt.escalation.requested) {
      currentReceipt.escalation = { requested: true, at: iso(), reason };
    }
  }

  function abortWork(): void {
    for (const work of activeWork.values()) {
      try { work.abort?.(); } catch (error) {
        console.warn(`[Shutdown] Could not abort ${work.kind} ${work.id}: ${safeError(error)}`);
      }
    }
  }

  function forceHttp(reason: string): void {
    markForced(reason);
    let destroyed = 0;
    for (const socket of [...sockets.keys()]) {
      if (socket.destroyed) continue;
      destroyed++;
      try { socket.destroy(new Error(`BotBoy shutdown: ${reason}`)); } catch {}
    }
    if (currentReceipt) currentReceipt.http.destroyedSocketCount += destroyed;
  }

  function startServerClose(): Promise<void> {
    if (serverClosePromise) return serverClosePromise;
    if (currentReceipt) currentReceipt.http.listenerCloseStarted = true;
    serverClosePromise = new Promise<void>(resolve => {
      resolveServerClose = resolve;
      try {
        options.server.close(() => {
          if (currentReceipt) currentReceipt.http.listenerClosed = true;
          // Node invokes the close callback only after owned connections have
          // ended. Socket 'close' events can be delivered one turn later, so
          // make the server's stronger completion receipt authoritative.
          sockets.clear();
          resolveServerClose?.();
          resolveServerClose = null;
        });
      } catch (error: any) {
        if (error?.code === 'ERR_SERVER_NOT_RUNNING') {
          if (currentReceipt) currentReceipt.http.listenerClosed = true;
          resolve();
          resolveServerClose = null;
          return;
        }
        console.warn(`[Shutdown] Listener close failed: ${safeError(error)}`);
        resolve();
        resolveServerClose = null;
      }
    });
    try {
      options.server.closeIdleConnections?.();
      if (currentReceipt) currentReceipt.http.idleConnectionsClosed = true;
    } catch {}
    return serverClosePromise;
  }

  function stageReceipt(name: string, timeoutMs: number): ShutdownStageReceipt {
    const stage: ShutdownStageReceipt = {
      name,
      status: 'running',
      startedAt: iso(),
      endedAt: null,
      durationMs: null,
      timeoutMs,
      error: null,
    };
    currentReceipt?.stages.push(stage);
    return stage;
  }

  function finishStage(stage: ShutdownStageReceipt, status: ShutdownStageStatus, error?: unknown): void {
    if (phase !== 'running') return;
    const ended = now();
    stage.status = status;
    stage.endedAt = iso(ended);
    stage.durationMs = Math.max(0, ended - Date.parse(stage.startedAt));
    stage.error = error === undefined ? null : safeError(error);
    writeReceipt();
  }

  async function runCloseStage(definition: ShutdownCloseStage): Promise<void> {
    const stage = stageReceipt(definition.name, definition.timeoutMs);
    writeReceipt();
    try {
      await within(definition.name, Promise.resolve().then(definition.close), definition.timeoutMs);
      finishStage(stage, 'completed');
    } catch (error) {
      if (error instanceof StageTimeoutError) {
        markForced(`${definition.name}_timeout`);
        if (definition.force) {
          try {
            await within(`${definition.name}_force`, Promise.resolve().then(definition.force), httpSettleMs);
            finishStage(stage, 'forced', error);
            return;
          } catch (forceError) {
            finishStage(stage, 'timed_out', `${safeError(error)}; force: ${safeError(forceError)}`);
            return;
          }
        }
        finishStage(stage, 'timed_out', error);
        return;
      }
      finishStage(stage, 'failed', error);
    }
  }

  async function runHttpStage(): Promise<void> {
    const stage = stageReceipt('http', httpGraceMs + httpSettleMs);
    writeReceipt();
    const closePromise = startServerClose();
    try {
      await within('http_grace', closePromise, httpGraceMs);
      finishStage(stage, 'completed');
      return;
    } catch (error) {
      forceHttp('http_grace_timeout');
      try {
        await within('http_settle', closePromise, httpSettleMs);
        finishStage(stage, 'forced', error);
      } catch (settleError) {
        finishStage(stage, 'timed_out', `${safeError(error)}; settle: ${safeError(settleError)}`);
      }
    }
  }

  function initialReceipt(signal: NodeJS.Signals): ShutdownReceipt {
    const started = now();
    return {
      schemaVersion: 1,
      pid,
      status: 'running',
      outcome: 'pending',
      startedAt: iso(started),
      updatedAt: iso(started),
      completedAt: null,
      hardDeadlineAt: iso(started + hardDeadlineMs),
      signals: [{ name: signal, at: iso(started), ordinal: 1 }],
      escalation: { requested: false, at: null, reason: null },
      admission: { closed: true, closedAt: iso(started), shutdownSignalAborted: false },
      http: {
        listenerCloseStarted: false,
        listenerClosed: false,
        socketsAtStart: sockets.size,
        requestsAtStart: [...requests.values()].sort((left, right) => left.id.localeCompare(right.id)),
        idleConnectionsClosed: false,
        destroyedSocketCount: 0,
        remainingSocketIds: [],
        remainingRequestIds: [],
      },
      work: {
        activeAtStart: [...activeWork.values()]
          .map(work => ({ id: work.id, kind: work.kind }))
          .sort((left, right) => left.id.localeCompare(right.id)),
        remainingAtFinish: [],
        durable: options.durableWorkSnapshot?.() ?? [],
        limitations: [...(options.limitations ?? [])],
      },
      externalChromeOwned: false,
      database: {
        flushQueueCompleted: false,
        closeStartedAt: null,
        closedAt: null,
        closed: false,
        before: null,
        after: null,
      },
      forcedReasons: [],
      stages: [],
    };
  }

  function runSynchronousStage(name: string, operation: () => void): void {
    const stage = stageReceipt(name, 0);
    try {
      operation();
      finishStage(stage, 'completed');
    } catch (error) {
      finishStage(stage, 'failed', error);
    }
  }

  function finalize(trigger: string): Promise<ShutdownReceipt> {
    if (finishPromise) return finishPromise;
    phase = 'finalizing';
    finishPromise = Promise.resolve().then(() => {
      if (hardTimer) clearTimeout(hardTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (sockets.size || requests.size) forceHttp(`${trigger}_remaining_http`);
      if (activeWork.size) markForced(`${trigger}_remaining_work`);

      let failed = receiptWriteFailed
        || Boolean(currentReceipt?.stages.some(stage => stage.status === 'failed'));
      try {
        options.beforeDatabaseClose?.();
      } catch (error) {
        failed = true;
        console.error(`[Shutdown] Final bookkeeping failed: ${safeError(error)}`);
      }
      try {
        options.flushQueue();
        if (currentReceipt) currentReceipt.database.flushQueueCompleted = true;
      } catch (error) {
        failed = true;
        console.error(`[Shutdown] Queue flush failed: ${safeError(error)}`);
      }

      if (currentReceipt) {
        currentReceipt.database.before = databaseBoundary(options.databasePath);
        currentReceipt.database.closeStartedAt = iso();
      }
      try {
        options.closeDatabase();
        if (currentReceipt) {
          currentReceipt.database.closed = true;
          currentReceipt.database.closedAt = iso();
        }
      } catch (error) {
        failed = true;
        console.error(`[Shutdown] Database close failed: ${safeError(error)}`);
      }
      if (currentReceipt) currentReceipt.database.after = databaseBoundary(options.databasePath);

      if (!currentReceipt) throw new Error('Shutdown receipt was not initialized');
      syncDynamicReceipt();
      const forced = forcedReasons.size > 0
        || currentReceipt.stages.some(stage => stage.status === 'timed_out' || stage.status === 'forced');
      currentReceipt.outcome = failed ? 'failed' : forced ? 'forced' : 'clean';
      currentReceipt.status = currentReceipt.database.closed ? 'complete' : 'incomplete';
      currentReceipt.completedAt = iso();
      currentReceipt.updatedAt = currentReceipt.completedAt;
      try {
        atomicWriteJson(receiptPath, currentReceipt);
      } catch (error) {
        currentReceipt.outcome = 'failed';
        currentReceipt.status = 'incomplete';
        console.error(`[Shutdown] Final receipt failed: ${safeError(error)}`);
      }
      phase = 'complete';
      const code = currentReceipt.outcome === 'clean' && currentReceipt.status === 'complete' ? 0 : 2;
      resolveCompletion?.(currentReceipt);
      resolveCompletion = null;
      exit(code);
      return currentReceipt;
    });
    return finishPromise;
  }

  async function runShutdown(): Promise<ShutdownReceipt> {
    const operations = [runHttpStage(), ...options.closeStages.map(runCloseStage)];
    await Promise.all(operations);
    return finalize('stages_complete');
  }

  const context: ShutdownRuntimeContext = {
    signal: shutdownController.signal,
    isShuttingDown: () => phase !== 'idle',
    registerWork(work) {
      if (!work.id || !work.kind) throw new Error('Shutdown work requires id and kind');
      if (activeWork.has(work.id)) throw new Error(`Shutdown work is already registered: ${work.id}`);
      if (phase !== 'idle') {
        try { work.abort?.(); } catch {}
        return () => {};
      }
      activeWork.set(work.id, work);
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        activeWork.delete(work.id);
      };
    },
  };

  function begin(signal: NodeJS.Signals): Promise<ShutdownReceipt> {
    if (phase !== 'idle') {
      escalate(signal, 'second_signal');
      return beginPromise ?? finalize('repeat_signal');
    }
    phase = 'running';
    currentReceipt = initialReceipt(signal);
    writeReceipt();
    if (!shutdownController.signal.aborted) {
      shutdownController.abort(new Error(`BotBoy shutdown after ${signal}`));
    }
    currentReceipt.admission.shutdownSignalAborted = true;
    abortWork();
    startServerClose();
    runSynchronousStage('quiesce', options.quiesce);
    writeReceipt();
    hardTimer = setTimeout(() => {
      markForced('hard_deadline');
      forceHttp('hard_deadline');
      abortWork();
      try { options.onEscalate?.(); } catch {}
      writeReceipt();
      void finalize('hard_deadline');
    }, hardDeadlineMs);
    beginPromise = new Promise<ShutdownReceipt>(resolve => { resolveCompletion = resolve; });
    void runShutdown().catch(error => {
      if (phase === 'running') {
        const stage = stageReceipt('coordinator', 0);
        finishStage(stage, 'failed', error);
      }
      void finalize('coordinator_error');
    });
    return beginPromise;
  }

  function escalate(signal: NodeJS.Signals, reason = 'second_signal'): void {
    if (phase === 'idle') {
      void begin(signal);
      return;
    }
    if (phase === 'complete') return;
    currentReceipt?.signals.push({ name: signal, at: iso(), ordinal: (currentReceipt?.signals.length ?? 0) + 1 });
    markForced(reason);
    if (!shutdownController.signal.aborted) shutdownController.abort(new Error(`BotBoy shutdown escalation: ${reason}`));
    abortWork();
    forceHttp(reason);
    try { options.onEscalate?.(); } catch (error) {
      console.warn(`[Shutdown] Escalation callback failed: ${safeError(error)}`);
    }
    writeReceipt();
    if (!escalationTimer) {
      escalationTimer = setTimeout(() => { void finalize(reason); }, httpSettleMs);
    }
  }

  function wrapRequestHandler(handler: http.RequestListener): http.RequestListener {
    return (request, response) => {
      if (phase !== 'idle') {
        response.statusCode = 503;
        response.setHeader('Connection', 'close');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ error: 'BotBoy is shutting down', shuttingDown: true }));
        return;
      }
      const id = `req-${++requestCounter}`;
      const entry = {
        id,
        method: String(request.method ?? 'UNKNOWN').slice(0, 16),
        path: pathnameOnly(request.url),
        socketId: socketId(request.socket),
      };
      requests.set(id, entry);
      let registered = true;
      const unregister = () => {
        if (!registered) return;
        registered = false;
        requests.delete(id);
      };
      response.once('finish', unregister);
      response.once('close', unregister);
      handler(request, response);
    };
  }

  return {
    context,
    wrapRequestHandler,
    begin,
    escalate,
    receipt: () => currentReceipt,
  };
}
