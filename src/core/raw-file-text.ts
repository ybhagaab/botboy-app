/**
 * Raw file bytes posing as text.
 *
 * macOS `textutil` cannot read PDFs: asked to convert one, it echoes the
 * file's bytes as "text". Until 2026-10-05 it was the last PDF fallback, so a
 * Mac without the vision-ocr helper and poppler (no Xcode Command Line Tools)
 * stored every PDF as its raw bytes, and routing and briefs read them. The
 * owner's July–August 2026 PDF captures are such rows.
 *
 * Shared by the extractor (never store these bytes as a document's text) and
 * the long-document lane (never read a stored row like this in parts).
 */

/** Share of control characters (other than tab, line breaks, and form feed) that marks file bytes. */
const RAW_CONTROL_SHARE = 0.01;
const RAW_SAMPLE_CHARS = 65_536;

/** Text that begins like a PDF file: what textutil's echo of a PDF stored. */
export function isPdfBytes(text: string): boolean {
  return text.slice(0, 64).trimStart().startsWith('%PDF-');
}

/**
 * Text that is a file's raw bytes: a PDF header, or control characters in
 * more than 1% of the first 64K characters (zip, Office, and other binary
 * formats). Apply it to binary formats only: a plain-text file may
 * legitimately carry control characters (terminal colour codes, for one).
 */
export function isRawFileText(text: string): boolean {
  if (isPdfBytes(text)) return true;
  const sample = Math.min(text.length, RAW_SAMPLE_CHARS);
  let control = 0;
  for (let index = 0; index < sample; index++) {
    const code = text.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13) control++;
  }
  return control > sample * RAW_CONTROL_SHARE;
}
