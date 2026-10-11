import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  READ_FORM_EXPRESSION,
  axInspectEntry,
  buildInspectExpression,
  fillResult,
  fillSummary,
  formBlock,
  resolveFillEntries,
  validateFillFields,
  withheldLengthExpression,
} from './browser-hands.js';
import { sanitizeFields, type FormField } from './form-fields.js';

const PASSWORD = 'Hunter2-Very-Secret';

function page(html: string): JSDOM {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: 'outside-only', url: 'https://forms.test/apply' });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, left: 0, top: 0, width: 100, height: 20, right: 100, bottom: 20 } as any;
  };
  (dom.window.HTMLElement.prototype as any).scrollIntoView = () => undefined;
  return dom;
}

const FORM = `
  <h1>Apply</h1>
  <label for="name">Full name</label><input id="name" required>
  <label for="pw">Password</label><input id="pw" type="password">
  <label for="postal">Postal code</label><input id="postal" required>
  <label for="dialect">Dialect</label><select id="dialect"><option value="">Choose</option><option value="pa">Punjabi</option></select>
  <label><input type="checkbox" id="same"> Same as above</label>
  <input type="hidden" name="_csrf" value="csrf-token-value">
  <button type="submit">Send</button>
  <input type="button" value="Reset form">
`;

function filledPage(): JSDOM {
  const dom = page(FORM);
  const doc = dom.window.document;
  (doc.getElementById('name') as any).value = 'Abhilash Bhagat';
  (doc.getElementById('pw') as any).value = PASSWORD;
  (doc.getElementById('dialect') as any).value = 'pa';
  (doc.getElementById('same') as any).checked = true;
  return dom;
}

describe('inspect (in page)', () => {
  it('lists form fields first with values, keeps values off elements, and redacts the HTML excerpt', () => {
    const dom = filledPage();
    const raw = dom.window.eval(buildInspectExpression(undefined, 80)) as string;
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain('csrf-token-value');
    const dom1 = JSON.parse(raw);
    const fields = sanitizeFields(dom1.fields);
    const form = formBlock(fields);
    expect(form.summary).toBe('Form: 5 fields, 4 filled, 1 empty (required empty: r3 "Postal code")');
    expect(form.lines).toEqual([
      'r1 textbox "Full name" value="Abhilash Bhagat" required',
      'r2 textbox "Password" [withheld] filled type=password',
      'r3 textbox "Postal code" empty required',
      'r4 combobox "Dialect" selected="Punjabi" options=[Choose, Punjabi]',
      'r5 checkbox "Same as above" checked',
    ]);
    expect(form.fields.every(field => !('path' in field))).toBe(true);
    // Field controls are not repeated as elements; buttons keep their text value.
    const elements = dom1.elements as any[];
    expect(elements.some(element => element.tag === 'input' && element.value !== 'Reset form')).toBe(false);
    expect(elements.find(element => element.value === 'Reset form')?.name).toBe('Reset form');
    expect(elements.every(element => element.name !== 'Abhilash Bhagat')).toBe(true);
    expect(dom1.htmlExcerpt).toContain('[withheld]');
  });

  it('read_form returns the same field list with a document token', () => {
    const parsed = JSON.parse(filledPage().window.eval(READ_FORM_EXPRESSION) as string);
    expect(parsed.documentToken).toContain('https://forms.test/apply');
    expect(sanitizeFields(parsed.fields).map(field => field.label)).toEqual(['Full name', 'Password', 'Postal code', 'Dialect', 'Same as above']);
  });

  it('withheld length check sends only the length and compares in the page', () => {
    const dom = filledPage();
    const expression = withheldLengthExpression('#pw', PASSWORD.length);
    expect(expression).toContain(String(PASSWORD.length));
    expect(expression).not.toContain(PASSWORD);
    expect(JSON.parse(dom.window.eval(expression) as string)).toEqual({ ok: true, shorter: false });
    expect(JSON.parse(dom.window.eval(withheldLengthExpression('#pw', PASSWORD.length + 4)) as string)).toEqual({ ok: false, shorter: true });
  });
});

describe('accessibility entries', () => {
  it('drops text-entry values and withholds password-like values', () => {
    expect(axInspectEntry({ role: { value: 'textbox' }, name: { value: 'Password' }, value: { value: '••••••' } }).value).toBe('[withheld]');
    expect(axInspectEntry({ role: { value: 'textbox' }, name: { value: 'Login' }, value: { value: PASSWORD }, properties: [{ name: 'protected', value: { value: true } }] }).value).toBe('[withheld]');
    expect(axInspectEntry({ role: { value: 'textbox' }, name: { value: 'Full name' }, value: { value: 'Abhilash' } }).value).toBe('');
    expect(axInspectEntry({ role: { value: 'slider' }, name: { value: 'Volume' }, value: { value: '40' } }).value).toBe('40');
    expect(axInspectEntry({ role: { value: 'StaticText' }, name: { value: 'Key' }, value: { value: 'ghp_' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789' } }).value).toBe('[withheld]');
  });
});

describe('fill', () => {
  const fields: FormField[] = sanitizeFields([
    { kind: 'textbox', label: 'Address line 1', value: '', path: '#a1', native: true },
    { kind: 'textbox', label: 'Address line 1 (mailing)', value: '', path: '#a2', native: true },
    { kind: 'textbox', label: 'Religion', value: '', path: '#rel', native: true, required: true },
    { kind: 'textbox', label: 'Password', withheld: true, filled: false, path: '#pw', native: true },
    { kind: 'combobox', label: 'Dialect', value: '', options: ['Choose', 'Punjabi'], path: '#d', native: true },
    { kind: 'checkbox', label: 'Same as above', checked: false, path: '#s', native: true },
    { kind: 'textbox', label: 'Phone', value: '', maxLength: 8, path: '#ph', native: true },
  ]);
  const refs = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];

  it('validates the fields argument and names the expected shape', () => {
    expect(() => validateFillFields(undefined)).toThrow(/non-empty fields array/);
    expect(() => validateFillFields([{ value: 'x' }])).toThrow(/exactly one of ref or label/);
    expect(() => validateFillFields([{ ref: 'r1', label: 'x', value: 'x' }])).toThrow(/exactly one of ref or label/);
    expect(() => validateFillFields([{ label: 'x', value: 5 }])).toThrow(/value must be text/);
    expect(() => validateFillFields(Array.from({ length: 41 }, () => ({ label: 'x', value: 'y' })))).toThrow(/at most 40/);
    expect(validateFillFields([{ label: ' Religion ', value: 'Christianity' }])).toEqual([{ label: 'Religion', value: 'Christianity' }]);
  });

  it('resolves labels exact, then case-insensitive, then contains; ambiguity and misses name candidates', () => {
    const resolved = resolveFillEntries([
      { label: 'Address line 1', value: 'x' },
      { label: 'religion', value: 'x' },
      { label: 'dial', value: 'x' },
      { label: 'address', value: 'x' },
      { label: 'Nationality', value: 'x' },
      { ref: 'r6', value: true },
      { ref: 'r99', value: 'x' },
    ], fields, refs);
    expect(resolved.map(item => item.index)).toEqual([0, 2, 4, undefined, undefined, 5, undefined]);
    expect(resolved[3].note).toBe('ambiguous: r1 "Address line 1", r2 "Address line 1 (mailing)"; pass ref');
    expect(resolved[4].note).toMatch(/^no field labelled "Nationality"; fields: r1 "Address line 1", /);
    expect(resolved[6].note).toMatch(/no field r99/);
  });

  it('builds receipts from the page read back after the fill', () => {
    const after = (patch: Partial<FormField>, index: number): FormField => ({ ...fields[index], ...patch });
    expect(fillResult('r3', fields[2], after({ value: 'Christianity', filled: true }, 2), { label: 'Religion', value: 'Christianity' }, {}))
      .toEqual({ ref: 'r3', label: 'Religion', requested: 'Christianity', actual: 'Christianity', ok: true });
    expect(fillResult('r5', fields[4], after({ value: 'Punjabi' }, 4), { label: 'Dialect', value: 'punjabi' }, { chosen: 'Punjabi' }))
      .toMatchObject({ requested: 'punjabi', actual: 'Punjabi', ok: true });
    expect(fillResult('r6', fields[5], after({ checked: true }, 5), { ref: 'r6', value: true }, {}))
      .toMatchObject({ requested: 'checked', actual: 'checked', ok: true });
    const secret = fillResult('r4', fields[3], after({ filled: true }, 3), { label: 'Password', value: PASSWORD }, {}, { ok: true, shorter: false });
    expect(secret).toEqual({ ref: 'r4', label: 'Password', requested: '[withheld]', actual: '[withheld]', ok: true });
    expect(JSON.stringify(secret)).not.toContain(PASSWORD);
    expect(fillResult('r4', fields[3], after({ filled: true }, 3), { label: 'Password', value: PASSWORD }, {}, { ok: false, shorter: true }))
      .toMatchObject({ ok: false, note: 'page shortened the value', requested: '[withheld]' });
    expect(fillResult('r7', fields[6], after({ value: '9123 4567' }, 6), { label: 'Phone', value: '91234567' }, {}))
      .toMatchObject({ ok: true, note: 'page formatted the value' });
    expect(fillResult('r7', fields[6], after({ value: '91234567' }, 6), { label: 'Phone', value: '9123456789' }, {}))
      .toMatchObject({ ok: false, note: 'page shortened the value' });
    expect(fillResult('r5', fields[4], after({}, 4), { label: 'Dialect', value: 'Klingon' }, { note: 'option not found: "Klingon"' }))
      .toMatchObject({ ok: false, note: 'option not found: "Klingon"' });
  });

  it('summarizes failures with refs', () => {
    expect(fillSummary([
      { ref: 'r1', label: 'A', requested: 'x', actual: 'x', ok: true },
      { ref: 'r9', label: 'Dialect', requested: 'x', actual: '', ok: false, note: 'option not found' },
    ])).toBe('1 of 2 fields set; 1 failed: r9 "Dialect" option not found');
  });
});
