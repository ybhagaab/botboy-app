import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_FILE_COUNT = 100;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

export interface StaticArtifactBundleFile {
  relativePath: string;
  bytes: number;
  sha256: string;
  generated: boolean;
}

export interface StaticArtifactBundle {
  slug: string;
  sourcePath: string;
  filesRoot: string;
  files: Map<string, Buffer>;
  manifest: StaticArtifactBundleFile[];
  manifestSha256: string;
  totalBytes: number;
  transformations: {
    inlineStylesExternalized: number;
    inlineScriptsExternalized: number;
    localAssetsIncluded: number;
  };
}

export interface BuildStaticArtifactInput {
  filePath: string;
  slug?: string;
  /** Additional files relative to the HTML file's directory (for dynamic JS references). */
  assetPaths?: string[];
  /** Test injection; production defaults to BotBoy's served files directory. */
  filesRoot?: string;
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function normalizeRelativePath(value: string, label: string): string {
  const decoded = decodeURIComponent(value.split(/[?#]/, 1)[0] ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!decoded || decoded === '.') return '';
  if (decoded.startsWith('/') || decoded.split('/').includes('..')) {
    throw new Error(`${label} must stay within the HTML file's directory (got "${value}")`);
  }
  const normalized = path.posix.normalize(decoded);
  if (!normalized || normalized === '.' || normalized.startsWith('../')) {
    throw new Error(`${label} is invalid: "${value}"`);
  }
  return normalized;
}

export function staticArtifactSlug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (!cleaned) throw new Error('Static artifact slug must contain letters or numbers');
  return cleaned;
}

function normalizeAssetReference(value: string, label: string): string {
  const decoded = decodeURIComponent(value.split(/[?#]/, 1)[0] ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!decoded || decoded === '.') return '';
  if (decoded.startsWith('/')) throw new Error(`${label} must be a relative local path (got "${value}")`);
  return path.posix.normalize(decoded);
}

function resolveSourcePath(filePath: string, filesRoot: string): string {
  const raw = String(filePath ?? '').trim();
  if (!raw) throw new Error('filePath is required');
  const expanded = raw === '~' ? os.homedir() : raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
  const candidate = path.resolve(path.isAbsolute(expanded) ? expanded : path.join(filesRoot, expanded));
  let real: string;
  try { real = fs.realpathSync(candidate); } catch { throw new Error(`Static artifact file does not exist: ${candidate}`); }
  if (!isInside(filesRoot, real)) throw new Error('Static artifacts must live under ~/.personal-productivity-tracker/files');
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error('filePath must point to a regular file');
  if (!/\.html?$/i.test(real)) throw new Error('Static Harmony publishing currently accepts .html or .htm files');
  if (stat.size > MAX_HTML_BYTES) throw new Error(`HTML artifact exceeds the ${MAX_HTML_BYTES / 1024 / 1024} MB limit`);
  return real;
}

function isIgnoredReference(value: string): boolean {
  const ref = value.trim();
  return !ref || ref.startsWith('#') || /^(?:data|blob|mailto|tel|javascript):/i.test(ref);
}

function isExternalReference(value: string): boolean {
  return /^(?:https?:)?\/\//i.test(value.trim());
}

interface PendingAsset {
  sourcePath: string;
  relativePath: string;
}

function resolveLocalReference(
  rawReference: string,
  sourceDirectory: string,
  outputDirectory: string,
  artifactRoot: string,
  filesRoot: string,
  label: string,
): PendingAsset | null {
  if (isIgnoredReference(rawReference)) return null;
  if (isExternalReference(rawReference)) throw new Error(`${label} references an external asset that Harmony's self-only CSP cannot load: ${rawReference}`);
  const relativeToParent = normalizeAssetReference(rawReference, label);
  if (!relativeToParent) return null;
  const sourcePath = path.resolve(sourceDirectory, relativeToParent);
  if (!isInside(artifactRoot, sourcePath) || !isInside(filesRoot, sourcePath)) {
    throw new Error(`${label} escapes the HTML artifact directory: ${rawReference}`);
  }
  let real: string;
  try { real = fs.realpathSync(sourcePath); } catch { throw new Error(`${label} is missing: ${sourcePath}`); }
  if (!isInside(artifactRoot, real) || !isInside(filesRoot, real) || !fs.statSync(real).isFile()) {
    throw new Error(`${label} must resolve to a regular file within the HTML artifact directory`);
  }
  const outputPath = path.posix.normalize(path.posix.join(outputDirectory, relativeToParent));
  if (!outputPath || outputPath === '.' || outputPath.startsWith('../') || outputPath.startsWith('/')) {
    throw new Error(`${label} escapes the published artifact: ${rawReference}`);
  }
  return {
    sourcePath: real,
    relativePath: outputPath,
  };
}

function htmlReferences(
  html: string,
  sourceDirectory: string,
  filesRoot: string,
  ignoredOutputPaths: ReadonlySet<string> = new Set(),
): PendingAsset[] {
  const pending: PendingAsset[] = [];
  const tagPattern = /<([a-z][\w:-]*)\b([^>]*)>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagPattern.exec(html))) {
    const tag = tagMatch[1].toLowerCase();
    const attrs = tagMatch[2];
    const attributePattern = /\b(src|href|poster)\s*=\s*(["'])(.*?)\2/gi;
    let attributeMatch: RegExpExecArray | null;
    while ((attributeMatch = attributePattern.exec(attrs))) {
      const attribute = attributeMatch[1].toLowerCase();
      const reference = attributeMatch[3].trim();
      // External anchors are navigation, not artifact dependencies. External
      // scripts/styles/images are rejected because the Harmony app CSP is self-only.
      if (tag === 'a' && attribute === 'href' && (isExternalReference(reference) || isIgnoredReference(reference))) continue;
      if (!isIgnoredReference(reference) && !isExternalReference(reference)) {
        const outputPath = normalizeAssetReference(reference, `<${tag}> ${attribute}`);
        if (ignoredOutputPaths.has(outputPath)) continue;
      }
      const resolved = resolveLocalReference(reference, sourceDirectory, '', sourceDirectory, filesRoot, `<${tag}> ${attribute}`);
      if (resolved) pending.push(resolved);
    }
  }
  return pending;
}

function cssReferences(css: string, sourcePath: string, relativePath: string, artifactRoot: string, filesRoot: string): PendingAsset[] {
  const pending: PendingAsset[] = [];
  const sourceDirectory = path.dirname(sourcePath);
  const outputDirectory = path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath);
  const references: string[] = [];
  const urlPattern = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(css))) references.push(match[2]);
  const importPattern = /@import\s+(?:url\(\s*)?(["'])(.*?)\1/gi;
  while ((match = importPattern.exec(css))) references.push(match[2]);
  for (const reference of references) {
    const resolved = resolveLocalReference(reference, sourceDirectory, outputDirectory, artifactRoot, filesRoot, `CSS ${relativePath}`);
    if (resolved) pending.push(resolved);
  }
  return pending;
}

function externalizeInlineAssets(html: string): {
  html: string;
  generated: Array<{ relativePath: string; content: string }>;
  styleCount: number;
  scriptCount: number;
} {
  const generated: Array<{ relativePath: string; content: string }> = [];
  let styleCount = 0;
  let scriptCount = 0;
  let transformed = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_whole, content: string) => {
    styleCount += 1;
    const relativePath = `botboy-inline-style-${styleCount}.css`;
    generated.push({ relativePath, content });
    return `<link rel="stylesheet" href="${relativePath}">`;
  });
  transformed = transformed.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (whole, attrs: string, content: string) => {
    if (/\bsrc\s*=/i.test(attrs)) return whole;
    const type = attrs.match(/\btype\s*=\s*(["'])(.*?)\1/i)?.[2]?.toLowerCase() ?? '';
    if (type && !['text/javascript', 'application/javascript', 'module'].includes(type)) return whole;
    scriptCount += 1;
    const relativePath = `botboy-inline-script-${scriptCount}.js`;
    generated.push({ relativePath, content });
    const preservedAttrs = attrs.trim();
    return `<script${preservedAttrs ? ` ${preservedAttrs}` : ''} src="${relativePath}"></script>`;
  });
  if (/<[a-z][^>]*\sstyle\s*=/i.test(transformed)) {
    throw new Error('HTML contains inline style attributes; move them into a <style> block so BotBoy can externalize them for Harmony CSP');
  }
  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(transformed)) {
    throw new Error('HTML contains inline event-handler attributes; move handlers into a <script> block so BotBoy can externalize them for Harmony CSP');
  }
  if (/\bjavascript\s*:/i.test(transformed)) throw new Error('HTML contains javascript: URLs, which are not allowed in a Harmony static artifact');
  return { html: transformed, generated, styleCount, scriptCount };
}

export function buildStaticArtifactBundle(input: BuildStaticArtifactInput): StaticArtifactBundle {
  const configuredRoot = path.resolve(input.filesRoot ?? path.join(os.homedir(), '.personal-productivity-tracker', 'files'));
  let filesRoot: string;
  try { filesRoot = fs.realpathSync(configuredRoot); } catch { throw new Error(`BotBoy files directory does not exist: ${configuredRoot}`); }
  const sourcePath = resolveSourcePath(input.filePath, filesRoot);
  const sourceDirectory = path.dirname(sourcePath);
  const sourceHtml = fs.readFileSync(sourcePath, 'utf8');
  const externalized = externalizeInlineAssets(sourceHtml);
  const slug = staticArtifactSlug(input.slug || path.basename(sourcePath));
  const files = new Map<string, Buffer>();
  const generatedPaths = new Set<string>();

  function add(relativePath: string, data: Buffer, generated: boolean): void {
    const normalized = normalizeRelativePath(relativePath, 'artifact path');
    if (!normalized) throw new Error('Artifact file path cannot be empty');
    if (files.has(normalized)) throw new Error(`Static artifact contains duplicate output path: ${normalized}`);
    files.set(normalized, data);
    if (generated) generatedPaths.add(normalized);
    if (files.size > MAX_FILE_COUNT) throw new Error(`Static artifact exceeds the ${MAX_FILE_COUNT}-file limit`);
    const total = [...files.values()].reduce((sum, value) => sum + value.length, 0);
    if (total > MAX_TOTAL_BYTES) throw new Error(`Static artifact exceeds the ${MAX_TOTAL_BYTES / 1024 / 1024} MB total limit`);
  }

  add('index.html', Buffer.from(externalized.html, 'utf8'), true);
  for (const generated of externalized.generated) add(generated.relativePath, Buffer.from(generated.content, 'utf8'), true);

  const queue: PendingAsset[] = [
    ...htmlReferences(externalized.html, sourceDirectory, filesRoot, generatedPaths),
    ...(input.assetPaths ?? []).map(assetPath => {
      const normalized = normalizeRelativePath(String(assetPath), 'assetPaths entry');
      if (!normalized) throw new Error('assetPaths entries cannot be empty');
      const source = path.resolve(sourceDirectory, normalized);
      let real: string;
      try { real = fs.realpathSync(source); } catch { throw new Error(`Additional asset is missing: ${source}`); }
      if (!isInside(sourceDirectory, real) || !isInside(filesRoot, real) || !fs.statSync(real).isFile()) {
        throw new Error(`Additional asset must be a regular file within the HTML directory: ${assetPath}`);
      }
      return { sourcePath: real, relativePath: normalized };
    }),
  ];
  for (const generated of externalized.generated.filter(file => file.relativePath.endsWith('.css'))) {
    queue.push(...cssReferences(generated.content, sourcePath, generated.relativePath, sourceDirectory, filesRoot));
  }

  const queued = new Set<string>();
  const sourceByOutputPath = new Map<string, string>();
  while (queue.length) {
    const asset = queue.shift()!;
    const key = `${asset.sourcePath}\0${asset.relativePath}`;
    if (queued.has(key)) continue;
    queued.add(key);
    if (files.has(asset.relativePath)) {
      // A generated output can never be shadowed by a source asset. Distinct
      // source files may not silently race for the same published path either.
      if (generatedPaths.has(asset.relativePath)) throw new Error(`Source asset collides with generated CSP asset: ${asset.relativePath}`);
      const previousSource = sourceByOutputPath.get(asset.relativePath);
      if (previousSource && previousSource !== asset.sourcePath) {
        throw new Error(`Distinct source assets collide at published path ${asset.relativePath}`);
      }
      continue;
    }
    const data = fs.readFileSync(asset.sourcePath);
    sourceByOutputPath.set(asset.relativePath, asset.sourcePath);
    add(asset.relativePath, data, false);
    if (/\.css$/i.test(asset.relativePath)) {
      queue.push(...cssReferences(data.toString('utf8'), asset.sourcePath, asset.relativePath, sourceDirectory, filesRoot));
    }
  }

  const manifest = [...files.entries()]
    .map(([relativePath, data]) => ({
      relativePath,
      bytes: data.length,
      sha256: sha256(data),
      generated: generatedPaths.has(relativePath),
    }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const manifestSha256 = sha256(JSON.stringify(manifest.map(file => ({ path: file.relativePath, sha256: file.sha256 }))));
  return {
    slug,
    sourcePath,
    filesRoot,
    files,
    manifest,
    manifestSha256,
    totalBytes: manifest.reduce((sum, file) => sum + file.bytes, 0),
    transformations: {
      inlineStylesExternalized: externalized.styleCount,
      inlineScriptsExternalized: externalized.scriptCount,
      localAssetsIncluded: manifest.filter(file => !file.generated).length,
    },
  };
}

export function writeStaticArtifactBundle(bundle: StaticArtifactBundle, destination: string): void {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  for (const [relativePath, data] of bundle.files) {
    const target = path.resolve(destination, relativePath);
    if (!isInside(path.resolve(destination), target)) throw new Error(`Artifact output path escaped destination: ${relativePath}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { mode: 0o600 });
  }
}
