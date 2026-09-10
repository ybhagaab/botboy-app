import { afterEach, describe, expect, it, vi } from 'vitest';
import { deflateSync, inflateSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStorage, type StorageLayer } from './storage.js';
import { createVisualAssetRegistry, VisualAssetError } from './visual-assets.js';
import { createVisualInspector, cropVisualRegionWithSips } from './visual-inspector.js';
import { LlmPayloadTooLargeError } from './llm-client.js';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  name.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return out;
}

function makePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const rgba = pixel(x, y);
      for (let c = 0; c < 4; c++) raw[row + 1 + x * 4 + c] = rgba[c];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(buffer: Buffer): { width: number; height: number; pixels: Buffer } {
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  expect(buffer[24]).toBe(8);
  expect(buffer[25]).toBe(6);
  let offset = 8;
  const idat: Buffer[] = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const input = y * (stride + 1);
    const filter = raw[input];
    for (let x = 0; x < stride; x++) {
      const current = raw[input + 1 + x];
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upperLeft = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0;
      const value = filter === 0 ? current
        : filter === 1 ? current + left
        : filter === 2 ? current + up
        : filter === 3 ? current + Math.floor((left + up) / 2)
        : current + paeth(left, up, upperLeft);
      pixels[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, pixels };
}

function pixelAt(decoded: ReturnType<typeof decodePng>, x: number, y: number): number[] {
  const i = (y * decoded.width + x) * 4;
  return [...decoded.pixels.subarray(i, i + 4)];
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-visual-test-'));
  const storage = createStorage(':memory:');
  storage.initialize();
  cleanups.push(() => { storage.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, storage, registry: createVisualAssetRegistry(storage.getDb(), { rootDir: root }) };
}

function fakeLlm(
  maximumBytes = 5_500_000,
  delayMs = 0,
  policy: { rejectOriginal?: boolean; maxRegionWidth?: number } = {},
) {
  let malformed = false;
  const requests: any[] = [];
  const metrics = (request: any) => {
    const images = request.messages.flatMap((message: any) => message.images ?? []);
    const imageChars = images.reduce((sum: number, image: string) => sum + image.length, 0);
    const bodyBytes = Buffer.byteLength(JSON.stringify(request));
    const taskText = String(request.messages.at(-1)?.content ?? '');
    const orderedText = taskText.includes('IMAGE ORDER AND PINNED UNITS:\n')
      ? taskText.split('IMAGE ORDER AND PINNED UNITS:\n')[1].split('\n\n')[0]
      : '[]';
    const ordered = JSON.parse(orderedText);
    const policyRejects = (policy.rejectOriginal && ordered.some((item: any) => item.unitKind === 'original'))
      || (policy.maxRegionWidth !== undefined && ordered.some((item: any) => item.unitKind === 'tile' && Number(item.sourceRegion?.width) > policy.maxRegionWidth!));
    if (bodyBytes > maximumBytes || policyRejects) {
      throw new LlmPayloadTooLargeError({ bodyChars: bodyBytes, bodyBytes, imageCount: images.length, imageChars }, maximumBytes);
    }
    return { bodyChars: bodyBytes, bodyBytes, imageCount: images.length, imageChars, model: 'fake-vision', apiMode: 'responses', maximumBytes, remainingBytes: maximumBytes - bodyBytes };
  };
  const client: any = {
    preflightPrimary: vi.fn(metrics),
    chatCompletionPrimary: vi.fn(async (request: any) => {
      requests.push(structuredClone(request));
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      const images = request.messages.flatMap((message: any) => message.images ?? []);
      if (!images.length) return { content: JSON.stringify({ answer: 'Merged evidence', limitations: [] }), toolCalls: null, usage: {}, finishReason: 'stop' };
      if (malformed) { malformed = false; return { content: '{bad', toolCalls: null, usage: {}, finishReason: 'stop' }; }
      const text = String(request.messages.at(-1).content);
      const ordered = JSON.parse(text.split('IMAGE ORDER AND PINNED UNITS:\n')[1].split('\n\n')[0]);
      return {
        content: JSON.stringify({ assets: ordered.map((item: any) => ({
          assetId: item.assetId,
          unitKey: item.unitKey,
          status: 'observed',
          answer: `Observed ${item.unitKey}`,
          observations: [{ finding: 'Visible pixels', evidence: 'Distinct color/content', confidence: 0.95 }],
          visibleText: [], uncertainties: [], recommendedFollowups: [],
        })) }),
        toolCalls: null, usage: {}, finishReason: 'stop',
      };
    }),
    getMaxRequestBytes: () => maximumBytes,
  };
  return { client, requests, failNextStructured: () => { malformed = true; } };
}

describe('visual asset registry', () => {
  it('preserves immutable bytes, versions producer references, and rejects corruption/path escape', () => {
    const { root, storage, registry } = fixture();
    const red = makePng(4, 3, () => [255, 0, 0, 255]);
    const first = registry.registerBuffer({ buffer: red, declaredMime: 'image/png', ownerKind: 'chat_attachment', ownerId: 'att_one' });
    expect(first.assetId).toMatch(/^va_[a-f0-9]{32}$/);
    expect(first.versionId).toMatch(/^vav_[a-f0-9]{32}$/);
    expect(registry.readOriginal(first.assetId).buffer).toEqual(red);
    expect(registry.registerBuffer({ buffer: red, declaredMime: 'image/png', ownerKind: 'chat_attachment', ownerId: 'att_one' }).versionId).toBe(first.versionId);

    const blue = makePng(4, 3, () => [0, 0, 255, 255]);
    const second = registry.registerBuffer({ buffer: blue, declaredMime: 'image/png', ownerKind: 'chat_attachment', ownerId: 'att_one' });
    expect(second.assetId).toBe(first.assetId);
    expect(second.versionId).not.toBe(first.versionId);
    expect(second.ordinal).toBe(2);
    expect(registry.readOriginal(first.assetId).buffer).toEqual(blue);
    expect(registry.readOriginal(first.assetId, first.versionId).buffer).toEqual(red);

    const resolved = registry.resolveOriginalPath(first.assetId, second.versionId);
    fs.writeFileSync(resolved.path, Buffer.from('tampered'));
    expect(() => registry.readOriginal(first.assetId, second.versionId)).toThrow(/no longer match/);

    const external = path.join(path.dirname(root), `visual-external-${Date.now()}.png`);
    fs.writeFileSync(external, red);
    cleanups.push(() => fs.rmSync(external, { force: true }));
    const link = path.join(root, 'escape.png');
    fs.symlinkSync(external, link);
    storage.getDb().prepare('UPDATE visual_asset_versions SET original_rel_path = ? WHERE id = ?').run('escape.png', first.versionId);
    expect(() => registry.readOriginal(first.assetId, first.versionId)).toThrow(VisualAssetError);
    expect(() => registry.readOriginal('../../etc/passwd')).toThrow(/Unknown visual asset/);
  });

  it('sniffs bytes rather than trusting a declared MIME', () => {
    const { registry } = fixture();
    const png = makePng(2, 2, () => [1, 2, 3, 255]);
    expect(() => registry.registerBuffer({ buffer: png, declaredMime: 'image/jpeg', ownerKind: 'chat_attachment', ownerId: 'bad-mime' })).toThrow(/does not match/);
    expect(() => registry.registerBuffer({ buffer: Buffer.from('not image'), ownerKind: 'chat_attachment', ownerId: 'bad' })).toThrow(/Only still PNG and JPEG/);
  });
});

describe('visual inspection composite', () => {
  it('co-batches full originals and anchors the arbitrary question to the owner request', async () => {
    const { storage, registry } = fixture();
    const a = registry.registerBuffer({ buffer: makePng(8, 8, () => [255, 0, 0, 255]), ownerKind: 'chat_attachment', ownerId: 'a' });
    const b = registry.registerBuffer({ buffer: makePng(8, 8, () => [0, 0, 255, 255]), ownerKind: 'chat_attachment', ownerId: 'b' });
    const fake = fakeLlm();
    const inspector = createVisualInspector({ db: storage.getDb(), registry, llmClient: fake.client });
    const receipt = await inspector.inspect({ assetIds: [a.assetId, b.assetId], question: 'What differs?', ownerRequest: 'Compare my two attached states.', callerKind: 'interactive' });
    expect(receipt.comparisonMode).toBe('co_batch');
    expect(receipt.coverage).toMatchObject({ unit: 'original', eligible: 2, inspected: 2, complete: true });
    expect(fake.requests[0].messages.at(-1).content).toContain('Compare my two attached states.');
    expect(fake.requests[0].messages.at(-1).content).toContain('What differs?');
    expect(fake.requests[0].messages.at(-1).images).toHaveLength(2);
  });

  it('splits a multi-image body above the visual co-batch ceiling while preserving both originals', async () => {
    const { storage, registry } = fixture();
    const a = registry.registerBuffer({ buffer: makePng(8, 8, () => [255, 0, 0, 255]), ownerKind: 'chat_attachment', ownerId: 'split-a' });
    const b = registry.registerBuffer({ buffer: makePng(8, 8, () => [0, 0, 255, 255]), ownerKind: 'chat_attachment', ownerId: 'split-b' });
    const fake = fakeLlm();
    const measure = fake.client.preflightPrimary.getMockImplementation();
    fake.client.preflightPrimary.mockImplementation((request: any) => {
      const measured = measure(request);
      return measured.imageCount === 2
        ? { ...measured, bodyChars: 2_500_001, bodyBytes: 2_500_001, remainingBytes: measured.maximumBytes - 2_500_001 }
        : measured;
    });
    const inspector = createVisualInspector({ db: storage.getDb(), registry, llmClient: fake.client });
    const receipt = await inspector.inspect({ assetIds: [a.assetId, b.assetId], question: 'What differs?', ownerRequest: 'Compare both originals.', callerKind: 'interactive' });
    const imageBearingRequests = fake.requests.filter(request =>
      request.messages.some((message: any) => (message.images?.length ?? 0) > 0));

    expect(receipt.comparisonMode).toBe('observation_merge');
    expect(receipt.coverage).toMatchObject({ unit: 'original', eligible: 2, inspected: 2, complete: true });
    expect(imageBearingRequests.map(request => request.messages.flatMap((message: any) => message.images ?? []).length)).toEqual([1, 1]);
    expect(receipt.limitations).toContain('Images could not fit in one provider request; cross-image conclusions were synthesized from separately validated observations.');
  });

  it('keeps one full original on the provider gate above the multi-image ceiling', async () => {
    const { storage, registry } = fixture();
    const asset = registry.registerBuffer({ buffer: makePng(8, 8, () => [1, 2, 3, 255]), ownerKind: 'chat_attachment', ownerId: 'single' });
    const fake = fakeLlm();
    const measure = fake.client.preflightPrimary.getMockImplementation();
    fake.client.preflightPrimary.mockImplementation((request: any) => {
      const measured = measure(request);
      return measured.imageCount === 1
        ? { ...measured, bodyChars: 3_000_000, bodyBytes: 3_000_000, remainingBytes: measured.maximumBytes - 3_000_000 }
        : measured;
    });
    const inspector = createVisualInspector({ db: storage.getDb(), registry, llmClient: fake.client });
    const receipt = await inspector.inspect({ assetIds: [asset.assetId], question: 'What is visible?', ownerRequest: 'Inspect the original.', callerKind: 'interactive' });

    expect(receipt.comparisonMode).toBe('co_batch');
    expect(receipt.coverage).toMatchObject({ unit: 'original', eligible: 1, inspected: 1, complete: true });
    expect(fake.requests[0].messages.at(-1).images).toHaveLength(1);
  });

  it('forces complete recursively split native coverage, retries malformed JSON once, and excludes overview from final evidence', async () => {
    const { root, storage, registry } = fixture();
    const noisy = makePng(512, 128, (x, y) => [(x * 47 + y * 13) & 255, (x * 19 + y * 61) & 255, (x * 83 + y * 7) & 255, 255]);
    const asset = registry.registerBuffer({ buffer: noisy, ownerKind: 'browser_screenshot', ownerId: 'large' });
    const fake = fakeLlm(5_500_000, 0, { rejectOriginal: true, maxRegionWidth: 256 });
    fake.failNextStructured();
    const inspector = createVisualInspector({ db: storage.getDb(), registry, llmClient: fake.client, rootDir: root });
    const receipt = await inspector.inspect({ assetIds: [asset.assetId], question: 'Read every region.', ownerRequest: 'Inspect the full image.', callerKind: 'interactive' });
    expect(receipt.coverage.unit).toBe('source_region');
    expect(receipt.coverage.complete).toBe(true);
    expect(receipt.coverage.eligible).toBe(receipt.evidence.length);
    expect(receipt.evidence.every(item => item.unitKey.startsWith('tile:'))).toBe(true);
    const area = receipt.evidence.reduce((sum, item) => sum + item.sourceRegion.width * item.sourceRegion.height, 0);
    expect(area).toBe(512 * 128);
    expect(fake.client.chatCompletionPrimary.mock.calls.length).toBeGreaterThan(receipt.coverage.eligible);
  });

  it('collapses concurrent identical requests onto one durable run', async () => {
    const { storage, registry } = fixture();
    const asset = registry.registerBuffer({ buffer: makePng(8, 8, () => [1, 2, 3, 255]), ownerKind: 'chat_attachment', ownerId: 'same' });
    const fake = fakeLlm(5_500_000, 30);
    const inspector = createVisualInspector({ db: storage.getDb(), registry, llmClient: fake.client });
    const input = { assetIds: [asset.assetId], question: 'What is visible?', ownerRequest: 'Inspect it.', callerKind: 'interactive' as const };
    const [one, two] = await Promise.all([inspector.inspect(input), inspector.inspect(input)]);
    expect(one.runId).toBe(two.runId);
    expect(fake.client.chatCompletionPrimary).toHaveBeenCalledTimes(1);
    const runs = storage.getDb().prepare('SELECT COUNT(*) AS n FROM visual_inspection_runs').get() as any;
    expect(runs.n).toBe(1);
  });
});

describe('sips crop provenance', () => {
  it('uses top-left x/y offsets in the documented order', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-sips-crop-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source.png');
    const destination = path.join(root, 'crop.png');
    fs.writeFileSync(source, makePng(8, 4, x => x < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    await cropVisualRegionWithSips({ source, destination, region: { x: 4, y: 0, width: 4, height: 4 }, mime: 'image/png' });
    const decoded = decodePng(fs.readFileSync(destination));
    expect([decoded.width, decoded.height]).toEqual([4, 4]);
    expect(pixelAt(decoded, 0, 0)).toEqual([0, 0, 255, 255]);
    expect(pixelAt(decoded, 3, 3)).toEqual([0, 0, 255, 255]);
  });
});
