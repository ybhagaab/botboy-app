import type Database from 'better-sqlite3';

export type LayoutScope = 'area' | 'project';
export type PageLayoutTemplate = 'roadmap' | 'portfolio_board';

export interface PageLayout {
  scopeType: LayoutScope;
  scopeId: string;
  template: PageLayoutTemplate;
  schemaVersion: 1;
  config: Record<string, unknown>;
  version: number;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PageLayoutService {
  listTemplates(): Array<{
    id: PageLayoutTemplate;
    scopeTypes: LayoutScope[];
    description: string;
    config: Record<string, unknown>;
  }>;
  getLayout(scopeType: LayoutScope, scopeId: string): PageLayout | null;
  setLayout(input: {
    scopeType: unknown;
    scopeId: unknown;
    template: unknown;
    config?: unknown;
    expectedVersion?: unknown;
    updatedBy?: unknown;
  }): PageLayout;
  resetLayout(input: {
    scopeType: unknown;
    scopeId: unknown;
    expectedVersion?: unknown;
  }): void;
}

const ACCENTS = new Set(['violet', 'blue', 'emerald', 'amber', 'rose']);
const DENSITIES = new Set(['comfortable', 'compact']);
const ROADMAP_GROUPS = new Set(['epic', 'version', 'status', 'owner']);

function cleanText(value: unknown, label: string, max: number, required = false): string {
  if (value == null) {
    if (required) throw new Error(`${label} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const text = value.trim();
  if (required && !text) throw new Error(`${label} is required`);
  if (text.length > max) throw new Error(`${label} must be at most ${max} characters`);
  if (/\p{C}/u.test(text.replace(/\n|\r|\t/g, ''))) throw new Error(`${label} contains unsupported control characters`);
  return text;
}

function scopeType(value: unknown): LayoutScope {
  if (value !== 'area' && value !== 'project') throw new Error('scopeType must be area or project');
  return value;
}

function expectedVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('expectedVersion must be a positive integer');
  return parsed;
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return value === undefined ? fallback : value === true;
}

function enumValue(value: unknown, allowed: Set<string>, fallback: string, label: string): string {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(`${label} must be one of: ${[...allowed].join(', ')}`);
  }
  return value;
}

function safeUrl(value: unknown, label: string): string {
  const raw = cleanText(value, label, 2048);
  if (!raw) return '';
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${label} must be an absolute HTTPS URL`); }
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS`);
  return url.toString();
}

function normalizeRoadmapConfig(value: unknown): Record<string, unknown> {
  const config = plainObject(value, 'config');
  const rawItems = config.items;
  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 250) {
    throw new Error('roadmap config.items must contain 1-250 items');
  }
  const ids = new Set<string>();
  const items = rawItems.map((raw, index) => {
    const item = plainObject(raw, `items[${index}]`);
    const id = cleanText(item.id, `items[${index}].id`, 128) || `roadmap_item_${index + 1}`;
    if (ids.has(id)) throw new Error(`Duplicate roadmap item id: ${id}`);
    ids.add(id);
    const title = cleanText(item.title, `items[${index}].title`, 300, true);
    const links = plainObject(item.links, `items[${index}].links`);
    return {
      id,
      title,
      epic: cleanText(item.epic, `items[${index}].epic`, 120) || 'Uncategorized',
      version: cleanText(item.version, `items[${index}].version`, 80) || 'Unscheduled',
      sprint: cleanText(item.sprint, `items[${index}].sprint`, 80),
      status: cleanText(item.status, `items[${index}].status`, 60) || 'Planned',
      priority: cleanText(item.priority, `items[${index}].priority`, 40),
      gtmDate: cleanText(item.gtmDate, `items[${index}].gtmDate`, 80),
      owner: cleanText(item.owner, `items[${index}].owner`, 120),
      developer: cleanText(item.developer, `items[${index}].developer`, 180),
      links: {
        productDoc: safeUrl(links.productDoc, `items[${index}].links.productDoc`),
        design: safeUrl(links.design, `items[${index}].links.design`),
        slack: safeUrl(links.slack, `items[${index}].links.slack`),
      },
    };
  });
  return {
    title: cleanText(config.title, 'config.title', 200),
    subtitle: cleanText(config.subtitle, 'config.subtitle', 1000),
    accent: enumValue(config.accent, ACCENTS, 'violet', 'config.accent'),
    density: enumValue(config.density, DENSITIES, 'comfortable', 'config.density'),
    groupBy: enumValue(config.groupBy, ROADMAP_GROUPS, 'epic', 'config.groupBy'),
    showOwners: boolean(config.showOwners, true),
    showLinks: boolean(config.showLinks, true),
    showSummary: boolean(config.showSummary, true),
    items,
  };
}

function normalizePortfolioConfig(value: unknown): Record<string, unknown> {
  const config = plainObject(value, 'config');
  return {
    title: cleanText(config.title, 'config.title', 200),
    subtitle: cleanText(config.subtitle, 'config.subtitle', 1000),
    accent: enumValue(config.accent, ACCENTS, 'violet', 'config.accent'),
    density: enumValue(config.density, DENSITIES, 'comfortable', 'config.density'),
    groupBy: enumValue(config.groupBy, new Set(['status', 'none']), 'status', 'config.groupBy'),
    showEvidenceCounts: boolean(config.showEvidenceCounts, true),
  };
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function createPageLayoutService(options: { db: Database.Database }): PageLayoutService {
  const { db } = options;

  function assertScopeExists(type: LayoutScope, id: string): void {
    const table = type === 'area' ? 'areas' : 'projects';
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) {
      throw new Error(`${type === 'area' ? 'Area' : 'Project'} ${id} not found`);
    }
  }

  function map(row: any): PageLayout {
    return {
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      template: row.template,
      schemaVersion: 1,
      config: parseJson(row.config_json),
      version: Number(row.version),
      updatedBy: row.updated_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function listTemplates() {
    return [
      {
        id: 'roadmap' as const,
        scopeTypes: ['project' as const],
        description: 'Native release-stage Gantt matrix grouped by epic, version, status, or owner.',
        config: {
          required: ['items'],
          itemFields: ['id', 'title', 'epic', 'version', 'sprint', 'status', 'priority', 'gtmDate', 'owner', 'developer', 'links'],
          options: {
            accent: [...ACCENTS],
            density: [...DENSITIES],
            groupBy: [...ROADMAP_GROUPS],
            showOwners: 'boolean',
            showLinks: 'boolean',
            showSummary: 'boolean',
          },
        },
      },
      {
        id: 'portfolio_board' as const,
        scopeTypes: ['area' as const],
        description: 'Native project portfolio board grouped by lifecycle status.',
        config: {
          options: {
            accent: [...ACCENTS],
            density: [...DENSITIES],
            groupBy: ['status', 'none'],
            showEvidenceCounts: 'boolean',
          },
        },
      },
    ];
  }

  function getLayout(type: LayoutScope, id: string): PageLayout | null {
    const row = db.prepare('SELECT * FROM page_layouts WHERE scope_type = ? AND scope_id = ?').get(type, id) as any;
    return row ? map(row) : null;
  }

  function setLayout(input: {
    scopeType: unknown;
    scopeId: unknown;
    template: unknown;
    config?: unknown;
    expectedVersion?: unknown;
    updatedBy?: unknown;
  }): PageLayout {
    const type = scopeType(input.scopeType);
    const id = cleanText(input.scopeId, 'scopeId', 128, true);
    assertScopeExists(type, id);
    const template = cleanText(input.template, 'template', 80, true) as PageLayoutTemplate;
    if (template === 'roadmap' && type !== 'project') throw new Error('roadmap layouts apply only to projects');
    if (template === 'portfolio_board' && type !== 'area') throw new Error('portfolio_board layouts apply only to areas');
    if (template !== 'roadmap' && template !== 'portfolio_board') throw new Error('Unknown page layout template');
    const current = getLayout(type, id);
    const wanted = expectedVersion(input.expectedVersion);
    if (wanted !== undefined && wanted !== current?.version) {
      throw new Error(`Version conflict: expected ${wanted}, current version is ${current?.version ?? 0}`);
    }
    const config = template === 'roadmap'
      ? normalizeRoadmapConfig(input.config)
      : normalizePortfolioConfig(input.config);
    const serialized = JSON.stringify(config);
    if (Buffer.byteLength(serialized, 'utf8') > 300_000) throw new Error('Layout configuration exceeds 300 KB');
    const updatedBy = cleanText(input.updatedBy, 'updatedBy', 80) || 'agent';
    db.prepare(`
      INSERT INTO page_layouts
        (scope_type, scope_id, template, schema_version, config_json, version, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, 1, ?, datetime('now'), datetime('now'))
      ON CONFLICT(scope_type, scope_id) DO UPDATE SET
        template = excluded.template,
        schema_version = excluded.schema_version,
        config_json = excluded.config_json,
        version = page_layouts.version + 1,
        updated_by = excluded.updated_by,
        updated_at = datetime('now')
    `).run(type, id, template, serialized, updatedBy);
    return getLayout(type, id)!;
  }

  function resetLayout(input: {
    scopeType: unknown;
    scopeId: unknown;
    expectedVersion?: unknown;
  }): void {
    const type = scopeType(input.scopeType);
    const id = cleanText(input.scopeId, 'scopeId', 128, true);
    assertScopeExists(type, id);
    const current = getLayout(type, id);
    if (!current) return;
    const wanted = expectedVersion(input.expectedVersion);
    if (wanted !== undefined && wanted !== current.version) {
      throw new Error(`Version conflict: expected ${wanted}, current version is ${current.version}`);
    }
    db.prepare('DELETE FROM page_layouts WHERE scope_type = ? AND scope_id = ?').run(type, id);
  }

  return { listTemplates, getLayout, setLayout, resetLayout };
}
