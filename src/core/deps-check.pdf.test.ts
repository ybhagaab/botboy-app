/**
 * PDF parsing needs the vision-ocr helper, pdftotext, or BotBoy's own pdf.js
 * reader (installed by npm). textutil does not count: it echoes a PDF's
 * bytes, so a Mac with only textutil reported PDF parsing as available while
 * storing raw bytes (2026-10-05).
 */
const { present } = vi.hoisted(() => ({ present: new Set<string>() }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: (_bin: string, args: string[]) => {
      if (present.has(args[1])) return Buffer.from('/usr/bin/x');
      throw Object.assign(new Error('not found'), { status: 1 });
    },
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const controlled = (file: string): string | null => {
    if (file.endsWith('vision-ocr')) return 'vision-ocr';
    if (file.endsWith('pdfjs-dist/legacy/build/pdf.mjs') || file.endsWith('scripts/pdf-text.mjs')) return 'pdf.js';
    return null;
  };
  return { ...actual, existsSync: (file: string) => { const name = controlled(String(file)); return name ? present.has(name) : actual.existsSync(file); } };
});

const { checkDependencies } = await import('./deps-check.js');

describe('PDF parsing dependency', () => {
  beforeEach(() => present.clear());
  const pdfDep = () => checkDependencies().deps.find((dep) => dep.name.startsWith('pdf parsing'))!;

  it('is missing with only textutil, and says what to run', () => {
    present.add('textutil');
    expect(pdfDep().ok).toBe(false);
    expect(pdfDep().detail).toContain('run "npm install" in the BotBoy folder');
    expect(checkDependencies().message).toContain('pdf parsing');
  });

  it('is available with BotBoy\'s pdf.js reader alone, with pdftotext, or with the helper on macOS', () => {
    present.add('pdf.js');
    expect(pdfDep()).toMatchObject({ ok: true, detail: 'available (pdf.js)' });
    present.add('pdftotext');
    expect(pdfDep()).toMatchObject({ ok: true, detail: 'available (pdftotext)' });
    if (process.platform === 'darwin') {
      present.add('vision-ocr');
      expect(pdfDep()).toMatchObject({ ok: true, detail: 'available (native PDFKit helper)' });
    }
  });
});
