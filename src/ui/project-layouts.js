(() => {
  'use strict';

  const API = '/api';
  const CACHE_TTL_MS = 15_000;
  const cache = new Map();
  const pending = new Map();
  const accents = new Set(['violet', 'blue', 'emerald', 'amber', 'rose']);
  const densities = new Set(['comfortable', 'compact']);

  const esc = value => String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
  const attr = esc;
  const number = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—';
  const icon = (name, size = 16) => `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const unique = values => [...new Set(values)];
  // Mirrors projectAskSeed in dashboard.js: this file is a classic script and
  // cannot import from that module, so the one-line seed is duplicated rather
  // than routed through a new global.
  const askSeed = (title, id) => `About project ${String(title ?? '').replace(/\s+/g, ' ').trim()} (${id}): `;

  function key(scopeType, scopeId) {
    return `${scopeType}:${scopeId}`;
  }

  function signature(layout) {
    return layout ? `${layout.template}:${layout.version}` : 'classic';
  }

  async function load(scopeType, scopeId, force = false) {
    const cacheKey = key(scopeType, scopeId);
    const current = cache.get(cacheKey);
    if (!force && current && Date.now() - current.loadedAt < CACHE_TTL_MS) return current.layout;
    if (pending.has(cacheKey)) return pending.get(cacheKey);

    const request = fetch(`${API}/page-layouts/${encodeURIComponent(scopeType)}/${encodeURIComponent(scopeId)}`, {
      headers: { Accept: 'application/json' },
    }).then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const layout = payload?.layout || null;
      const changed = !current || signature(current.layout) !== signature(layout);
      cache.set(cacheKey, { layout, loadedAt: Date.now() });
      if (changed || !current) {
        window.dispatchEvent(new CustomEvent('botboy:page-layout-ready', {
          detail: { scopeType, scopeId },
        }));
      }
      return layout;
    }).catch(error => {
      console.warn(`[BotBoyLayouts] Could not load ${cacheKey}: ${error.message}`);
      if (!current) cache.set(cacheKey, { layout: null, loadedAt: Date.now() });
      return current?.layout || null;
    }).finally(() => pending.delete(cacheKey));

    pending.set(cacheKey, request);
    return request;
  }

  function cachedLayout(scopeType, scopeId) {
    const cacheKey = key(scopeType, scopeId);
    const entry = cache.get(cacheKey);
    if (!entry) {
      void load(scopeType, scopeId);
      return null;
    }
    if (Date.now() - entry.loadedAt >= CACHE_TTL_MS) void load(scopeType, scopeId, true);
    return entry.layout;
  }

  function layoutClass(config) {
    const accent = accents.has(config?.accent) ? config.accent : 'violet';
    const density = densities.has(config?.density) ? config.density : 'comfortable';
    return `bb-native-layout layout-accent-${accent} layout-density-${density}`;
  }

  function statusTone(status) {
    const value = String(status || '').trim().toLowerCase();
    if (/done|complete|completed|shipped|launched|live/.test(value)) return 'good';
    if (/block|risk|at risk|stalled|late/.test(value)) return 'bad';
    if (/progress|active|building|develop|review|testing|flight/.test(value)) return 'accent';
    if (/pause|hold|waiting|pending/.test(value)) return 'warn';
    return 'neutral';
  }

  function statusLabel(status) {
    const value = String(status || 'Planned').trim();
    return value || 'Planned';
  }

  function safeHttps(value) {
    if (!value) return '';
    try {
      const url = new URL(String(value));
      return url.protocol === 'https:' ? url.toString() : '';
    } catch {
      return '';
    }
  }

  function roadmapLinks(item) {
    const links = [
      ['productDoc', 'file', 'Product doc'],
      ['design', 'sparkles', 'Design'],
      ['slack', 'message', 'Slack'],
    ].map(([keyName, iconName, label]) => {
      const url = safeHttps(item?.links?.[keyName]);
      return url
        ? `<a class="roadmap-link" href="${attr(url)}" target="_blank" rel="noopener noreferrer" title="Open ${attr(label)}">${icon(iconName, 12)}<span>${esc(label)}</span></a>`
        : '';
    }).filter(Boolean);
    return links.length ? `<div class="roadmap-links">${links.join('')}</div>` : '';
  }

  function projectTabs(project, brain, active = 'brief') {
    const tabs = [
      ['brief', 'Roadmap'],
      ['tasks', `Tasks ${Array.isArray(brain?.tasks) ? brain.tasks.length : 0}`],
      ['evidence', `Evidence ${Number(project?.itemCount || 0)}`],
      ['timeline', 'Timeline'],
    ];
    return `<div class="tabs native-layout-tabs" role="tablist" aria-label="Project sections">${tabs.map(([id, label]) => `<button class="tab ${active === id ? 'active' : ''}" type="button" role="tab" aria-selected="${active === id}" data-action="project-tab" data-tab="${id}">${esc(label)}</button>`).join('')}</div>`;
  }

  function groupValue(item, groupBy) {
    if (groupBy === 'version') return item.version || 'Unscheduled';
    if (groupBy === 'status') return item.status || 'Planned';
    if (groupBy === 'owner') return item.owner || item.developer || 'Unassigned';
    return item.epic || 'Uncategorized';
  }

  function roadmapStage(item, showOwners, showLinks) {
    const tone = statusTone(item.status);
    const people = [
      { role: 'PM', value: item.owner },
      { role: 'Dev', value: item.developer },
    ].filter(person => person.value);
    return `<article class="roadmap-stage tone-${tone}">
      <div class="roadmap-stage-top"><span class="roadmap-status tone-${tone}"><i></i>${esc(statusLabel(item.status))}</span>${item.priority ? `<span class="roadmap-priority">${esc(item.priority)}</span>` : ''}</div>
      <div class="roadmap-stage-meta">${item.sprint ? `<span>${icon('activity', 11)}${esc(item.sprint)}</span>` : ''}${item.gtmDate ? `<span>${icon('clock', 11)}${esc(item.gtmDate)}</span>` : ''}</div>
      ${showOwners && people.length ? `<div class="roadmap-people">${people.map(person => `<div class="roadmap-owner" title="${attr(`${person.role}: ${person.value}`)}"><span>${esc(person.value.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase())}</span><small><b>${esc(person.role)}</b>${esc(person.value)}</small></div>`).join('')}</div>` : ''}
      ${showLinks ? roadmapLinks(item) : ''}
    </article>`;
  }

  function renderRoadmap({ project, detail, area, layout, activeTab, rebuilding = false }) {
    if (activeTab !== 'brief') return '';
    const config = layout.config || {};
    const items = Array.isArray(config.items) ? config.items : [];
    if (!items.length) return '';
    const brain = detail?.brain || {};
    const versions = unique(items.map(item => item.version || 'Unscheduled'));
    const groupBy = ['epic', 'version', 'status', 'owner'].includes(config.groupBy) ? config.groupBy : 'epic';
    const grouped = new Map();
    for (const item of items) {
      const group = groupValue(item, groupBy);
      const entries = grouped.get(group) || [];
      entries.push(item);
      grouped.set(group, entries);
    }
    const doneCount = items.filter(item => statusTone(item.status) === 'good').length;
    const riskCount = items.filter(item => ['bad', 'warn'].includes(statusTone(item.status))).length;
    const gtmCount = unique(items.map(item => item.gtmDate).filter(Boolean)).length;
    const title = config.title || brain.title || project.title;
    const subtitle = config.subtitle || brain.statusLine || project.oneLiner || 'Release roadmap maintained in the BotBoy workspace.';
    const showOwners = config.showOwners !== false;
    const showLinks = config.showLinks !== false;
    const showSummary = config.showSummary !== false;
    const columnStyle = `--roadmap-columns:${Math.max(1, versions.length)}`;

    return `<div class="${layoutClass(config)} roadmap-layout">
      <div class="breadcrumb"><a href="#/today">Workspace</a>${icon('chevron-right', 11)}${area ? `<a href="#/areas/${encodeURIComponent(area.id)}">${esc(area.title)}</a>${icon('chevron-right', 11)}` : ''}<span>Native roadmap</span></div>
      <header class="page-head roadmap-page-head"><div><div class="eyebrow"><span class="eyebrow-dot"></span>Project · Native roadmap</div><div class="project-title-row"><h1 class="page-title">${esc(title)}</h1><span class="pill accent">${esc(project.status || 'active')}</span></div><p class="project-status-line">${esc(subtitle)}</p><div class="project-meta"><span>${icon('branch', 13)} ${number(grouped.size)} ${esc(groupBy)} groups</span><span>${icon('activity', 13)} ${number(versions.length)} release stages</span><span>${icon('file', 13)} ${number(items.length)} roadmap items</span><span>${icon('shield', 13)} Validated local layout</span></div></div><div class="head-actions"><button class="button" type="button" data-action="rebuild-brain" data-project="${attr(project.id)}" ${rebuilding ? 'disabled' : ''}>${icon('refresh')} ${rebuilding ? 'Rebuilding…' : 'Rebuild brain'}</button><button class="button primary" type="button" data-prompt="${attr(askSeed(title, project.id))}">${icon('sparkles')} Ask BotBoy</button></div></header>
      ${projectTabs(project, brain, activeTab)}
      ${showSummary ? `<section class="roadmap-summary" aria-label="Roadmap summary"><article class="card roadmap-metric"><span>Total scope</span><strong>${number(items.length)}</strong><small>Tracked roadmap items</small></article><article class="card roadmap-metric"><span>Completed</span><strong>${number(doneCount)}</strong><small>${number(Math.round(doneCount / items.length * 100))}% of visible scope</small></article><article class="card roadmap-metric ${riskCount ? 'has-risk' : ''}"><span>Needs attention</span><strong>${number(riskCount)}</strong><small>Blocked, at risk, or waiting</small></article><article class="card roadmap-metric"><span>GTM milestones</span><strong>${number(gtmCount)}</strong><small>Distinct launch windows</small></article></section>` : ''}
      <section class="roadmap-section"><div class="section-heading roadmap-heading"><div><h2>Release-stage matrix</h2><p>Each marker represents its declared release stage; no duration is inferred from the source.</p></div><div class="roadmap-legend"><span><i class="tone-accent"></i>In motion</span><span><i class="tone-good"></i>Complete</span><span><i class="tone-bad"></i>Attention</span></div></div>
        <div class="card roadmap-scroll" tabindex="0" aria-label="Roadmap matrix, horizontally scrollable"><div class="roadmap-matrix" style="${columnStyle}">
          <div class="roadmap-matrix-head roadmap-title-column"><span>Work item</span><small>Grouped by ${esc(groupBy)}</small></div>${versions.map(version => `<div class="roadmap-matrix-head"><span>${esc(version)}</span><small>${number(items.filter(item => (item.version || 'Unscheduled') === version).length)} items</small></div>`).join('')}
          ${[...grouped.entries()].map(([group, groupItems]) => `<div class="roadmap-group-head"><span>${esc(group)}</span><small>${number(groupItems.length)} items</small></div>${groupItems.map(item => `<div class="roadmap-row"><div class="roadmap-item-cell"><strong>${esc(item.title)}</strong><div><span class="roadmap-status tone-${statusTone(item.status)}"><i></i>${esc(statusLabel(item.status))}</span>${item.epic && groupBy !== 'epic' ? `<small>${esc(item.epic)}</small>` : ''}</div></div>${versions.map(version => `<div class="roadmap-version-cell">${(item.version || 'Unscheduled') === version ? roadmapStage(item, showOwners, showLinks) : '<span class="roadmap-empty-stage" aria-hidden="true"></span>'}</div>`).join('')}</div>`).join('')}`).join('')}
        </div></div>
      </section>
    </div>`;
  }

  function areaStatusLabel(status) {
    const value = String(status || 'active').trim().toLowerCase();
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : 'Active';
  }

  function renderPortfolio({ area, layout }) {
    const config = layout.config || {};
    const projects = Array.isArray(area.projects) ? area.projects : [];
    const groupBy = config.groupBy === 'none' ? 'none' : 'status';
    const grouped = new Map();
    for (const project of projects) {
      const group = groupBy === 'status' ? areaStatusLabel(project.status) : 'Projects';
      const entries = grouped.get(group) || [];
      entries.push(project);
      grouped.set(group, entries);
    }
    const evidenceCount = projects.reduce((sum, project) => sum + Number(project.itemCount || 0), 0);
    const activeCount = projects.filter(project => project.status === 'active').length;
    const title = config.title || area.title;
    const subtitle = config.subtitle || area.description || 'A stable portfolio of related workstreams and evidence.';
    const showEvidence = config.showEvidenceCounts !== false;

    return `<div class="${layoutClass(config)} portfolio-layout">
      <div class="breadcrumb"><a href="#/today">Workspace</a>${icon('chevron-right', 11)}<span>Native portfolio</span></div>
      <header class="page-head portfolio-page-head"><div><div class="eyebrow"><span class="eyebrow-dot"></span>Area · Native portfolio</div><h1 class="page-title">${esc(title)}</h1><p class="page-subtitle">${esc(subtitle)}</p></div><div class="head-actions"><button class="button primary" type="button" data-action="toggle-assistant">${icon('sparkles')} Ask BotBoy</button></div></header>
      <section class="roadmap-summary portfolio-summary" aria-label="Area summary"><article class="card roadmap-metric"><span>Projects</span><strong>${number(projects.length)}</strong><small>Canonical workstreams</small></article><article class="card roadmap-metric"><span>Active</span><strong>${number(activeCount)}</strong><small>Currently in motion</small></article><article class="card roadmap-metric"><span>Evidence</span><strong>${number(evidenceCount)}</strong><small>Connected source items</small></article><article class="card roadmap-metric"><span>Other states</span><strong>${number(projects.length - activeCount)}</strong><small>Paused, complete, or monitoring</small></article></section>
      ${projects.length ? [...grouped.entries()].map(([group, groupProjects]) => `<section class="portfolio-group"><div class="section-heading"><div><h2>${esc(group)}</h2><p>${number(groupProjects.length)} project${groupProjects.length === 1 ? '' : 's'} in this group.</p></div></div><div class="portfolio-grid">${groupProjects.map(project => `<a class="card portfolio-project" href="#/projects/${encodeURIComponent(project.id)}"><div class="portfolio-project-top"><span class="roadmap-status tone-${statusTone(project.status)}"><i></i>${esc(areaStatusLabel(project.status))}</span>${showEvidence ? `<span>${icon('file', 12)} ${number(project.itemCount)} evidence</span>` : ''}</div><h3>${esc(project.title)}</h3><p>${esc(project.oneLiner || 'Open this project for its current brain and source evidence.')}</p><div class="portfolio-project-foot"><span>Open project</span>${icon('arrow-right', 13)}</div></a>`).join('')}</div></section>`).join('') : '<section class="card empty-state"><h3>No projects in this area</h3><p>This owner-managed area remains available for future projects.</p></section>'}
    </div>`;
  }

  function renderArea(input) {
    const layout = cachedLayout('area', input?.area?.id);
    if (!layout || layout.template !== 'portfolio_board') return input?.fallbackHtml || '';
    return renderPortfolio({ ...input, layout });
  }

  function renderProject(input) {
    const layout = cachedLayout('project', input?.project?.id);
    if (!layout || layout.template !== 'roadmap') return input?.fallbackHtml || '';
    return renderRoadmap({ ...input, layout }) || input?.fallbackHtml || '';
  }

  function invalidate(scopeType, scopeId) {
    cache.delete(key(scopeType, scopeId));
  }

  window.BotBoyLayouts = Object.freeze({
    renderArea,
    renderProject,
    invalidate,
    prefetch: (scopeType, scopeId) => load(scopeType, scopeId),
  });
})();
