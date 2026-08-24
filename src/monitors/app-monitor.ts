/**
 * App Monitor — tracks native macOS application activity.
 *
 * Uses AppleScript to detect active application, window title, and
 * extract metadata from specific apps (IDE, Slack native, Notes).
 * Polls at configurable intervals to stay within CPU budget.
 */

import { execSync } from 'child_process';
import type { RawWorkItem, WorkItemType } from '../core/types.js';

export interface AppMonitor {
  start(): void;
  stop(): void;
  onWorkItem(callback: (item: RawWorkItem) => void): void;
}

export interface AppMonitorConfig {
  pollIntervalMs: number;
}

const DEFAULT_CONFIG: AppMonitorConfig = {
  pollIntervalMs: 5000,
};

interface AppInfo {
  name: string;
  windowTitle: string;
}

// ── AppleScript helpers ──

function getActiveApp(): AppInfo | null {
  try {
    const script = `
      tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set appName to name of frontApp
        try
          set winTitle to name of front window of frontApp
        on error
          set winTitle to ""
        end try
        return appName & "|||" & winTitle
      end tell
    `;
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8', timeout: 3000,
    }).trim();
    const [name, windowTitle] = result.split('|||');
    return { name: name || '', windowTitle: windowTitle || '' };
  } catch {
    return null;
  }
}

// ── App-specific metadata extraction ──

function classifyApp(app: AppInfo): { type: WorkItemType; metadata: Record<string, string> } {
  const name = app.name.toLowerCase();
  const title = app.windowTitle;

  // IDEs
  if (['code', 'visual studio code', 'intellij idea', 'webstorm', 'pycharm', 'xcode', 'kiro'].some(ide => name.includes(ide))) {
    const projectMatch = title.match(/^(.+?)\s+[—–-]\s+/);
    const fileMatch = title.match(/[—–-]\s+(\S+\.\w+)/);
    return {
      type: 'app_activity',
      metadata: {
        projectName: projectMatch?.[1] ?? '',
        activeFilePath: fileMatch?.[1] ?? '',
        appCategory: 'ide',
      },
    };
  }

  // Slack native — foreground-window telemetry only. The dedicated Slack
  // monitor is the sole source of actual slack_message records.
  if (name.includes('slack')) {
    return {
      type: 'app_activity',
      metadata: {
        channelOrDm: title,
        platform: 'native',
        appCategory: 'messaging',
        captureMode: 'passive_observation',
      },
    };
  }

  // Notes
  if (name === 'notes') {
    return {
      type: 'app_activity',
      metadata: { noteTitle: title, appCategory: 'notes' },
    };
  }

  // Document editors
  if (['pages', 'numbers', 'keynote', 'microsoft word', 'microsoft excel', 'microsoft powerpoint', 'libreoffice'].some(d => name.includes(d))) {
    return {
      type: 'app_activity',
      metadata: { fileName: title, appCategory: 'document_editor' },
    };
  }

  // Generic app
  return {
    type: 'app_activity',
    metadata: { appCategory: 'other' },
  };
}

export function createAppMonitor(config?: Partial<AppMonitorConfig>): AppMonitor {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const listeners: ((item: RawWorkItem) => void)[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastAppKey = '';

  function emit(item: RawWorkItem): void {
    for (const fn of listeners) {
      try { fn(item); } catch (err) { console.error('AppMonitor listener error:', err); }
    }
  }

  function pollOnce(): void {
    const app = getActiveApp();
    if (!app || !app.name) return;

    // Only emit on app/window change
    const key = `${app.name}|${app.windowTitle}`;
    if (key === lastAppKey) return;
    lastAppKey = key;

    const { type, metadata } = classifyApp(app);

    const item: RawWorkItem = {
      type,
      source: 'app',
      sourceApp: app.name,
      title: app.windowTitle || app.name,
      metadata,
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

// Export for testing
export { classifyApp, type AppInfo };
