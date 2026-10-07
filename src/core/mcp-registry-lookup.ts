/**
 * `mcp_find_server` (MCP_REMOTE_TRANSPORTS_PLAN.md MR1): one read-only lookup
 * across the official MCP Registry and, when `aim` is installed, the AIM
 * registry. Code maps every hit to ready `mcp_add_custom_server` arguments,
 * so the model never assembles a launch command or URL from prose.
 *
 * Retrieved knowledge, untrusted: names and descriptions are third-party
 * text. Only the search words leave this Mac (to the official registry);
 * the AIM catalog is listed through the owner's own `aim` and cached
 * locally, because one listing takes 15–90 seconds.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { pathValueWithFallbackDirectories, resolveCommandExecutable } from './mcp-profiles.js';

export const OFFICIAL_MCP_REGISTRY = 'https://registry.modelcontextprotocol.io';

/** Arguments for mcp_add_custom_server (plus ownerRequested). */
export interface McpServerAddArguments {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: 'http' | 'sse';
  headers?: Record<string, string>;
  secret?: string[];
  required?: string[];
  about: { publisher?: string; description?: string; source: string; website?: string };
}

export interface McpServerOption {
  /** Plain words: where it runs and how. */
  label: string;
  /** Remote servers: the host that receives every call. */
  host?: string;
  /** Steps a person runs first, in the chat terminal. */
  setup?: string[];
  note?: string;
  add: McpServerAddArguments;
}

export interface McpServerCandidate {
  source: 'mcp-registry' | 'aim';
  /** Registry name (`com.notion/mcp`) or AIM bundle id. */
  id: string;
  title: string;
  /** Who publishes it: the registry's verified namespace, or the AIM registry. */
  publisher: string;
  description: string;
  version?: string;
  supportLevel?: string;
  installed?: boolean;
  authTypes?: string[];
  website?: string;
  repository?: string;
  options: McpServerOption[];
  /** Registry options BotBoy cannot run yet, in plain words. */
  skipped?: string[];
}

export interface McpSourceStatus {
  status: 'ok' | 'not_installed' | 'loading' | 'unavailable';
  matches?: number;
  message?: string;
}

export interface McpFindResult {
  query: string;
  candidates: McpServerCandidate[];
  sources: { 'mcp-registry': McpSourceStatus; aim: McpSourceStatus };
}

export interface McpServerFinder {
  find(query: string, options?: { limit?: number }): Promise<McpFindResult>;
}

interface AimBundle {
  id: string;
  name: string;
  supportLevel?: string;
  description: string;
  authTypes: string[];
  installed: boolean;
}

interface AimCatalog {
  fetchedAt: number;
  bundles: AimBundle[];
}

export interface McpServerFinderDeps {
  fetchImpl?: typeof fetch;
  registryBase?: string;
  /** Per registry request. The registry's search can take 20–30 seconds. */
  registryTimeoutMs?: number;
  /** `aim mcp list -o JSON` stdout, or null when aim is not installed. */
  listAimCatalog?: () => Promise<string | null>;
  /** Where the AIM catalog is cached between listings. */
  cacheFile?: string;
  /** How long one search waits for a first AIM listing before reporting `loading`. */
  aimWaitMs?: number;
  now?: () => number;
}

const REGISTRY_CACHE_MS = 10 * 60_000;
const AIM_CATALOG_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const STOPWORDS = new Set(['mcp', 'server', 'servers', 'the', 'a', 'an', 'for', 'of', 'to', 'add', 'connect', 'official', 'remote', 'local', 'tool', 'tools', 'and']);
const SUPPORT_RANK: Record<string, number> = { recommended: 0, supported: 1, 'under assessment': 2, 'in development': 3 };

/** Search words, lowercase, without filler. */
export function searchWords(query: string): string[] {
  const words = (query.toLowerCase().match(/[a-z0-9][a-z0-9.-]*/g) ?? [])
    .map(word => word.replace(/[.-]+$/, ''))
    .filter(word => word.length > 1 && !STOPWORDS.has(word));
  return [...new Set(words)];
}

/** `com.notion` → `notion.com`; `io.github.brave` → `github.com/brave`. */
export function publisherOfNamespace(registryName: string): string {
  const namespace = registryName.split('/')[0] ?? '';
  const labels = namespace.split('.').filter(Boolean);
  if (labels[0] === 'io' && labels[1] === 'github' && labels[2]) return `github.com/${labels.slice(2).join('.')}`;
  return labels.reverse().join('.');
}

function clip(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function titleFromName(registryName: string): string {
  const last = registryName.split('/').pop() ?? registryName;
  return last.replace(/[-_]+/g, ' ').replace(/\b(mcp|server)\b/gi, '').replace(/\s+/g, ' ').trim() || last;
}

type RegistryInput = { name?: unknown; value?: unknown; default?: unknown; isSecret?: unknown; isRequired?: unknown; description?: unknown };

/** Registry header or env inputs → BotBoy values plus secret/required names. */
function mapInputs(inputs: unknown): { values: Record<string, string>; secret: string[]; required: string[] } {
  const values: Record<string, string> = {};
  const secret: string[] = [];
  const required: string[] = [];
  for (const input of Array.isArray(inputs) ? inputs as RegistryInput[] : []) {
    if (typeof input?.name !== 'string' || !input.name.trim()) continue;
    const name = input.name.trim();
    const isSecret = input.isSecret === true;
    // A secret's value is never pre-filled; a template like `Bearer {key}`
    // stays so the owner types only the key.
    const given = typeof input.value === 'string' ? input.value : typeof input.default === 'string' ? input.default : '';
    values[name] = isSecret && given && !/\{[^{}]+\}/.test(given) ? '' : given;
    if (isSecret) secret.push(name);
    if (input.isRequired === true) required.push(name);
  }
  return { values, secret, required };
}

type RegistryArgument = { type?: unknown; name?: unknown; value?: unknown; default?: unknown; isRequired?: unknown; isSecret?: unknown };

/** Package arguments that have a value; null when a required one has none. */
function mapArguments(list: unknown): string[] | null {
  const argv: string[] = [];
  for (const argument of Array.isArray(list) ? list as RegistryArgument[] : []) {
    const value = typeof argument.value === 'string' ? argument.value : typeof argument.default === 'string' ? argument.default : '';
    if (argument.isSecret === true) return null;
    if (!value || /\{[^{}]+\}/.test(value)) {
      if (argument.isRequired === true) return null;
      continue;
    }
    if (argument.type === 'named' && typeof argument.name === 'string') argv.push(argument.name, value);
    else argv.push(value);
  }
  return argv;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

/** Map one registry entry to the definitions BotBoy can run. */
export function registryCandidate(entry: unknown): McpServerCandidate | null {
  const server = (entry as { server?: Record<string, any> })?.server;
  if (!server || typeof server.name !== 'string') return null;
  const name: string = server.name;
  const publisher = publisherOfNamespace(name);
  const title = clip(server.title, 80) || titleFromName(name);
  const version = typeof server.version === 'string' ? server.version : undefined;
  const repository = typeof server.repository?.url === 'string' ? server.repository.url : undefined;
  const website = typeof server.websiteUrl === 'string' ? server.websiteUrl : undefined;
  const description = clip(server.description, 400);
  const about = (source: string) => ({
    publisher,
    ...(description ? { description } : {}),
    source,
    ...(website || repository ? { website: website || repository } : {}),
  });
  const source = `registry:${name}${version ? `@${version}` : ''}`;
  const options: McpServerOption[] = [];
  const skipped: string[] = [];

  const remotes = (Array.isArray(server.remotes) ? server.remotes : [])
    .filter((remote: any) => typeof remote?.url === 'string')
    .sort((a: any, b: any) => (a.type === 'streamable-http' ? 0 : 1) - (b.type === 'streamable-http' ? 0 : 1));
  for (const remote of remotes) {
    const type = remote.type === 'streamable-http' ? 'http' : remote.type === 'sse' ? 'sse' : null;
    if (!type) { skipped.push(`a remote of type ${clip(remote.type, 30)}`); continue; }
    if (/\{[^{}]+\}/.test(remote.url)) { skipped.push(`${remote.url} (its address needs values filled in)`); continue; }
    const host = hostOf(remote.url);
    if (!host) continue;
    const headers = mapInputs(remote.headers);
    const ownHost = !publisher.includes('/') && (host === publisher || host.endsWith(`.${publisher}`));
    options.push({
      label: `Remote: ${type === 'http' ? 'Streamable HTTP' : 'legacy SSE'} at ${host}${ownHost || publisher.includes('/') ? '' : ` (a host run by a third party, not ${publisher})`}`,
      host,
      add: {
        name: title,
        url: remote.url,
        type,
        ...(Object.keys(headers.values).length ? { headers: headers.values } : {}),
        ...(headers.secret.length ? { secret: headers.secret } : {}),
        ...(headers.required.length ? { required: headers.required } : {}),
        about: about(source),
      },
    });
  }

  for (const pkg of Array.isArray(server.packages) ? server.packages : []) {
    const registryType = String(pkg?.registryType ?? '');
    const identifier = typeof pkg?.identifier === 'string' ? pkg.identifier : '';
    const transport = String(pkg?.transport?.type ?? 'stdio');
    if (!identifier) continue;
    if (transport !== 'stdio') { skipped.push(`${registryType} package ${identifier} (it starts its own local web server)`); continue; }
    const env = mapInputs(pkg.environmentVariables);
    const packageArgs = mapArguments(pkg.packageArguments);
    const runtimeArgs = mapArguments(pkg.runtimeArguments);
    if (!packageArgs || !runtimeArgs) { skipped.push(`${registryType} package ${identifier} (it needs arguments BotBoy cannot fill)`); continue; }
    const pinned = typeof pkg.version === 'string' && pkg.version ? pkg.version : '';
    let command = '';
    let args: string[] = [];
    let label = '';
    if (registryType === 'npm') {
      command = 'npx';
      args = ['-y', ...runtimeArgs, pinned ? `${identifier}@${pinned}` : identifier, ...packageArgs];
      label = `Local: npm package ${identifier}, run with npx (needs Node.js)`;
    } else if (registryType === 'pypi') {
      command = 'uvx';
      args = [...runtimeArgs, pinned ? `${identifier}==${pinned}` : identifier, ...packageArgs];
      label = `Local: Python package ${identifier}, run with uvx (needs uv)`;
    } else if (registryType === 'oci') {
      command = 'docker';
      args = ['run', '-i', '--rm', ...runtimeArgs, ...Object.keys(env.values).flatMap(variable => ['-e', variable]), identifier, ...packageArgs];
      label = `Local: container image ${identifier}, run with Docker`;
    } else {
      skipped.push(`${registryType || 'unknown'} package ${identifier}`);
      continue;
    }
    options.push({
      label,
      add: {
        name: title,
        command,
        args,
        ...(Object.keys(env.values).length ? { env: env.values } : {}),
        ...(env.secret.length ? { secret: env.secret } : {}),
        ...(env.required.length ? { required: env.required } : {}),
        about: about(source),
      },
    });
  }

  return {
    source: 'mcp-registry',
    id: name,
    title,
    publisher,
    description,
    ...(version ? { version } : {}),
    ...(website ? { website } : {}),
    ...(repository ? { repository } : {}),
    options,
    ...(skipped.length ? { skipped } : {}),
  };
}

/** How many search words an entry matches, and a rank among equal matches. */
function registryScore(candidate: McpServerCandidate, words: string[]): { matched: number; rank: number } {
  const name = candidate.id.toLowerCase();
  const text = `${name} ${candidate.title} ${candidate.description}`.toLowerCase();
  const publisherLabels = candidate.publisher.toLowerCase().split(/[./]/);
  let matched = 0;
  let rank = 0;
  for (const word of words) {
    if (!text.includes(word)) continue;
    matched += 1;
    if (name.includes(word)) rank += 1;
    // A namespace the registry verified for the service itself.
    if (publisherLabels.includes(word)) rank += 3;
  }
  // Entries BotBoy cannot run still show (the owner learns why), but last.
  return { matched, rank: rank - (candidate.options.length ? 0 : 4) };
}

/** `Enterprise Asana MCP Server [Recommended]` → name + support level. */
function splitSupportLevel(name: string): { name: string; supportLevel?: string } {
  const match = name.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
  return match ? { name: match[1].trim(), supportLevel: match[2].trim() } : { name: name.trim() };
}

/** Parse `aim mcp list -o JSON` into the fields a search needs. */
export function parseAimCatalog(stdout: string, fetchedAt: number): AimCatalog {
  const parsed = JSON.parse(stdout) as { registryBundles?: unknown[] };
  const bundles: AimBundle[] = [];
  for (const raw of Array.isArray(parsed.registryBundles) ? parsed.registryBundles as Array<Record<string, unknown>> : []) {
    if (typeof raw?.bundleId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(raw.bundleId)) continue;
    const { name, supportLevel } = splitSupportLevel(typeof raw.name === 'string' ? raw.name : raw.bundleId);
    bundles.push({
      id: raw.bundleId,
      name: name || raw.bundleId,
      ...(supportLevel ? { supportLevel } : {}),
      description: clip(raw.description, 2000),
      authTypes: Array.isArray(raw.authTypes) ? raw.authTypes.filter((type): type is string => typeof type === 'string').slice(0, 10) : [],
      installed: raw.isInstalled === true,
    });
  }
  return { fetchedAt, bundles };
}

function aimScore(bundle: AimBundle, words: string[]): number {
  const id = bundle.id.toLowerCase();
  const name = bundle.name.toLowerCase();
  const description = bundle.description.toLowerCase();
  let score = 0;
  for (const word of words) {
    let hit = 0;
    if (id === word) hit += 10;
    if (id.includes(word)) hit += 3;
    if (name.includes(word)) hit += 2;
    if (description.includes(word)) hit += 1;
    if (!hit) return 0;
    score += hit;
  }
  return score;
}

function aimCandidate(bundle: AimBundle): McpServerCandidate {
  const midway = bundle.authTypes.some(type => type.toLowerCase() === 'midway');
  const setup = [
    ...(midway ? ['mwinit (only when the Midway session has expired)'] : []),
    ...(bundle.installed ? [] : [`aim mcp install ${bundle.id}`]),
  ];
  const website = `https://ai-registry.amazon.dev/mcp-registry/server/${bundle.id}`;
  return {
    source: 'aim',
    id: bundle.id,
    title: bundle.name,
    publisher: 'Amazon AIM registry',
    description: clip(bundle.description, 1200),
    ...(bundle.supportLevel ? { supportLevel: bundle.supportLevel } : {}),
    installed: bundle.installed,
    authTypes: bundle.authTypes,
    website,
    options: [{
      label: `Local: through AIM (aim mcp start-server ${bundle.id})${midway ? ', signed in with Midway' : ''}`,
      ...(setup.length ? { setup } : {}),
      note: 'Read the description for any extra one-time setup step it names, and run it in the chat terminal.',
      add: {
        name: bundle.name,
        command: 'aim',
        args: ['mcp', 'start-server', bundle.id],
        about: {
          publisher: 'Amazon AIM registry',
          ...(bundle.description ? { description: clip(bundle.description, 400) } : {}),
          source: `aim:${bundle.id}`,
          website,
        },
      },
    }],
  };
}

/** The owner's `aim mcp list -o JSON`, without a shell; null when aim is absent. */
export async function listAimCatalogWithCli(): Promise<string | null> {
  const executable = await resolveCommandExecutable('aim', pathValueWithFallbackDirectories(process.env.PATH));
  if (!executable) return null;
  return new Promise((resolve, reject) => {
    execFile(executable, ['mcp', 'list', '-o', 'JSON'], {
      timeout: 180_000,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
      env: { ...getDefaultEnvironment(), PATH: pathValueWithFallbackDirectories(process.env.PATH) },
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message || '').split('\n').map(line => line.trim()).find(Boolean) ?? 'no detail';
        reject(new Error(`aim mcp list failed: ${detail.slice(0, 200)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export function createMcpServerFinder(deps: McpServerFinderDeps = {}): McpServerFinder {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const registryBase = (deps.registryBase ?? OFFICIAL_MCP_REGISTRY).replace(/\/+$/, '');
  const registryTimeoutMs = deps.registryTimeoutMs ?? 40_000;
  const listAim = deps.listAimCatalog ?? listAimCatalogWithCli;
  const cacheFile = deps.cacheFile ?? path.join(os.homedir(), '.personal-productivity-tracker', 'cache', 'aim-mcp-catalog.json');
  const aimWaitMs = deps.aimWaitMs ?? 40_000;
  const now = deps.now ?? (() => Date.now());

  const registryCache = new Map<string, { at: number; entries: unknown[] }>();
  let aimCatalog: AimCatalog | null = null;
  let aimRefresh: Promise<AimCatalog | null> | null = null;
  let aimMissing = false;
  let aimError: string | null = null;

  async function searchRegistry(term: string): Promise<unknown[]> {
    const cached = registryCache.get(term);
    if (cached && now() - cached.at < REGISTRY_CACHE_MS) return cached.entries;
    const url = `${registryBase}/v0.1/servers?search=${encodeURIComponent(term)}&limit=30&version=latest`;
    const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(registryTimeoutMs) });
    if (!response.ok) throw new Error(`the registry answered HTTP ${response.status}`);
    const body = await response.json() as { servers?: unknown[] };
    const entries = Array.isArray(body.servers) ? body.servers : [];
    registryCache.set(term, { at: now(), entries });
    return entries;
  }

  function readAimCache(): AimCatalog | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as AimCatalog;
      return typeof parsed?.fetchedAt === 'number' && Array.isArray(parsed.bundles) ? parsed : null;
    } catch {
      return null;
    }
  }

  function refreshAim(): Promise<AimCatalog | null> {
    aimRefresh ??= (async () => {
      try {
        const stdout = await listAim();
        if (stdout === null) { aimMissing = true; return null; }
        aimMissing = false;
        const catalog = parseAimCatalog(stdout, now());
        aimCatalog = catalog;
        aimError = null;
        try {
          fs.mkdirSync(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
          const temporary = `${cacheFile}.${process.pid}.tmp`;
          fs.writeFileSync(temporary, JSON.stringify(catalog), { mode: 0o600 });
          fs.renameSync(temporary, cacheFile);
        } catch { /* the in-memory copy still serves this run */ }
        return catalog;
      } catch (error) {
        aimError = error instanceof Error ? error.message : String(error);
        return null;
      } finally {
        aimRefresh = null;
      }
    })();
    return aimRefresh;
  }

  /** The cached catalog (refreshed in the background when stale), or a bounded wait for the first listing. */
  async function aimBundles(): Promise<{ catalog: AimCatalog | null; status: McpSourceStatus }> {
    aimCatalog ??= readAimCache();
    if (aimCatalog) {
      if (now() - aimCatalog.fetchedAt > AIM_CATALOG_TTL_MS) void refreshAim();
      return { catalog: aimCatalog, status: { status: 'ok' } };
    }
    const pending = refreshAim();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([
      pending,
      new Promise<'waiting'>(resolve => { timer = setTimeout(() => resolve('waiting'), aimWaitMs); timer.unref?.(); }),
    ]);
    if (timer) clearTimeout(timer);
    if (waited === 'waiting') {
      return { catalog: null, status: { status: 'loading', message: 'The AIM registry list is still loading (one listing takes a minute or two). Search again shortly; it is cached after that.' } };
    }
    if (waited) return { catalog: waited, status: { status: 'ok' } };
    if (aimMissing) return { catalog: null, status: { status: 'not_installed', message: 'aim is not installed on this Mac, so only the official MCP Registry was searched.' } };
    return { catalog: null, status: { status: 'unavailable', message: aimError ?? 'The AIM registry could not be listed.' } };
  }

  return {
    async find(query, options = {}) {
      const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(options.limit ?? DEFAULT_LIMIT)));
      const words = searchWords(query);
      const terms = (words.length ? [...words].sort((a, b) => b.length - a.length) : [query.trim().toLowerCase()]).filter(Boolean).slice(0, 3);
      const scoringWords = words.length ? words : terms;

      const registryTask = (async (): Promise<{ candidates: McpServerCandidate[]; status: McpSourceStatus }> => {
        const settled = await Promise.allSettled(terms.map(term => searchRegistry(term)));
        const failures = settled.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
        const byName = new Map<string, McpServerCandidate>();
        for (const item of settled) {
          if (item.status !== 'fulfilled') continue;
          for (const entry of item.value) {
            const candidate = registryCandidate(entry);
            if (candidate && !byName.has(candidate.id)) byName.set(candidate.id, candidate);
          }
        }
        const scored = [...byName.values()]
          .map(candidate => ({ candidate, ...registryScore(candidate, scoringWords) }))
          .filter(item => item.matched > 0);
        // Entries matching every word beat entries matching one of them.
        const best = Math.max(0, ...scored.map(item => item.matched));
        const ranked = scored
          .filter(item => item.matched === best)
          .sort((a, b) => b.rank - a.rank || a.candidate.id.localeCompare(b.candidate.id))
          .slice(0, limit)
          .map(item => item.candidate);
        if (failures.length === settled.length && settled.length) {
          const reason = failures[0].reason instanceof Error ? failures[0].reason.message : String(failures[0].reason);
          return { candidates: [], status: { status: 'unavailable', message: `The official MCP Registry could not be searched: ${clip(reason, 160)}` } };
        }
        return { candidates: ranked, status: { status: 'ok', matches: ranked.length } };
      })();

      const aimTask = (async (): Promise<{ candidates: McpServerCandidate[]; status: McpSourceStatus }> => {
        const { catalog, status } = await aimBundles();
        if (!catalog) return { candidates: [], status };
        const ranked = catalog.bundles
          .map(bundle => ({ bundle, score: aimScore(bundle, scoringWords) }))
          .filter(item => item.score > 0)
          .sort((a, b) => b.score - a.score
            || (SUPPORT_RANK[a.bundle.supportLevel?.toLowerCase() ?? ''] ?? 9) - (SUPPORT_RANK[b.bundle.supportLevel?.toLowerCase() ?? ''] ?? 9)
            || Number(b.bundle.installed) - Number(a.bundle.installed)
            || a.bundle.id.localeCompare(b.bundle.id))
          .slice(0, limit)
          .map(item => aimCandidate(item.bundle));
        return { candidates: ranked, status: { status: 'ok', matches: ranked.length } };
      })();

      const [registry, aim] = await Promise.all([registryTask, aimTask]);
      return {
        query,
        candidates: [...registry.candidates, ...aim.candidates],
        sources: { 'mcp-registry': registry.status, aim: aim.status },
      };
    },
  };
}
