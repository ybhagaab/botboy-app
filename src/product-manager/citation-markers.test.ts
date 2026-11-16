import { describe, expect, it } from 'vitest';
import { exportableContent, withoutCitationMarkers } from './citation-markers.js';

/**
 * Citation markers stay in BotBoy (owner request 2026-11-16: "[c1] etc. in exported version become noise"). Removed are
 * exactly the markers the reader draws as chips (dashboard.js › annotateDocumentCitations): a cited id, outside code, never
 * a link.
 */
const strip = (text: string, ids = ['c1', 'c2', 'c3']) => withoutCitationMarkers(text, ids);

describe('withoutCitationMarkers', () => {
  it('removes a marker with the space before it, before punctuation and at a line end', () => {
    expect(strip('Revenue rose 12% [c1].')).toBe('Revenue rose 12%.');
    expect(strip('Revenue rose 12%[c1], while costs fell [c2]')).toBe('Revenue rose 12%, while costs fell');
    expect(strip('Partner events now arrive from our servers. [c1]')).toBe('Partner events now arrive from our servers.');
    expect(strip('(see the thread [c1])')).toBe('(see the thread)');
    expect(strip('*a key claim [c1]*')).toBe('*a key claim*');
    expect(strip('A line [c1]\r\nnext')).toBe('A line\r\nnext');
  });

  it('removes a run of markers at once, and keeps the words on either side apart', () => {
    expect(strip('Usage doubled [c1][c2].')).toBe('Usage doubled.');
    expect(strip('Usage doubled [c1] [c2] [c3] in May.')).toBe('Usage doubled in May.');
    expect(strip('Usage rose [c1] while costs fell.')).toBe('Usage rose while costs fell.');
    expect(strip('word[c1]word')).toBe('word word');
  });

  it('keeps line starts, indentation, list markers and table cells intact', () => {
    expect(strip('[c1] The point stands.')).toBe('The point stands.');
    expect(strip('- [c1] first item\n  [c2] continued')).toBe('- first item\n  continued');
    expect(strip('| Paid marketing | Aditya Singhal | Campaigns [c2] |')).toBe('| Paid marketing | Aditya Singhal | Campaigns |');
    expect(strip('| 12% [c1] | 9% |')).toBe('| 12% | 9% |');
  });

  it('leaves code, links, link definitions and markers without a citation alone', () => {
    const fenced = ['Before [c1].', '```js', 'const x = cells[c1]; // [c2]', '```', 'After [c2].'].join('\n');
    expect(strip(fenced)).toBe(['Before.', '```js', 'const x = cells[c1]; // [c2]', '```', 'After.'].join('\n'));
    expect(strip('~~~~\n[c1]\n~~~\nstill code [c1]\n~~~~\nout [c1].')).toBe('~~~~\n[c1]\n~~~\nstill code [c1]\n~~~~\nout.');
    expect(strip('Use `grid[c1]` here [c2].')).toBe('Use `grid[c1]` here.');
    expect(strip('see [c1] `code` and [c2]')).toBe('see `code` and');
    expect(strip('An unclosed ` tick [c1].')).toBe('An unclosed ` tick.');
    expect(strip('Read [c1](https://example.com/c1) now.')).toBe('Read [c1](https://example.com/c1) now.');
    expect(strip('![c1](media/c1.png)')).toBe('![c1](media/c1.png)');
    expect(strip('[c1]: https://example.com')).toBe('[c1]: https://example.com');
    expect(strip('Shown as text [c9].')).toBe('Shown as text [c9].');
    expect(strip('A note [c10].')).toBe('A note [c10].'); // c1 is not a prefix match
  });

  it('works for any id the document cites, and with no citations changes nothing', () => {
    expect(withoutCitationMarkers('Seen in the PRD [prd-2] and the email [e.1].', ['prd-2', 'e.1'])).toBe('Seen in the PRD and the email.');
    expect(withoutCitationMarkers('Keep [c1] as written.', [])).toBe('Keep [c1] as written.');
    expect(withoutCitationMarkers('Empty [] brackets and a checkbox - [ ] stay.', ['', '  '])).toBe('Empty [] brackets and a checkbox - [ ] stay.');
    expect(exportableContent({ content: 'Keep [c1] as written.' })).toBe('Keep [c1] as written.');
    expect(exportableContent({ content: 'Cited [c1].', citations: [{ id: 'c1' }] })).toBe('Cited.');
    expect(exportableContent({ content: 'Cited [c1].', citations: null })).toBe('Cited [c1].');
  });

  it('pictures and diagrams pass through unchanged', () => {
    const doc = ['# Plan', '', '![Funnel [c1]](media/funnel.png)', '', '```mermaid', 'graph LR; A[c1]-->B', '```', '', 'Done [c1].'].join('\n');
    expect(strip(doc)).toBe(['# Plan', '', '![Funnel](media/funnel.png)', '', '```mermaid', 'graph LR; A[c1]-->B', '```', '', 'Done.'].join('\n'));
  });
});
