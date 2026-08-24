#!/usr/bin/env node
/**
 * bootstrap-deps — build/verify/install local tool dependencies.
 *
 * Modes:
 *   node scripts/bootstrap-deps.mjs                  verify + build helper (no installs)
 *   node scripts/bootstrap-deps.mjs --install        also install missing core tools via Homebrew
 *   node scripts/bootstrap-deps.mjs --install --with-optional
 *                                                    also install the optional set (ffmpeg, whisper, ollama)
 *
 * Idempotent and safely re-runnable:
 *   - Builds the macOS `vision-ocr` Swift helper if it is missing or stale.
 *   - Verifies every external CLI tool BotBoy shells out to (the canonical
 *     registry lives in src/core/toolchain.ts — keep the lists aligned).
 *   - With --install, installs missing Homebrew formulas non-interactively.
 *   - Does NOT modify OS-wide auto-update settings.
 *
 * Safe to run on non-macOS (it no-ops the OCR build with a clear notice) so it
 * can sit in a guarded `postinstall` without breaking CI installs.
 */

import { existsSync, mkdirSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const swiftSrc = path.join(root, 'native', 'vision-ocr', 'main.swift');
const binDir = path.join(root, 'native', 'vision-ocr', 'bin');
const bin = path.join(binDir, 'vision-ocr');

const INSTALL = process.argv.includes('--install');
const WITH_OPTIONAL = process.argv.includes('--with-optional');

// Keep aligned with TOOL_REGISTRY in src/core/toolchain.ts.
// Core is EMPTY by design: the native vision-ocr helper (built below) covers
// PDF text extraction and rasterization via PDFKit/CoreGraphics, so Homebrew
// is fully optional for BotBoy's capture pipeline.
const CORE_FORMULAS = [];
const OPTIONAL_FORMULAS = [
  { bins: ['pdftotext', 'pdftoppm'], formula: 'poppler', why: 'PDF tooling fallback (native helper is primary)' },
  { bins: ['ffmpeg'], formula: 'ffmpeg', why: 'audio/video conversion' },
  { bins: ['whisper'], formula: 'openai-whisper', why: 'audio transcription' },
  { bins: ['ollama'], formula: 'ollama', why: 'local LLM fallback' },
];

function log(msg) {
  console.log(`[bootstrap-deps] ${msg}`);
}

function hasBin(b) {
  // Search PATH plus the install layouts BotBoy's runtime discovery checks,
  // so verification matches what the server will actually find.
  const home = os.homedir();
  const dirs = [
    ...(process.env.PATH || '').split(path.delimiter),
    path.join(home, 'homebrew', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    '/usr/bin',
    '/bin',
  ];
  return dirs.filter(Boolean).some((d) => existsSync(path.join(d, b)));
}

function findBrew() {
  const home = os.homedir();
  const candidates = [
    ...(process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, 'brew')),
    path.join(home, 'homebrew', 'bin', 'brew'),
    '/opt/homebrew/bin/brew',
    '/usr/local/bin/brew',
  ];
  return candidates.find((c) => c && existsSync(c)) || null;
}

function buildVisionHelper() {
  if (process.platform !== 'darwin') {
    log('skip: Apple Vision OCR helper only builds on macOS (non-darwin platform).');
    return;
  }
  if (!existsSync(swiftSrc)) {
    log(`skip: helper source not found at ${swiftSrc}`);
    return;
  }
  // Idempotent: rebuild only if binary is missing or older than the source.
  const needsBuild = !existsSync(bin) || statSync(bin).mtimeMs < statSync(swiftSrc).mtimeMs;
  if (!needsBuild) {
    log('vision-ocr helper is up to date.');
    return;
  }
  try {
    execFileSync('which', ['swiftc'], { stdio: 'ignore' });
  } catch {
    log('WARNING: swiftc not found. Install Xcode Command Line Tools: xcode-select --install');
    return;
  }
  mkdirSync(binDir, { recursive: true });
  log('building vision-ocr helper...');
  execFileSync('swiftc', ['-O', swiftSrc, '-o', bin], { stdio: 'inherit' });
  log(`built ${bin}`);
}

function missingEntries(entries) {
  return entries.filter((e) => e.bins.some((b) => !hasBin(b)));
}

function installFormulas(brew, entries) {
  for (const entry of entries) {
    log(`installing ${entry.formula} (${entry.why})...`);
    try {
      execFileSync(brew, ['install', entry.formula], {
        stdio: 'inherit',
        env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', NONINTERACTIVE: '1' },
        timeout: 15 * 60 * 1000,
      });
    } catch (e) {
      log(`WARNING: brew install ${entry.formula} failed (${e?.message || 'unknown error'}). Install it manually.`);
    }
  }
}

function warnOnCustomBrewPrefix(brew) {
  // Homebrew only ships prebuilt bottles for its default prefix
  // (/opt/homebrew on Apple Silicon). A custom prefix (e.g. ~/homebrew from a
  // no-admin install) forces SOURCE BUILDS: poppler took 35+ minutes on such
  // a setup (observed 2026-08-20). Warn so teammates know why installs crawl.
  if (!brew) return;
  const prefix = path.resolve(brew, '..', '..');
  if (prefix === '/opt/homebrew' || prefix === '/usr/local') return;
  log(`NOTE: your Homebrew prefix is ${prefix} (non-standard).`);
  log('      Installs COMPILE FROM SOURCE instead of using prebuilt bottles — expect long install times.');
  log('      If you have admin rights, the standard install (https://brew.sh) into /opt/homebrew is much faster.');
}

function verifyAndInstallTools() {
  if (process.platform !== 'darwin') {
    log('skip: tool install/verify targets macOS.');
    return;
  }
  warnOnCustomBrewPrefix(findBrew());
  const missingCore = missingEntries(CORE_FORMULAS);
  const missingOptional = missingEntries(OPTIONAL_FORMULAS);

  if (missingCore.length === 0) {
    log('no Homebrew tools are required — the native helper covers PDF parsing and OCR.');
  } else if (INSTALL) {
    const brew = findBrew();
    if (brew) {
      installFormulas(brew, missingCore);
    } else {
      log('WARNING: Homebrew not found — cannot auto-install. Install brew (https://brew.sh), then run: npm run setup');
      for (const e of missingCore) log(`  missing: ${e.bins.join(', ')} — brew install ${e.formula} (${e.why})`);
    }
  } else {
    for (const e of missingCore) {
      log(`WARNING: missing ${e.bins.join(', ')} — run "npm run setup" or: brew install ${e.formula} (${e.why})`);
    }
  }

  if (WITH_OPTIONAL && INSTALL && missingOptional.length > 0) {
    const brew = findBrew();
    if (brew) installFormulas(brew, missingOptional);
    else log('WARNING: Homebrew not found — skipping optional installs.');
  } else if (missingOptional.length > 0) {
    log(
      `optional tools not installed: ${missingOptional.map((e) => e.formula).join(', ')} ` +
        '(install later with "npm run bootstrap -- --install --with-optional" or brew).',
    );
  }

  if (!hasBin('libreoffice')) {
    log('note: libreoffice absent — .docx/.xlsx fall back to textutil (fine for most files). Optional: brew install --cask libreoffice');
  }
}

buildVisionHelper();
verifyAndInstallTools();
log('done.');
