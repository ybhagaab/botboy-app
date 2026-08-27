/**
 * File routes — serves agent-generated files from
 * ~/.personal-productivity-tracker/files/ plus the /files/open and
 * /files/reveal macOS shims.
 *
 * NOTE: registration order matters within this module. The /files/* wildcard
 * is declared first and hands off to /files/open and /files/reveal via
 * next() — keep it that way (see AGENT_FIX_LEARNINGS.md #2 for why the
 * wildcard uses dynamic imports).
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { Router, Request, Response } from 'express';
import { paramStr, type RouterDeps } from './deps.js';
import { createDocumentParser } from '../../core/document-parser.js';

export function createFilesRouter(_deps: RouterDeps): Router {
  const router = Router();

  // ── Spreadsheet preview (xlsx/xlsm) for the in-app file overlay ──
  // The overlay renders text formats client-side, but a workbook is a zip —
  // dumping its bytes as text produced the garbage-preview bug (owner report
  // 2026-08-28). This endpoint reuses the same bounded sheet reader the
  // document workbench uses (document-parser › parseXlsxSheet: sheet by
  // NAME, row/char budgets, shared strings, formula cached values).
  // Deliberately NOT under /files/* so the wildcard serve stays untouched
  // (same reasoning as /files-list above).
  router.get('/files-sheet', async (req: Request, res: Response) => {
    const rel = paramStr(req.query.rel as any);
    if (!rel) return res.status(400).json({ error: 'rel query parameter is required' });
    const filesDir = path.resolve(path.join(os.homedir(), '.personal-productivity-tracker', 'files'));
    const resolved = path.resolve(filesDir, rel);
    if (!resolved.startsWith(filesDir + path.sep)) return res.status(403).json({ error: 'Access denied' });
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });
    if (!/\.(xlsx|xlsm)$/i.test(resolved)) return res.status(415).json({ error: 'Only .xlsx/.xlsm files have sheet previews' });
    const parser = createDocumentParser();
    if (!parser.parseXlsxSheet) return res.status(501).json({ error: 'Sheet reader unavailable' });
    try {
      const requestedSheet = paramStr(req.query.sheet as any) ?? '';
      // Preview budget: the overlay caps tables at 1000 rows; 500 keeps the
      // modal snappy and the payload small. "Open in tab"/Finder remain the
      // full-fidelity escape hatches.
      const options = { maxRows: 500, ...(requestedSheet ? { sheet: requestedSheet } : {}) };
      let result = await parser.parseXlsxSheet(resolved, options);
      // No explicit sheet → auto-load the first one so the overlay renders
      // data on open instead of a bare inventory (one server-side hop, not
      // a second browser round-trip).
      if (!requestedSheet && !result.sheet && result.sheets.length > 0) {
        result = await parser.parseXlsxSheet(resolved, { ...options, sheet: result.sheets[0].name });
      }
      res.set('Cache-Control', 'no-store');
      res.json({ sheets: result.sheets.map(sheet => sheet.name), sheet: result.sheet ?? null });
    } catch (error: any) {
      res.status(422).json({ error: `Could not read workbook: ${String(error?.message ?? error).slice(0, 300)}` });
    }
  });

  // ── File listing (for the in-app preview/browser UI) ──
  // Deliberately NOT under /files/* so the wildcard serve stays untouched.
  router.get('/files-list', async (_req: Request, res: Response) => {
    const path = await import('path');
    const fsp = (await import('fs')).promises;
    const filesDir = path.join(os.homedir(), '.personal-productivity-tracker', 'files');
    const out: Array<{ name: string; size: number; mtime: number }> = [];
    const MAX_ENTRIES = 500;

    async function walk(dir: string, rel: string): Promise<void> {
      if (out.length >= MAX_ENTRIES) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= MAX_ENTRIES) return;
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        const relName = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(full, relName);
        } else if (entry.isFile()) {
          try {
            const st = await fsp.stat(full);
            out.push({ name: relName, size: st.size, mtime: st.mtimeMs });
          } catch {
            // File vanished mid-walk — skip.
          }
        }
      }
    }

    await walk(filesDir, '');
    out.sort((a, b) => b.mtime - a.mtime);
    res.set('Cache-Control', 'no-store');
    res.json({ files: out });
  });

  // ── Agent-generated files (served from ~/.personal-productivity-tracker/files/) ──
  router.get('/files/*', async (req: Request, res: Response, next) => {
    // The newer file-action shims `/files/open` and `/files/reveal` (declared
    // below) would otherwise be shadowed by this wildcard since Express
    // dispatches routes in declaration order. Hand off to the next matching
    // handler for those two slugs.
    const slug = req.params[0];
    if (slug === 'open' || slug === 'reveal') return next();
    const os = await import('os');
    const path = await import('path');
    const fs = await import('fs');
    const filePath = path.join(os.homedir(), '.personal-productivity-tracker', 'files', req.params[0]);
    const resolved = path.resolve(filePath);
    // Security: ensure path stays within files directory
    const filesDir = path.resolve(path.join(os.homedir(), '.personal-productivity-tracker', 'files'));
    if (!resolved.startsWith(filesDir)) return res.status(403).json({ error: 'Access denied' });
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });
    res.sendFile(resolved);
  });
  // ── File-action shims ──

  /**
   * Validate a `path` query parameter for `/api/files/open` and
   * `/api/files/reveal`:
   *
   *   - Decode the URL-encoded value.
   *   - Canonicalize via `fs.realpathSync` (rejects symlink escapes).
   *   - Reject if missing → 404, outside `$HOME` → 403.
   *
   * Returns `{ ok: true, resolved }` or `{ ok: false, status, error }`.
   */
  function resolveSafeFilePath(
    rawPath: string | undefined,
  ):
    | { ok: true; resolved: string }
    | { ok: false; status: number; error: string } {
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      return { ok: false, status: 400, error: 'path query parameter is required' };
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      return { ok: false, status: 400, error: 'path is not valid URI-encoded' };
    }
    // Expand a leading `~/` so browser-side callers (which cannot know the
    // real home directory) can still name files under $HOME. The home-prefix
    // check below still applies to whatever the tilde expands to.
    if (decoded === '~' || decoded.startsWith('~/')) {
      decoded = path.join(os.homedir(), decoded.slice(1));
    }
    let resolved: string;
    try {
      resolved = fs.realpathSync(decoded);
    } catch {
      return { ok: false, status: 404, error: `Path does not exist: ${decoded}` };
    }
    const home = os.homedir();
    const homePrefix = home.endsWith('/') ? home : home + '/';
    if (resolved !== home && !resolved.startsWith(homePrefix)) {
      return {
        ok: false,
        status: 403,
        error: `Path is outside the user home directory: ${resolved}`,
      };
    }
    if (!fs.existsSync(resolved)) {
      return { ok: false, status: 404, error: `Path does not exist: ${resolved}` };
    }
    return { ok: true, resolved };
  }

  router.get('/files/open', (req: Request, res: Response) => {
    const check = resolveSafeFilePath(paramStr(req.query.path as any));
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    const child = spawn('open', [check.resolved], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    res.status(204).end();
  });

  router.get('/files/reveal', (req: Request, res: Response) => {
    const check = resolveSafeFilePath(paramStr(req.query.path as any));
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    const child = spawn('open', ['-R', check.resolved], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    res.status(204).end();
  });

 return router;
}
