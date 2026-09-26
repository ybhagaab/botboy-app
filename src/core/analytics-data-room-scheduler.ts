import type { AnalyticsDerivationService } from './analytics-data-room-derivation.js';

export interface AnalyticsJobSchedulerLane {
  processNext(): Promise<number>;
}

export interface AnalyticsDataRoomScheduler {
  start(): void;
  stop(): void;
  tick(): Promise<number>;
  readonly running: boolean;
}

export function createAnalyticsDataRoomScheduler(input: {
  derivation: AnalyticsDerivationService;
  jobLane?: AnalyticsJobSchedulerLane;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}): AnalyticsDataRoomScheduler {
  const intervalMs = Math.max(1_000, Math.floor(input.intervalMs ?? 5_000));
  let timer: NodeJS.Timeout | null = null;
  let derivationActive: Promise<number> | null = null;
  let jobActive: Promise<number> | null = null;

  async function runDerivation(): Promise<number> {
    if (derivationActive) return 0;
    input.derivation.recoverExpired();
    derivationActive = input.derivation.processNext();
    try {
      return await derivationActive;
    } finally {
      derivationActive = null;
    }
  }

  async function runJob(): Promise<number> {
    if (!input.jobLane || jobActive) return 0;
    jobActive = input.jobLane.processNext();
    try {
      return await jobActive;
    } finally {
      jobActive = null;
    }
  }

  async function tick(): Promise<number> {
    const [derived, jobs] = await Promise.all([runDerivation(), runJob()]);
    return derived + jobs;
  }

  function schedule(): void {
    void tick().catch(error => input.onError?.(error));
  }

  function start(): void {
    if (timer) return;
    schedule();
    timer = setInterval(schedule, intervalMs);
    timer.unref?.();
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    start,
    stop,
    tick,
    get running() { return timer !== null; },
  };
}
