import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { getSetting, setSetting } from '../core/storage.js';
import type {
  ConfigValidationIssue,
  ContextDirectory,
  WritingConfigResult,
  WritingConfigStore,
  WritingContextConfig,
  WritingContextConfigOverride,
} from './types.js';

export const WRITING_CONTEXT_SETTING_KEY = 'product_manager.writing_context.v1';

const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 100,
  maxFileBytes: 5_242_880,
  maxTotalCharacters: 300_000,
});

function cloneDefault(): WritingContextConfig {
  return {
    schemaVersion: 'writing-context.v1',
    productDocDirectories: [],
    technicalDocDirectories: [],
    domainDocDirectories: [],
    glossaryFiles: [],
    limits: { ...DEFAULT_LIMITS },
  };
}

export function defaultWritingContextConfig(): WritingContextConfig {
  return cloneDefault();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function expandTilde(input: string, homeDir: string): string {
  if (input === '~') return homeDir;
  if (input.startsWith('~/')) return path.join(homeDir, input.slice(2));
  return input;
}

function isInsideHome(candidate: string, homeDir: string): boolean {
  const relative = path.relative(homeDir, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalPath(
  value: unknown,
  field: string,
  expected: 'file' | 'directory',
  homeDir: string,
  issues: ConfigValidationIssue[],
): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push({ field, message: 'must be a non-empty path string' });
    return undefined;
  }
  let resolved: string;
  try {
    resolved = fs.realpathSync(expandTilde(value.trim(), homeDir));
  } catch {
    issues.push({ field, message: 'path does not exist or cannot be resolved' });
    return undefined;
  }
  if (!isInsideHome(resolved, homeDir)) {
    issues.push({ field, message: 'path must resolve inside the current user home directory' });
    return undefined;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    issues.push({ field, message: 'path cannot be inspected' });
    return undefined;
  }
  if (expected === 'file' && !stat.isFile()) {
    issues.push({ field, message: 'must resolve to a file' });
    return undefined;
  }
  if (expected === 'directory' && !stat.isDirectory()) {
    issues.push({ field, message: 'must resolve to a directory' });
    return undefined;
  }
  return resolved;
}

function stringList(value: unknown, field: string, issues: ConfigValidationIssue[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    issues.push({ field, message: 'must be an array of non-empty strings' });
    return [];
  }
  return [...new Set(value.map((entry) => entry.trim()))];
}

function parseDirectory(
  value: unknown,
  field: string,
  homeDir: string,
  issues: ConfigValidationIssue[],
): ContextDirectory | undefined {
  const row: Record<string, unknown> = typeof value === 'string' ? { path: value } : isRecord(value) ? value : {};
  if (!isRecord(value) && typeof value !== 'string') {
    issues.push({ field, message: 'must be a path string or directory configuration object' });
    return undefined;
  }
  const canonical = canonicalPath(row.path, `${field}.path`, 'directory', homeDir, issues);
  const recursive = row.recursive === undefined ? true : row.recursive;
  const enabled = row.enabled === undefined ? true : row.enabled;
  if (typeof recursive !== 'boolean') issues.push({ field: `${field}.recursive`, message: 'must be a boolean' });
  if (typeof enabled !== 'boolean') issues.push({ field: `${field}.enabled`, message: 'must be a boolean' });
  const includeGlobs = stringList(row.includeGlobs, `${field}.includeGlobs`, issues);
  const excludeGlobs = stringList(row.excludeGlobs, `${field}.excludeGlobs`, issues);
  if (!canonical || typeof recursive !== 'boolean' || typeof enabled !== 'boolean') return undefined;
  return { path: canonical, recursive, enabled, includeGlobs, excludeGlobs };
}

function parseDirectoryList(
  value: unknown,
  field: string,
  homeDir: string,
  issues: ConfigValidationIssue[],
): ContextDirectory[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push({ field, message: 'must be an array' });
    return [];
  }
  const parsed = value
    .map((entry, index) => parseDirectory(entry, `${field}[${index}]`, homeDir, issues))
    .filter((entry): entry is ContextDirectory => Boolean(entry));
  const seen = new Set<string>();
  return parsed.filter((entry) => {
    if (seen.has(entry.path)) return false;
    seen.add(entry.path);
    return true;
  });
}

function boundedInteger(
  value: unknown,
  fallback: number,
  field: string,
  minimum: number,
  maximum: number,
  issues: ConfigValidationIssue[],
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    issues.push({ field, message: `must be an integer from ${minimum} through ${maximum}` });
    return fallback;
  }
  return value as number;
}

export function validateWritingContextConfig(input: unknown, options: { homeDir?: string } = {}): WritingConfigResult {
  const issues: ConfigValidationIssue[] = [];
  const homeDir = fs.realpathSync(options.homeDir ?? os.homedir());
  if (!isRecord(input)) return { ok: false, issues: [{ field: '$', message: 'must be a JSON object' }] };
  if (input.schemaVersion !== undefined && input.schemaVersion !== 'writing-context.v1') {
    issues.push({ field: 'schemaVersion', message: 'must be writing-context.v1 when provided' });
  }

  let overviewFile: string | undefined;
  if (input.overviewFile !== undefined && input.overviewFile !== null && input.overviewFile !== '') {
    overviewFile = canonicalPath(input.overviewFile, 'overviewFile', 'file', homeDir, issues);
  }

  const parseFileList = (value: unknown, field: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      issues.push({ field, message: 'must be an array of file paths' });
      return [];
    }
    const files = value
      .map((entry, index) => canonicalPath(entry, `${field}[${index}]`, 'file', homeDir, issues))
      .filter((entry): entry is string => Boolean(entry));
    return [...new Set(files)];
  };

  const limits = isRecord(input.limits) ? input.limits : {};
  if (input.limits !== undefined && !isRecord(input.limits)) {
    issues.push({ field: 'limits', message: 'must be an object' });
  }
  const config: WritingContextConfig = {
    schemaVersion: 'writing-context.v1',
    ...(overviewFile ? { overviewFile } : {}),
    productDocDirectories: parseDirectoryList(input.productDocDirectories, 'productDocDirectories', homeDir, issues),
    technicalDocDirectories: parseDirectoryList(input.technicalDocDirectories, 'technicalDocDirectories', homeDir, issues),
    domainDocDirectories: parseDirectoryList(input.domainDocDirectories, 'domainDocDirectories', homeDir, issues),
    glossaryFiles: parseFileList(input.glossaryFiles, 'glossaryFiles'),
    limits: {
      maxFiles: boundedInteger(limits.maxFiles, DEFAULT_LIMITS.maxFiles, 'limits.maxFiles', 1, 500, issues),
      maxFileBytes: boundedInteger(limits.maxFileBytes, DEFAULT_LIMITS.maxFileBytes, 'limits.maxFileBytes', 1_024, 52_428_800, issues),
      maxTotalCharacters: boundedInteger(limits.maxTotalCharacters, DEFAULT_LIMITS.maxTotalCharacters, 'limits.maxTotalCharacters', 1_000, 2_000_000, issues),
    },
  };
  return issues.length > 0 ? { ok: false, issues } : { ok: true, config };
}

function normalizeStoredConfig(value: unknown): WritingContextConfig {
  const defaults = cloneDefault();
  if (!isRecord(value)) return defaults;
  const normalizeDirs = (candidate: unknown): ContextDirectory[] => {
    if (!Array.isArray(candidate)) return [];
    return candidate.flatMap((entry): ContextDirectory[] => {
      if (!isRecord(entry) || typeof entry.path !== 'string') return [];
      return [{
        path: entry.path,
        recursive: typeof entry.recursive === 'boolean' ? entry.recursive : true,
        enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
        includeGlobs: Array.isArray(entry.includeGlobs) ? entry.includeGlobs.filter((item): item is string => typeof item === 'string') : [],
        excludeGlobs: Array.isArray(entry.excludeGlobs) ? entry.excludeGlobs.filter((item): item is string => typeof item === 'string') : [],
      }];
    });
  };
  const limits = isRecord(value.limits) ? value.limits : {};
  const positive = (candidate: unknown, fallback: number): number =>
    typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0 ? candidate : fallback;
  return {
    schemaVersion: 'writing-context.v1',
    ...(typeof value.overviewFile === 'string' && value.overviewFile.length > 0 ? { overviewFile: value.overviewFile } : {}),
    productDocDirectories: normalizeDirs(value.productDocDirectories),
    technicalDocDirectories: normalizeDirs(value.technicalDocDirectories),
    domainDocDirectories: normalizeDirs(value.domainDocDirectories),
    glossaryFiles: Array.isArray(value.glossaryFiles) ? value.glossaryFiles.filter((item): item is string => typeof item === 'string') : [],
    limits: {
      maxFiles: positive(limits.maxFiles, DEFAULT_LIMITS.maxFiles),
      maxFileBytes: positive(limits.maxFileBytes, DEFAULT_LIMITS.maxFileBytes),
      maxTotalCharacters: positive(limits.maxTotalCharacters, DEFAULT_LIMITS.maxTotalCharacters),
    },
  };
}

function mergeOverride(base: WritingContextConfig, override?: WritingContextConfigOverride): unknown {
  if (!override) return base;
  return {
    ...base,
    ...override,
    schemaVersion: 'writing-context.v1',
    limits: { ...base.limits, ...(override.limits ?? {}) },
  };
}

export function createWritingConfigStore(
  db: Database.Database,
  options: { homeDir?: string } = {},
): WritingConfigStore {
  const homeDir = options.homeDir ?? os.homedir();
  const get = (): WritingContextConfig => normalizeStoredConfig(getSetting<unknown>(db, WRITING_CONTEXT_SETTING_KEY));
  return {
    get,
    validate: (input) => validateWritingContextConfig(input, { homeDir }),
    set(input: unknown): WritingConfigResult {
      const result = validateWritingContextConfig(input, { homeDir });
      if (result.ok) setSetting(db, WRITING_CONTEXT_SETTING_KEY, result.config);
      return result;
    },
    resolveOverride(override?: WritingContextConfigOverride): WritingConfigResult {
      return validateWritingContextConfig(mergeOverride(get(), override), { homeDir });
    },
  };
}
