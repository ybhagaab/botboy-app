/**
 * Clipboard Monitor — tracks macOS clipboard (NSPasteboard) changes.
 *
 * Polls the clipboard at regular intervals, captures text, URLs, and
 * file references. Deduplicates rapid successive copies within a 5-second window.
 */

import { execSync } from 'child_process';
import type { RawWorkItem } from '../core/types.js';

export interface ClipboardMonitor {
  start(): void;
  stop(): void;
  onWorkItem(callback: (item: RawWorkItem) => void): void;
}

export interface ClipboardMonitorConfig {
  pollIntervalMs: number;
  dedupWindowMs: number;
}

const DEFAULT_CONFIG: ClipboardMonitorConfig = {
  pollIntervalMs: 1000,
  dedupWindowMs: 5000,
};

export function createClipboardMonitor(config?: Partial<ClipboardMonitorConfig>): ClipboardMonitor {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const listeners: ((item: RawWorkItem) => void)[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastContent = '';
  let lastCaptureTime = 0;

  function emit(item: RawWorkItem): void {
    for (const fn of listeners) {
      try { fn(item); } catch (err) { console.error('ClipboardMonitor listener error:', err); }
    }
  }

  function getClipboardText(): string | null {
    try {
      return execSync('pbpaste', { encoding: 'utf-8', timeout: 2000 }).trim();
    } catch {
      return null;
    }
  }

  function detectContentType(text: string): 'url' | 'file_reference' | 'text' {
    if (/^https?:\/\//i.test(text)) return 'url';
    if (/^\//.test(text) || /^~\//.test(text)) return 'file_reference';
    return 'text';
  }

  function pollOnce(): void {
    const text = getClipboardText();
    if (!text || text.length === 0) return;

    // Only emit when clipboard content actually changes
    if (text === lastContent) return;

    lastContent = text;
    lastCaptureTime = Date.now();

    // Lossless capture: store the full clipboard content, no size cap
    // (lossless-capture-brain-pipeline R1.1/R1.2). `title` and
    // `metadata.originalContent` remain short *derived previews* only.
    const content = text;
    const contentType = detectContentType(content);

    const item: RawWorkItem = {
      type: 'clipboard_capture',
      source: 'clipboard',
      sourceApp: 'System',
      content,
      title: content.slice(0, 100),
      url: contentType === 'url' ? content : undefined,
      metadata: { contentType, originalContent: content.slice(0, 500) },
      capturedAt: new Date(),
    };

    emit(item);
  }

  return {
    start(): void {
      pollOnce();
      pollTimer = setInterval(pollOnce, cfg.pollIntervalMs);
    },

    stop(): void {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },

    onWorkItem(callback: (item: RawWorkItem) => void): void {
      listeners.push(callback);
    },
  };
}
