/*
 * Themes in the browser (docs/maps/ui-themes.md): applies the theme the server derived, previews a proposal before it is kept,
 * remembers the shipped light/dark choice, and renders the theme card and the Appearance rows.
 *
 * A classic script loaded before app.js and dashboard.js, exposing one global, window.BotBoyTheme. A theme here is
 * { id, mode, tokens }: `tokens` is the server's closed set of colour tokens and NOTHING else is ever applied. Names are checked
 * against TOKEN_NAMES and every value against a strict format before a single property is set, and a theme that fails either
 * check is refused whole, so a tampered or malformed response cannot put CSS on the page. Applying sets custom properties as
 * inline style on <html> (an inline style beats the stylesheet's :root and :root[data-theme="light"] blocks); clearing removes
 * exactly the properties this script set. The pure renderers return HTML strings from escaped text and validated colours only.
 *
 * Preview is in memory: a reload, or Revert, puts the page back. Nothing is saved until the owner presses Keep, which is a
 * server request made by app.js.
 */
(function () {
  const TOKEN_NAMES = [
    'bg', 'bg-raised', 'surface', 'surface-2', 'hover', 'border', 'border-strong', 'text', 'soft', 'muted', 'faint',
    'accent', 'accent-strong', 'accent-soft', 'green', 'green-soft', 'yellow', 'yellow-soft', 'red', 'red-soft', 'blue', 'blue-soft',
    'accent-rgb', 'accent-fill-top', 'accent-fill-bottom', 'accent-fill-edge', 'ring-yellow',
  ];
  const RGBA_NAMES = new Set(['border', 'border-strong', 'accent-soft', 'green-soft', 'yellow-soft', 'red-soft', 'blue-soft']);
  const HEX = /^#[0-9a-f]{6}$/;
  const RGBA = /^rgba\((\d{1,3}),(\d{1,3}),(\d{1,3}),(0|1|0?\.\d{1,3})\)$/;
  const TRIPLET = /^(\d{1,3}),(\d{1,3}),(\d{1,3})$/;
  const THEME_ID = /^th_[0-9a-f]{12}$/;
  const STORAGE_KEY = 'botboy-theme';
  const SHIPPED_BG = { dark: '#09090b', light: '#f4f4f6' };

  const root = document.documentElement;
  let applied = false;
  let preview = null;

  function validValue(name, value) {
    if (typeof value !== 'string') return false;
    if (RGBA_NAMES.has(name)) {
      const match = RGBA.exec(value);
      return Boolean(match) && Number(match[1]) <= 255 && Number(match[2]) <= 255 && Number(match[3]) <= 255;
    }
    if (name === 'accent-rgb') {
      const match = TRIPLET.exec(value);
      return Boolean(match) && Number(match[1]) <= 255 && Number(match[2]) <= 255 && Number(match[3]) <= 255;
    }
    return HEX.test(value);
  }
  /** A complete token map: exactly the allowlisted names, each with a valid value. */
  function validTokens(tokens) {
    if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return false;
    const keys = Object.keys(tokens);
    if (keys.length !== TOKEN_NAMES.length) return false;
    return TOKEN_NAMES.every((name) => validValue(name, tokens[name]));
  }
  function validTheme(theme) {
    return Boolean(theme) && (theme.mode === 'dark' || theme.mode === 'light') && THEME_ID.test(String(theme.id)) && validTokens(theme.tokens);
  }

  function metaColor(color) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && HEX.test(color)) meta.setAttribute('content', color);
  }
  function emit(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* an old browser keeps working without the event */ }
  }
  function currentMode() {
    return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }
  /** The topbar button shows the sun while the page is dark (press for light) and the moon while it is light. */
  function syncControls() {
    const href = currentMode() === 'dark' ? '#i-sun' : '#i-moon';
    for (const use of document.querySelectorAll('[data-action="toggle-theme"] use')) use.setAttribute('href', href);
  }
  function clearTokens() {
    if (!applied) return;
    for (const name of TOKEN_NAMES) root.style.removeProperty(`--${name}`);
    applied = false;
  }
  function paintTokens(tokens) {
    for (const name of TOKEN_NAMES) root.style.setProperty(`--${name}`, tokens[name]);
    applied = true;
  }

  function doApply(theme) {
    paintTokens(theme.tokens);
    root.setAttribute('data-theme', theme.mode);
    root.setAttribute('data-botboy-choice', theme.id);
    metaColor(theme.tokens.bg);
    syncControls();
    emit('botboy:theme-changed', { id: theme.id, mode: theme.mode, builtin: false });
    return true;
  }
  function doBuiltin(mode) {
    clearTokens();
    root.setAttribute('data-theme', mode);
    root.setAttribute('data-botboy-choice', `builtin:${mode}`);
    metaColor(SHIPPED_BG[mode]);
    syncControls();
    emit('botboy:theme-changed', { id: `builtin:${mode}`, mode, builtin: true });
    return true;
  }

  /** Makes a saved theme the one on screen. Refused whole if anything in it is off the allowlist. While a preview is up it waits. */
  function apply(theme) {
    if (!validTheme(theme)) return false;
    if (preview) { preview.deferred = () => doApply(theme); return true; }
    return doApply(theme);
  }
  /** Shows one of the shipped palettes (and remembers it in this browser unless `persist` is false). */
  function setBuiltin(mode, options) {
    if (mode !== 'dark' && mode !== 'light') return false;
    if (!options || options.persist !== false) {
      try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* a locked-down browser just loses the fallback */ }
    }
    if (preview) { preview.deferred = () => doBuiltin(mode); return true; }
    return doBuiltin(mode);
  }
  /**
   * Shows what the server holds (GET /ui-theme): a saved theme with its tokens, or one of the shipped palettes. A server that has
   * never been asked (`active` null) changes nothing, so the page keeps the light/dark choice this browser remembers.
   */
  function applyView(view) {
    if (!view || view.active === null || view.active === undefined) return false;
    const chosen = view.activeTheme;
    if (!chosen) return false;
    if (!chosen.builtin && view.activeTokens) return apply({ id: chosen.id, mode: chosen.mode, tokens: view.activeTokens });
    return setBuiltin(chosen.mode);
  }
  function current() {
    return { id: root.getAttribute('data-botboy-choice') || `builtin:${currentMode()}`, mode: currentMode(), custom: applied };
  }

  // ── Preview ────────────────────────────────────────────────────────────────────────────────────────────────────

  function snapshot() {
    const meta = document.querySelector('meta[name="theme-color"]');
    return {
      style: root.getAttribute('style'), mode: root.getAttribute('data-theme'), choice: root.getAttribute('data-botboy-choice'),
      applied, meta: meta ? meta.getAttribute('content') : null,
    };
  }
  function restore(before) {
    if (before.style === null) root.removeAttribute('style'); else root.setAttribute('style', before.style);
    if (before.mode === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', before.mode);
    if (before.choice === null) root.removeAttribute('data-botboy-choice'); else root.setAttribute('data-botboy-choice', before.choice);
    applied = before.applied;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && before.meta !== null) meta.setAttribute('content', before.meta);
    syncControls();
  }

  function button(label, className, onClick) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.textContent = label;
    element.addEventListener('click', onClick);
    return element;
  }
  /** The bar keeps its own colours (see .theme-preview-bar in dashboard.css): a preview must never make its own controls unreadable. */
  function showBar(name, hooks) {
    removeBar();
    const bar = document.createElement('div');
    bar.className = 'theme-preview-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Theme preview');
    const text = document.createElement('span');
    text.className = 'theme-preview-text';
    text.setAttribute('aria-live', 'polite');
    text.textContent = `Previewing ${name}. Nothing is saved until you keep it.`;
    bar.append(text);
    if (hooks && typeof hooks.onKeep === 'function') bar.append(button('Keep', 'theme-preview-keep', () => hooks.onKeep()));
    bar.append(button('Revert', 'theme-preview-revert', () => endPreview(true)));
    document.body.append(bar);
    return bar;
  }
  function removeBar() {
    for (const bar of document.querySelectorAll('.theme-preview-bar')) bar.remove();
  }

  /** Shows `theme` on the page without saving it. `hooks.onKeep` is what the bar's Keep button does. */
  function startPreview(theme, name, hooks) {
    if (!validTheme(theme)) return false;
    if (!preview) preview = { before: snapshot(), deferred: null, id: theme.id };
    preview.id = theme.id;
    paintTokens(theme.tokens);
    root.setAttribute('data-theme', theme.mode);
    root.setAttribute('data-botboy-choice', theme.id);
    metaColor(theme.tokens.bg);
    syncControls();
    showBar(String(name || 'this theme').slice(0, 40), hooks);
    emit('botboy:theme-preview', { id: theme.id, active: true });
    return true;
  }
  /** Ends the preview. `revert` puts the page back (or on whatever became the saved theme while it was up). */
  function endPreview(revert) {
    if (!preview) return false;
    const done = preview;
    preview = null;
    removeBar();
    if (revert !== false) {
      if (done.deferred) done.deferred(); else restore(done.before);
    }
    emit('botboy:theme-preview', { id: done.id, active: false });
    return true;
  }
  function previewing() {
    return preview ? preview.id : null;
  }

  // ── Renderers (pure: escaped text and validated colours in, HTML out) ─────────────────────────────────────────

  function swatchHtml(colors) {
    const dots = (Array.isArray(colors) ? colors : []).filter((color) => HEX.test(color)).slice(0, 5)
      .map((color) => `<i style="background:${color}"></i>`).join('');
    return `<span class="theme-swatch" aria-hidden="true">${dots}</span>`;
  }
  const modeLabel = (mode) => (mode === 'light' ? 'Light' : 'Dark');
  function shortDate(iso) {
    const time = Date.parse(iso || '');
    return Number.isNaN(time) ? '' : new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  /** The chat card for a proposal (and for the theme it became). `helpers` = { esc, attr }; `options` = { previewing, notice }. */
  function cardHtml(proposal, helpers, options) {
    const { esc, attr } = helpers;
    const opts = options || {};
    const p = proposal || {};
    const notice = opts.notice ? `<div class="theme-card-note" role="alert">${esc(opts.notice)}</div>` : '';
    const head = `<div class="theme-card-head"><span class="theme-card-kind">Theme</span>${swatchHtml(p.swatch)}</div>`;
    const title = `<div class="theme-card-title">${esc(p.name)}</div><div class="theme-card-meta">${modeLabel(p.mode)} · accent ${esc(p.accent)}${p.background ? ` · background ${esc(p.background)}` : ''}</div>`;
    if (p.status === 'pending') {
      const checks = Array.isArray(p.checks) ? p.checks : [];
      const passed = checks.filter((check) => check.ok).length;
      const proof = checks.length
        ? `<div class="theme-card-proof">${passed === checks.length ? `Readable: all ${checks.length} text and contrast checks pass.` : `${passed} of ${checks.length} text checks pass.`}</div>`
        : '';
      const adjustments = (Array.isArray(p.adjustments) ? p.adjustments : [])
        .map((adj) => `<div class="theme-card-note">${adj.token === 'accent' ? 'Accent' : 'Background'} moved from ${esc(adj.from)} to ${esc(adj.to)}. ${esc(adj.reason)}</div>`).join('');
      const first = opts.previewing
        ? `<button type="button" class="button small" data-theme-card-action="stop-preview" aria-label="Stop previewing ${attr(p.name)}">Stop preview</button>`
        : `<button type="button" class="button small" data-theme-card-action="preview" aria-label="Preview ${attr(p.name)}">Preview</button>`;
      return `${head}${title}${proof}${adjustments}<div class="theme-card-hint">Preview shows it everywhere. Nothing is saved until you press Keep.</div>`
        + `<div class="theme-card-actions">${first}<button type="button" class="button small primary" data-theme-card-action="keep" aria-label="Keep ${attr(p.name)}">Keep</button><button type="button" class="button small ghost" data-theme-card-action="discard" aria-label="Discard ${attr(p.name)}">Discard</button></div>${notice}`;
    }
    if (p.status === 'kept') {
      const use = p.active ? '<span class="pill accent">In use</span>' : `<button type="button" class="button small" data-theme-card-action="apply" aria-label="Use ${attr(p.name)}">Use this theme</button>`;
      return `${head}${title}<div class="theme-card-state">Kept. ${p.active ? 'It is the theme in use now.' : 'Saved with your themes.'} <a href="#/settings/appearance">Settings → Appearance</a></div><div class="theme-card-actions">${use}</div>${notice}`;
    }
    if (p.status === 'discarded') return `${head}${title}<div class="theme-card-state">Discarded.</div>${notice}`;
    if (p.status === 'removed') return `${head}${title}<div class="theme-card-state">Kept, then deleted from Settings → Appearance.</div>${notice}`;
    return `<div class="theme-card-state">This theme proposal is no longer available. Ask BotBoy to make it again.</div>`;
  }

  /** One row of Settings → Appearance. `row` is a ThemeSummary; `ui` = { renaming, confirmingDelete, busy }. */
  function rowHtml(row, helpers, ui) {
    const { esc, attr } = helpers;
    const state = ui || {};
    const meta = row.builtin ? `${modeLabel(row.mode)} · shipped with BotBoy` : `${modeLabel(row.mode)} · made in chat${shortDate(row.createdAt) ? `, kept ${esc(shortDate(row.createdAt))}` : ''}`;
    const id = attr(row.id);
    const disabled = state.busy ? ' disabled' : '';
    let copy = `<span class="theme-row-copy"><strong>${esc(row.name)}</strong><span>${meta}</span></span>`;
    let actions;
    if (state.renaming === row.id) {
      copy = `<form class="theme-rename-form" data-theme-rename-form data-theme-id="${id}"><label class="visually-hidden" for="theme-rename-input">Theme name</label>`
        + `<input id="theme-rename-input" type="text" maxlength="40" value="${attr(row.name)}" autocomplete="off"${disabled}/>`
        + `<button class="button small primary" type="submit"${disabled}>Save</button><button class="button small ghost" type="button" data-action="theme-rename-cancel"${disabled}>Cancel</button></form>`;
      actions = '';
    } else if (state.confirmingDelete === row.id) {
      actions = `<span class="theme-row-actions"><span class="theme-confirm">Delete this theme?</span><button class="button small" type="button" data-action="theme-delete-confirm" data-theme-id="${id}" aria-label="Delete ${attr(row.name)}"${disabled}>Delete</button><button class="button small ghost" type="button" data-action="theme-delete-cancel"${disabled}>Cancel</button></span>`;
    } else {
      const use = row.active
        ? '<span class="pill accent">In use</span>'
        : `<button class="button small" type="button" data-action="theme-apply" data-theme-id="${id}" aria-label="Apply ${attr(row.name)}"${disabled}>Apply</button>`;
      const manage = row.builtin ? ''
        : `<button class="button small ghost" type="button" data-action="theme-rename" data-theme-id="${id}" aria-label="Rename ${attr(row.name)}"${disabled}>Rename</button><button class="button small ghost" type="button" data-action="theme-delete" data-theme-id="${id}" aria-label="Delete ${attr(row.name)}"${disabled}>Delete</button>`;
      actions = `<span class="theme-row-actions">${use}${manage}</span>`;
    }
    return `<li class="theme-row${row.active ? ' active' : ''}" data-theme-row="${id}">${swatchHtml(row.swatch)}${copy}${actions}</li>`;
  }

  window.BotBoyTheme = {
    TOKEN_NAMES, validTokens, validTheme, apply, applyView, setBuiltin, current, currentMode, syncControls,
    startPreview, endPreview, previewing, swatchHtml, cardHtml, rowHtml,
  };
})();
