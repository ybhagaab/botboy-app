import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  FORM_FIELDS_READER,
  HTML_FIELD_REDACTION_SNIPPET,
  fieldsFingerprint,
  parseFieldsAnswer,
  renderFieldLines,
  renderFieldsSection,
  sanitizeFields,
  summarizeForm,
  type FormField,
} from './form-fields.js';

/** A jsdom page with layout stubbed: every element has a box unless marked `data-zero`. */
function makePage(html: string): JSDOM {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: 'outside-only' });
  stubLayout(dom.window);
  return dom;
}
function stubLayout(win: any): void {
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    const zero = this.hasAttribute('data-zero');
    return { x: 0, y: 0, left: 0, top: 0, width: zero ? 0 : 100, height: zero ? 0 : 20, right: 0, bottom: 0 };
  };
}
function read(dom: JSDOM): { raw: string; fields: FormField[] } {
  const raw = dom.window.eval(FORM_FIELDS_READER) as string;
  return { raw, fields: parseFieldsAnswer(raw)?.fields ?? [] };
}
function byLabel(fields: FormField[], label: string): FormField {
  const found = fields.find(f => f.label === label);
  if (!found) throw new Error(`no field ${label}: ${fields.map(f => f.label).join(' | ')}`);
  return found;
}
const PASSWORD = 'Hunter2-Very-Secret';

describe('form field reader (in page)', () => {
  it('labels fields by every rule, in order', () => {
    const dom = makePage(`<input name="nickname_field">
      <span id="lb1">Given</span><span id="lb2">name</span><input aria-labelledby="lb1 lb2">
      <input aria-label="Family name">
      <label for="e">Email address</label><input id="e" type="email">
      <label>Phone <input name="tel_in" type="tel"></label>
      <input title="Postal code">
      <input placeholder="City">
      <fieldset><legend>Newsletter</legend><input type="checkbox" name="nl"></fieldset>
      <div><span>Religion</span><input name="rel"></div>
    `);
    const labels = read(dom).fields.map(f => f.label);
    expect(labels).toEqual(['nickname_field', 'Given name', 'Family name', 'Email address', 'Phone', 'Postal code', 'City', 'Newsletter', 'Religion']);
  });

  it('reads values for every kind, and collapses radio groups', () => {
    const dom = makePage(`
      <label for="t">Full name</label><input id="t">
      <label for="ta">Notes</label><textarea id="ta"></textarea>
      <label for="s">Dialect</label><select id="s"><option value="">Choose</option><option value="pa">Punjabi</option></select>
      <label for="m">Languages</label><select id="m" multiple><option selected>English</option><option>Tamil</option><option selected>Malay</option></select>
      <label><input type="checkbox" id="c"> Same as above</label>
      <fieldset><legend>Marital status</legend>
        <label><input type="radio" name="ms" value="s"> Single</label>
        <label><input type="radio" name="ms" value="m" id="married"> Married</label>
      </fieldset>
      <div contenteditable="true" aria-label="Comment">Looks good</div>
      <div role="combobox" aria-label="Country">Singapore</div>
      <div role="switch" aria-label="Dark mode" aria-checked="true"></div>
      <input aria-label="Due" type="date" value="2026-10-10" required>
      <label for="un">Region</label><select id="un" required><option value="">Choose…</option><option value="n">North</option></select>
    `);
    const doc = dom.window.document;
    (doc.getElementById('t') as any).value = 'Abhilash Bhagat';
    (doc.getElementById('ta') as any).value = 'Line one';
    (doc.getElementById('s') as any).value = 'pa';
    (doc.getElementById('c') as any).checked = true;
    (doc.getElementById('married') as any).checked = true;
    const { fields } = read(dom);
    expect(byLabel(fields, 'Full name')).toMatchObject({ kind: 'textbox', value: 'Abhilash Bhagat', filled: true });
    expect(byLabel(fields, 'Notes').value).toBe('Line one');
    expect(byLabel(fields, 'Dialect')).toMatchObject({ kind: 'combobox', value: 'Punjabi', options: ['Choose', 'Punjabi'] });
    expect(byLabel(fields, 'Languages')).toMatchObject({ kind: 'listbox', value: ['English', 'Malay'] });
    expect(byLabel(fields, 'Same as above')).toMatchObject({ kind: 'checkbox', checked: true });
    expect(byLabel(fields, 'Marital status')).toMatchObject({ kind: 'radio-group', value: 'Married', options: ['Single', 'Married'] });
    expect(byLabel(fields, 'Marital status').optionPaths).toHaveLength(2);
    expect(byLabel(fields, 'Comment')).toMatchObject({ kind: 'textbox', value: 'Looks good' });
    expect(byLabel(fields, 'Country')).toMatchObject({ kind: 'combobox', value: 'Singapore' });
    expect(byLabel(fields, 'Dark mode')).toMatchObject({ kind: 'switch', checked: true });
    expect(byLabel(fields, 'Due')).toMatchObject({ type: 'date', value: '2026-10-10', required: true });
    // A placeholder option (value "") selected means nothing is chosen yet.
    expect(byLabel(fields, 'Region')).toMatchObject({ value: '', filled: false, required: true });
  });

  it('withholds secrets structurally and never puts their value in the output', () => {
    const dom = makePage(`
      <label for="pw">Password</label><input id="pw" type="password">
      <input aria-label="Your entry" type="password" id="tp">
      <input aria-label="Login" autocomplete="current-password" id="a1">
      <input aria-label="Choose" autocomplete="new-password" id="a2">
      <input aria-label="Code we sent" autocomplete="one-time-code" id="a3">
      <input aria-label="Number" autocomplete="cc-number" id="a4">
      <input aria-label="Verification" name="otp" id="a5">
      <label for="cv">CVV</label><input id="cv">
      <label for="cn">Card number</label><input id="cn">
      <input aria-label="Identity" id="ssn">
      <input aria-label="Blank secret" name="userPassword" id="a6">
      <label for="ok">City</label><input id="ok">
    `);
    const doc = dom.window.document;
    for (const id of ['pw', 'tp', 'a1', 'a2', 'a3', 'a4', 'a5', 'cv', 'cn', 'ssn']) (doc.getElementById(id) as any).value = PASSWORD;
    (doc.getElementById('ok') as any).value = 'Singapore';
    const { raw, fields } = read(dom);
    expect(raw).not.toContain(PASSWORD);
    const withheld = fields.filter(f => f.withheld).map(f => f.label);
    expect(withheld).toEqual(['Password', 'Your entry', 'Login', 'Choose', 'Code we sent', 'Number', 'Verification', 'CVV', 'Card number', 'Identity', 'Blank secret']);
    expect(byLabel(fields, 'Password')).toMatchObject({ withheld: true, filled: true });
    expect(byLabel(fields, 'Blank secret')).toMatchObject({ withheld: true, filled: false });
    expect(byLabel(fields, 'City').value).toBe('Singapore');
  });

  it('withholds masked (-webkit-text-security) fields', () => {
    const dom = makePage('<input aria-label="Masked code" id="mk"><input aria-label="Plain" id="pl">');
    const win = dom.window as any;
    const original = win.getComputedStyle.bind(win);
    win.getComputedStyle = (el: any) => {
      const style = original(el);
      if (el.id !== 'mk') return style;
      return new Proxy(style, { get: (t, k) => (k === 'getPropertyValue' ? (name: string) => (name === '-webkit-text-security' ? 'disc' : t.getPropertyValue(name)) : t[k]) });
    };
    (dom.window.document.getElementById('mk') as any).value = 'abc';
    const { raw, fields } = read(dom);
    expect(raw).not.toContain('abc');
    expect(byLabel(fields, 'Masked code')).toMatchObject({ withheld: true, masked: true });
    expect(byLabel(fields, 'Plain').withheld).toBeUndefined();
  });

  it('skips hidden inputs and invisible controls', () => {
    const dom = makePage(`
      <input type="hidden" name="_csrf" value="abc123">
      <input aria-label="Gone" style="display:none">
      <div hidden><input aria-label="Hidden parent"></div>
      <input aria-label="Zero" data-zero>
      <input type="submit" value="Send">
      <input aria-label="Shown">
    `);
    const { raw, fields } = read(dom);
    expect(fields.map(f => f.label)).toEqual(['Shown']);
    expect(raw).not.toContain('abc123');
  });

  it('finds fields inside open shadow roots and same-origin iframes, with deep paths', () => {
    const dom = makePage('<div id="host"></div><iframe id="fr"></iframe>');
    const doc = dom.window.document;
    const shadow = doc.getElementById('host')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<label for="sh">Shadow field</label><input id="sh">';
    (shadow.getElementById('sh') as any).value = 'inside shadow';
    const frame = doc.getElementById('fr') as any;
    const fdoc = frame.contentDocument;
    fdoc.body.innerHTML = '<label for="fi">Frame field</label><input id="fi">';
    stubLayout(frame.contentWindow);
    fdoc.getElementById('fi').value = 'inside frame';
    const { fields } = read(dom);
    expect(byLabel(fields, 'Shadow field')).toMatchObject({ value: 'inside shadow', path: '#host >>> #sh' });
    expect(byLabel(fields, 'Frame field')).toMatchObject({ value: 'inside frame', path: 'frame:0 >>> #fi' });
  });
});

describe('sanitizeFields (Node-side format withholding)', () => {
  it('withholds values that match secret formats', () => {
    const fields = sanitizeFields([
      // Split so secret scanners never see a whole token in the source.
      { kind: 'textbox', label: 'Key id', value: 'AKIA' + 'Q3EGTRSXK7PLMN4Z ' + 'wJalrXUtnFEMIK7MDENG' + 'bPxRfiCYzqW93kLmTt8x', path: '#a' },
      { kind: 'textbox', label: 'Notes', value: 'token ' + 'ghp_' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789', path: '#b' },
      { kind: 'textbox', label: 'City', value: 'Singapore', path: '#c' },
      { kind: 'nonsense', label: 'x', path: '#d' },
      { kind: 'textbox', label: 42, path: '#e' },
    ]);
    expect(fields.map(f => [f.label, f.withheld ?? false, f.value])).toEqual([
      ['Key id', true, undefined],
      ['Notes', true, undefined],
      ['City', false, 'Singapore'],
    ]);
  });

  it('redacts secret assignments in rendered output', () => {
    const fields = sanitizeFields([{ kind: 'textbox', label: 'Config', value: 'password=CorrectHorse99', path: '#a' }]);
    const section = renderFieldsSection(fields);
    expect(section).not.toContain('CorrectHorse99');
    expect(renderFieldLines(fields, ['r1']).join('\n')).not.toContain('CorrectHorse99');
  });
});

describe('field rendering', () => {
  const fields = sanitizeFields([
    { kind: 'textbox', label: 'Full name', value: 'Abhilash Bhagat', required: true, path: '#a' },
    { kind: 'textbox', label: 'Password', withheld: true, filled: true, path: '#b' },
    { kind: 'textbox', label: 'Postal code', value: '', required: true, path: '#c' },
    { kind: 'combobox', label: 'Dialect', value: 'Punjabi', path: '#d' },
    { kind: 'checkbox', label: 'Same as above', checked: true, path: '#e' },
    { kind: 'radio-group', label: 'Marital status', value: 'Married', options: ['Single', 'Married', 'Divorced'], path: '#f' },
  ]);
  const refs = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];

  it('renders compact per-field lines and a summary naming empty required fields', () => {
    expect(summarizeForm(fields, refs)).toBe('Form: 6 fields, 5 filled, 1 empty (required empty: r3 "Postal code")');
    expect(renderFieldLines(fields, refs)).toEqual([
      'r1 textbox "Full name" value="Abhilash Bhagat" required',
      'r2 textbox "Password" [withheld] filled',
      'r3 textbox "Postal code" empty required',
      'r4 combobox "Dialect" selected="Punjabi"',
      'r5 checkbox "Same as above" checked',
      'r6 radio-group "Marital status" selected="Married" options=[Single, Married, Divorced]',
    ]);
  });

  it('renders the monitor Fields section', () => {
    expect(renderFieldsSection(fields)).toBe([
      '--- Fields (6) ---',
      'Full name: Abhilash Bhagat [required]',
      'Password: [withheld]',
      'Postal code: (empty) [required]',
      'Dialect: Punjabi',
      'Same as above: ☑',
      'Marital status: Married (options: Single, Married, Divorced)',
    ].join('\n'));
    expect(renderFieldsSection([])).toBe('');
  });

  it('fingerprints values but only the filled state of withheld fields', () => {
    const base = fieldsFingerprint(fields);
    expect(fieldsFingerprint(sanitizeFields(fields.map(f => ({ ...f }))))).toBe(base);
    const edited = fields.map(f => (f.label === 'Dialect' ? { ...f, value: 'Hindi' } : f));
    expect(fieldsFingerprint(edited)).not.toBe(base);
    // A different password of the same filled state is not a change.
    expect(fieldsFingerprint(fields.map(f => ({ ...f })))).toBe(base);
    const emptied = fields.map(f => (f.label === 'Password' ? { ...f, filled: false } : f));
    expect(fieldsFingerprint(emptied)).not.toBe(base);
  });
});

describe('HTML redaction (in page)', () => {
  it('removes every hidden input value and withheld control text from serialized HTML', () => {
    const dom = makePage(`
      <form><input type="hidden" name="_csrf" value="abc123csrf"><input type="hidden" name="SAMLResponse" value="PHNhbWw+samlvalue">
      <input type="hidden" name="plain" value="hiddenplain">
      <label for="pw">Password</label><input id="pw" type="password" value="${PASSWORD}">
      <label for="sec">Secret notes</label><textarea id="sec">${PASSWORD} in a textarea</textarea>
      <label for="c">City</label><input id="c" value="Singapore"></form>
    `);
    const html = dom.window.eval(`(function(){${HTML_FIELD_REDACTION_SNIPPET} return botboyRedactedHtml(document.documentElement); })()`) as string;
    for (const leaked of ['abc123csrf', 'samlvalue', 'hiddenplain', PASSWORD]) expect(html).not.toContain(leaked);
    expect(html).toContain('value="[withheld]"');
    expect(html).toContain('Singapore');
    // The live page is untouched.
    expect((dom.window.document.querySelector('[name=_csrf]') as any).value).toBe('abc123csrf');
  });
});
