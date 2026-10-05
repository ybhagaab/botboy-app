#!/usr/bin/env node
/**
 * pdf-text — read a PDF's text layer with pdf.js and print one JSON line:
 * `{"text": "...", "pages": N, "pagesRead": M}` or `{"error": "..."}`.
 *
 * BotBoy's PDF reader that every install has: pdf.js (pdfjs-dist) is a pinned
 * npm dependency, so it needs no Xcode Command Line Tools or Homebrew. The
 * vision-ocr helper and poppler's pdftotext, when present, still read first
 * (`document-parser.ts › parsePdfAsync`). It runs as its own process, so a
 * large or hostile PDF can never block the server's event loop, and the
 * parser's timeout kills it.
 *
 * Usage: node scripts/pdf-text.mjs <file.pdf> [maxPages]
 */
import { readFile } from 'node:fs/promises';

function reply(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** pdf.js text items in reading order, one line per end-of-line mark. */
function pageText(items) {
  let text = '';
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    text += item.str;
    if (item.hasEOL) text += '\n';
  }
  return text.replace(/[ \t]+\n/g, '\n').trim();
}

async function main() {
  const [filePath, maxPagesArg] = process.argv.slice(2);
  if (!filePath) return reply({ error: 'usage: pdf-text.mjs <file.pdf> [maxPages]' });
  let pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch {
    return reply({ error: 'pdf.js is not installed (run npm install in the BotBoy folder)' });
  }
  const data = new Uint8Array(await readFile(filePath));
  // No eval (font programs never compile to JS), no font loading, no network.
  const task = pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  let doc;
  try {
    doc = await task.promise;
  } catch (error) {
    if (error?.name === 'PasswordException') return reply({ error: 'password required to open this PDF' });
    return reply({ error: `pdf.js could not open the file: ${String(error?.message ?? error).slice(0, 160)}` });
  }
  const maxPages = Number(maxPagesArg) > 0 ? Math.floor(Number(maxPagesArg)) : doc.numPages;
  const pagesRead = Math.min(doc.numPages, maxPages);
  const parts = [];
  for (let number = 1; number <= pagesRead; number++) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    const text = pageText(content.items);
    if (text) parts.push(text);
    page.cleanup();
  }
  await doc.destroy();
  reply({ text: parts.join('\n\n'), pages: doc.numPages, pagesRead });
}

main().catch((error) => {
  reply({ error: `pdf.js failed: ${String(error?.message ?? error).slice(0, 160)}` });
});
