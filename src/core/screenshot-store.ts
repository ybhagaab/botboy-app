import fs from 'fs';
import path from 'path';
import os from 'os';

export interface ScreenshotStore {
  save(workItemId: string, imageBuffer: Buffer, format?: 'png' | 'jpeg'): string;
  get(workItemId: string): Buffer | null;
  getPath(workItemId: string): string | null;
  delete(workItemId: string): void;
}

const DEFAULT_DIR = path.join(os.homedir(), '.personal-productivity-tracker', 'screenshots');

export function createScreenshotStore(dir?: string): ScreenshotStore {
  const screenshotDir = dir ?? DEFAULT_DIR;

  function ensureDir(): void {
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }
  }

  function filePath(workItemId: string, format: string = 'png'): string {
    return path.join(screenshotDir, `${workItemId}.${format}`);
  }

  function findFile(workItemId: string): string | null {
    for (const ext of ['png', 'jpeg']) {
      const p = filePath(workItemId, ext);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  return {
    save(workItemId: string, imageBuffer: Buffer, format: 'png' | 'jpeg' = 'png'): string {
      ensureDir();
      const p = filePath(workItemId, format);
      fs.writeFileSync(p, imageBuffer);
      return p;
    },

    get(workItemId: string): Buffer | null {
      const p = findFile(workItemId);
      if (!p) return null;
      return fs.readFileSync(p);
    },

    getPath(workItemId: string): string | null {
      return findFile(workItemId);
    },

    delete(workItemId: string): void {
      const p = findFile(workItemId);
      if (p) fs.unlinkSync(p);
    },
  };
}
