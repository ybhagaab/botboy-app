import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANTHROPIC_KEY_PATTERN,
  ANTHROPIC_MAX_MODEL_PAGES,
  ANTHROPIC_MAX_STORED_MODELS,
  ANTHROPIC_VERSION,
  AUTH_STYLE,
  KNOWN_PROFILES,
  THINKING_ALLOWANCE,
  anthropicRequestHeaders,
  anthropicVerificationCandidates,
  deriveProfile,
  isAnthropicAdminKey,
  isAnthropicApiKey,
  knownProfileId,
  listAnthropicModels,
  logProfileDisagreementsOnce,
  looksLikeAnthropicKey,
  parseAnthropicModel,
  parseAnthropicModelPage,
  parseStoredAnthropicModels,
  pickAnthropicDefaultModel,
  pickAnthropicProcessingModel,
  resetProfileDisagreementLog,
  selectOfferedModels,
  shapeThinking,
  verifyKey,
  type AnthropicModelProfile,
  type AnthropicProfileKind,
} from './anthropic-models.js';
import { AnthropicApiError, AnthropicUnreachableError } from './anthropic-errors.js';
import {
  FAKE_ANTHROPIC_KEY,
  FAKE_D10_ROWS,
  fakeErrorBody,
  fakeCapabilities,
  fakeModelRow,
  startFakeAnthropic,
  validateFakeMessagesBody,
  type FakeAnthropicServer,
  type FakeCapabilityVariant,
  type FakeModelSpec,
} from './anthropic-api.fake.js';

/**
 * Design v3 D2 / D8 / D10 (slice A1): key shape, the key's own model list,
 * profile derivation with known-id tightening, thinking shaping, default
 * picks, paging, and Save-time verification, against a fake Anthropic API.
 * Test keys are assembled at runtime; nothing here is a realistic key literal.
 */
const keyWith = (tail: string) => ['sk', 'ant', 'api03', tail].join('-');
const WRONG_KEY = keyWith('wrongkey'.repeat(4));

const profileOf = (spec: FakeModelSpec): AnthropicModelProfile => {
  const parsed = parseAnthropicModel(fakeModelRow(spec));
  if (!parsed) throw new Error(`fake spec ${spec.id} did not parse`);
  return parsed;
};

describe('key shape (D10)', () => {
  it('accepts regular keys and refuses admin keys, short tails, and other vendors', () => {
    expect(isAnthropicApiKey(FAKE_ANTHROPIC_KEY)).toBe(true);
    expect(isAnthropicApiKey(keyWith('x'.repeat(16)))).toBe(true);
    expect(isAnthropicApiKey(keyWith('x'.repeat(15)))).toBe(false);
    expect(isAnthropicApiKey(keyWith('x'.repeat(400)))).toBe(true);
    expect(isAnthropicApiKey(keyWith('x'.repeat(401)))).toBe(false);
    expect(isAnthropicApiKey(['sk', 'ant', 'admin01', 'x'.repeat(40)].join('-'))).toBe(false);
    expect(isAnthropicApiKey(['sk', 'proj', 'x'.repeat(40)].join('-'))).toBe(false);
    expect(isAnthropicApiKey(`${FAKE_ANTHROPIC_KEY}\n`)).toBe(false);
    expect(isAnthropicApiKey(`${FAKE_ANTHROPIC_KEY} x`)).toBe(false);
    expect(isAnthropicApiKey(42)).toBe(false);
    expect(isAnthropicApiKey(undefined)).toBe(false);
    expect(ANTHROPIC_KEY_PATTERN.source).toContain('(?!admin)');
  });

  it('recognizes admin keys and any Anthropic-looking key for wrong-card routing', () => {
    const admin = ['sk', 'ant', 'admin01', 'y'.repeat(40)].join('-');
    expect(isAnthropicAdminKey(admin)).toBe(true);
    expect(isAnthropicAdminKey(FAKE_ANTHROPIC_KEY)).toBe(false);
    expect(looksLikeAnthropicKey(admin)).toBe(true);
    expect(looksLikeAnthropicKey(FAKE_ANTHROPIC_KEY)).toBe(true);
    expect(looksLikeAnthropicKey(['sk', 'proj', 'z'.repeat(40)].join('-'))).toBe(false);
  });

  it('builds headers only from a valid key, with the pinned version and no beta header', () => {
    expect(AUTH_STYLE).toBe('x-api-key');
    expect(anthropicRequestHeaders(FAKE_ANTHROPIC_KEY)).toEqual({ 'x-api-key': FAKE_ANTHROPIC_KEY, 'anthropic-version': ANTHROPIC_VERSION });
    expect(anthropicRequestHeaders(FAKE_ANTHROPIC_KEY, { json: true })['content-type']).toBe('application/json');
    expect(anthropicRequestHeaders(FAKE_ANTHROPIC_KEY, { style: 'bearer' })).toEqual({ Authorization: `Bearer ${FAKE_ANTHROPIC_KEY}`, 'anthropic-version': '2023-06-01' });
    expect(Object.keys(anthropicRequestHeaders(FAKE_ANTHROPIC_KEY, { json: true })).some(name => /beta/i.test(name))).toBe(false);
    // No header can be built from an unvalidated string.
    for (const bad of ['', 'not-a-key', `${FAKE_ANTHROPIC_KEY}\r\nx-injected: 1`, ['sk', 'proj', 'q'.repeat(40)].join('-')]) {
      expect(() => anthropicRequestHeaders(bad)).toThrow(/not an Anthropic API key/);
    }
  });
});

describe('parsing a model list (S6)', () => {
  it('reads the four capability variants and derives their facts', () => {
    const A = profileOf({ id: 'claude-sonnet-5-5', line: 'sonnet', variant: 'A', name: 'Claude Sonnet 5.5' });
    expect(A).toMatchObject({
      id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', line: 'sonnet', lifecycle: 'active', retiresAt: null,
      contextWindow: 1_000_000, maxOutputTokens: 128_000, images: true, structuredOutputs: true,
      thinking: { adaptive: true, enabled: false, disabled: false },
      effort: { low: true, medium: true, high: true, xhigh: true, max: true },
    });
    expect(profileOf({ id: 'b', variant: 'B' }).thinking).toEqual({ adaptive: true, enabled: false, disabled: true });
    expect(profileOf({ id: 'c', variant: 'C' }).thinking).toEqual({ adaptive: false, enabled: true, disabled: true });
    // No thinking support: the sub-flags are not trusted (the API reports disabled=true there).
    const D = profileOf({ id: 'd', variant: 'D' });
    expect(D.thinking).toEqual({ adaptive: false, enabled: false, disabled: false });
    expect(D.effort).toEqual({ low: false, medium: false, high: false, xhigh: false, max: false });
  });

  it('treats capabilities: null as unknown: no thinking, no effort, no schemas, images allowed, output capped at 16,384', () => {
    const unknown = profileOf({ id: 'claude-future', variant: 'null' });
    expect(unknown.images).toBeUndefined();
    expect(unknown.structuredOutputs).toBe(false);
    expect(unknown.thinking).toEqual({ adaptive: false, enabled: false, disabled: false });
    expect(unknown.effort).toEqual({ low: false, medium: false, high: false, xhigh: false, max: false });
    expect(unknown.maxOutputTokens).toBe(16_384);
    expect(deriveProfile(unknown)).toMatchObject({ kind: 'D', thinkingOff: 'unavailable', prefixCheck: false });
  });

  it('reads non-positive, non-integer, and null limits as unknown (200,000 window, 16,384 output)', () => {
    for (const bad of [0, -5, 1.5, null, '2000', Number.NaN, 1e12]) {
      const profile = profileOf({ id: 'limits', variant: 'A', maxInputTokens: bad as any, maxTokens: bad as any });
      expect(profile.contextWindow, String(bad)).toBe(200_000);
      expect(profile.maxOutputTokens, String(bad)).toBe(16_384);
    }
    expect(profileOf({ id: 'ok', variant: 'A', maxInputTokens: 123_456, maxTokens: 64_000 })).toMatchObject({ contextWindow: 123_456, maxOutputTokens: 64_000 });
  });

  it('keeps images unknown when the capability is silent, and false when the model refuses images', () => {
    const silent = parseAnthropicModel({ id: 'silent', capabilities: { thinking: { supported: false } } })!;
    expect(silent.images).toBeUndefined();
    expect(profileOf({ id: 'text-only', variant: 'A', images: false }).images).toBe(false);
  });

  it('skips rows without a valid id and sanitizes names, lines, lifecycle and dates', () => {
    expect(parseAnthropicModel({ display_name: 'no id' })).toBeUndefined();
    expect(parseAnthropicModel({ id: 'has space' })).toBeUndefined();
    expect(parseAnthropicModel({ id: 'a'.repeat(161) })).toBeUndefined();
    expect(parseAnthropicModel(null)).toBeUndefined();
    const messy = parseAnthropicModel({
      id: 'claude-x', display_name: '  Claude\u0007  X\u0000  Name  ', line: 'Not A Line!', lifecycle: 'preview', retires_at: 'tomorrow-ish',
    })!;
    expect(messy).toMatchObject({ name: 'Claude X Name', line: null, lifecycle: 'active', retiresAt: null });
    expect(parseAnthropicModel({ id: 'claude-y', line: 'gemstone', lifecycle: 'deprecated', retires_at: '2026-12-01T00:00:00Z' }))
      .toMatchObject({ line: 'gemstone', lifecycle: 'deprecated', retiresAt: '2026-12-01T00:00:00Z' });
    expect(parseAnthropicModel({ id: 'z', display_name: 'n'.repeat(500) })!.name).toHaveLength(80);
  });

  it('reads a page and refuses a body without a data array', () => {
    const page = parseAnthropicModelPage({
      data: [fakeModelRow({ id: 'one', variant: 'A' }), { nope: true }, fakeModelRow({ id: 'two', variant: 'B' })],
      has_more: true,
      last_id: 'two',
    });
    expect(page.models.map(model => model.id)).toEqual(['one', 'two']);
    expect(page).toMatchObject({ hasMore: true, lastId: 'two' });
    expect(parseAnthropicModelPage({ data: [], has_more: 'yes', last_id: 'bad id' })).toMatchObject({ hasMore: false, lastId: null });
    for (const body of [null, {}, { data: 'x' }, []]) expect(() => parseAnthropicModelPage(body)).toThrow('unreadable model list');
  });

  it('round-trips stored profiles through JSON and drops invalid stored rows', () => {
    const profiles = [
      profileOf({ id: 'claude-sonnet-5-5', line: 'sonnet', variant: 'A' }),
      profileOf({ id: 'claude-future', variant: 'null' }),
      profileOf({ id: 'claude-old', variant: 'C', lifecycle: 'deprecated', retiresAt: '2026-11-30T00:00:00Z', maxTokens: 64_000 }),
    ];
    expect(parseStoredAnthropicModels(JSON.parse(JSON.stringify(profiles)))).toEqual(profiles);
    expect(parseStoredAnthropicModels([{ id: 'ok' }, { id: 'ok' }, { id: 'bad id' }, null, 7])).toHaveLength(1);
    expect(parseStoredAnthropicModels('nope')).toEqual([]);
    expect(parseStoredAnthropicModels(Array.from({ length: 300 }, (_, i) => ({ id: `m${i}` })))).toHaveLength(ANTHROPIC_MAX_STORED_MODELS);
  });
});

// The thinking table (S3), troubleshooting table (S4) and effort page (S5), written out by hand. The rows build
// `capabilities` the way the Models API reports them; the derived profile must equal the documented one.
interface Documented {
  id: string;
  types: 'adaptive' | 'adaptive+extended' | 'extended';
  disabled: boolean;
  effort: 'all' | 'to_max' | 'no_max' | 'none';
  kind: Exclude<AnthropicProfileKind, 'D'>;
  prefixCheck: boolean;
}
const DOCUMENTED: readonly Documented[] = [
  { id: 'claude-fable-5-1', types: 'adaptive', disabled: false, effort: 'all', kind: 'A', prefixCheck: true },
  { id: 'claude-mythos-5-1', types: 'adaptive', disabled: false, effort: 'all', kind: 'A', prefixCheck: false },
  { id: 'claude-fable-5', types: 'adaptive', disabled: false, effort: 'all', kind: 'A', prefixCheck: false },
  { id: 'claude-mythos-5', types: 'adaptive', disabled: false, effort: 'all', kind: 'A', prefixCheck: false },
  { id: 'claude-mythos-preview', types: 'adaptive+extended', disabled: false, effort: 'to_max', kind: 'A', prefixCheck: false },
  { id: 'claude-opus-5-5', types: 'adaptive', disabled: false, effort: 'all', kind: 'A', prefixCheck: true },
  { id: 'claude-opus-5', types: 'adaptive', disabled: true, effort: 'all', kind: 'B', prefixCheck: false },
  { id: 'claude-opus-4-8', types: 'adaptive', disabled: true, effort: 'all', kind: 'B', prefixCheck: false },
  { id: 'claude-opus-4-7', types: 'adaptive', disabled: true, effort: 'all', kind: 'B', prefixCheck: false },
  { id: 'claude-sonnet-5-5', types: 'adaptive', disabled: false, effort: 'all', kind: 'A', prefixCheck: true },
  { id: 'claude-sonnet-5', types: 'adaptive', disabled: true, effort: 'all', kind: 'B', prefixCheck: false },
  { id: 'claude-haiku-5-5', types: 'adaptive', disabled: true, effort: 'all', kind: 'B', prefixCheck: true },
  { id: 'claude-opus-4-6', types: 'adaptive+extended', disabled: true, effort: 'to_max', kind: 'B', prefixCheck: false },
  { id: 'claude-sonnet-4-6', types: 'adaptive+extended', disabled: true, effort: 'to_max', kind: 'B', prefixCheck: false },
  { id: 'claude-opus-4-5', types: 'extended', disabled: true, effort: 'no_max', kind: 'C', prefixCheck: false },
  { id: 'claude-haiku-4-5', types: 'extended', disabled: true, effort: 'none', kind: 'C', prefixCheck: false },
  { id: 'claude-sonnet-4-5', types: 'extended', disabled: true, effort: 'none', kind: 'C', prefixCheck: false },
];
const EFFORT_LADDERS = {
  all: { low: true, medium: true, high: true, xhigh: true, max: true },
  to_max: { low: true, medium: true, high: true, xhigh: false, max: true },
  no_max: { low: true, medium: true, high: true, xhigh: false, max: false },
  none: { low: false, medium: false, high: false, xhigh: false, max: false },
} as const;
const THINKING_OFF_OF = { A: 'lowest_effort', B: 'native_without_tools', C: 'native', D: 'unavailable' } as const;

/** The raw row a documented model would have, built from the docs columns only (not from KNOWN_PROFILES). */
function documentedRow(entry: Documented, overrides: { id?: string } = {}): Record<string, unknown> {
  const adaptive = entry.types !== 'extended';
  const enabled = entry.types !== 'adaptive';
  const ladder = EFFORT_LADDERS[entry.effort];
  return {
    ...fakeModelRow({ id: overrides.id ?? entry.id, variant: 'A', line: null }),
    capabilities: {
      ...(fakeCapabilities('A', { effort: ladder }) as Record<string, unknown>),
      effort: {
        supported: entry.effort !== 'none',
        low: { supported: ladder.low }, medium: { supported: ladder.medium }, high: { supported: ladder.high },
        xhigh: { supported: ladder.xhigh }, max: { supported: ladder.max },
      },
      thinking: {
        supported: true,
        types: { adaptive: { supported: adaptive }, enabled: { supported: enabled }, disabled: { supported: entry.disabled } },
      },
    },
  };
}

describe('profile derivation (D2)', () => {
  it('derives every documented model to its documented profile, thinking-off mode, effort ladder and prefix-check', () => {
    for (const entry of DOCUMENTED) {
      const derived = deriveProfile(parseAnthropicModel(documentedRow(entry))!);
      expect(derived, entry.id).toMatchObject({
        kind: entry.kind, thinkingOff: THINKING_OFF_OF[entry.kind], prefixCheck: entry.prefixCheck, known: true,
        effort: EFFORT_LADDERS[entry.effort],
      });
      // The documented capabilities and the known table agree.
      expect(derived.disagreements, entry.id).toEqual([]);
    }
  });

  it('keeps the known table in step with the documented tables: the same ids, no more and no fewer', () => {
    expect(Object.keys(KNOWN_PROFILES).sort()).toEqual(DOCUMENTED.map(entry => entry.id).sort());
    for (const entry of DOCUMENTED) {
      expect(KNOWN_PROFILES[entry.id].prefixCheck, entry.id).toBe(entry.prefixCheck);
    }
    // Only Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 run the prefix check.
    expect(Object.entries(KNOWN_PROFILES).filter(([, known]) => known.prefixCheck).map(([id]) => id).sort())
      .toEqual(['claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
  });

  it('derives all four profiles from synthetic capabilities for an unknown id', () => {
    const kinds = (['A', 'B', 'C', 'D', 'null'] as FakeCapabilityVariant[]).map(variant =>
      deriveProfile(profileOf({ id: `claude-unknown-${variant.toLowerCase()}`, variant })).kind);
    expect(kinds).toEqual(['A', 'B', 'C', 'D', 'D']);
  });

  it('runs the prefix check for unknown adaptive ids and for no other unknown id', () => {
    const prefix = (variant: FakeCapabilityVariant) => deriveProfile(profileOf({ id: 'claude-unknown-9', variant })).prefixCheck;
    expect({ A: prefix('A'), B: prefix('B'), C: prefix('C'), D: prefix('D'), null: prefix('null') })
      .toEqual({ A: true, B: true, C: false, D: false, null: false });
  });

  it('matches a dated snapshot id to its table row, and never an inherited property', () => {
    expect(knownProfileId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(knownProfileId('claude-opus-5-5')).toBe('claude-opus-5-5');
    const dated = deriveProfile(parseAnthropicModel(documentedRow(DOCUMENTED.find(entry => entry.id === 'claude-haiku-4-5')!, { id: 'claude-haiku-4-5-20251001' }))!);
    expect(dated).toMatchObject({ kind: 'C', known: true });
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const derived = deriveProfile(profileOf({ id, variant: 'B' }));
      expect(derived, id).toMatchObject({ known: false, kind: 'B', prefixCheck: true });
    }
  });

  it('sends the stricter shape for a known id when capabilities allow more than the table (a form the docs refuse)', () => {
    // Opus 5.5 always thinks: `disabled` is a 400. A key whose capabilities claim otherwise must not make BotBoy send it.
    const claimsMore = parseAnthropicModel(documentedRow({ ...DOCUMENTED.find(entry => entry.id === 'claude-opus-5-5')!, disabled: true }))!;
    expect(claimsMore.thinking.disabled).toBe(true);
    const derived = deriveProfile(claimsMore);
    expect(derived).toMatchObject({ kind: 'A', thinkingOff: 'lowest_effort', thinking: { disabled: false } });
    expect(derived.disagreements).toEqual([{ form: 'thinking.disabled', capabilities: true, table: false }]);
    const shaped = shapeThinking(claimsMore, { level: 'off', tools: false, maxTokens: 1_000 });
    expect(shaped.thinking).toBeUndefined();
    expect(shaped.effort).toBe('low');

    // The same for effort: Opus 4.5 has no max.
    const opus45 = DOCUMENTED.find(entry => entry.id === 'claude-opus-4-5')!;
    const claimsMax = parseAnthropicModel(documentedRow({ ...opus45, effort: 'to_max' }))!;
    expect(deriveProfile(claimsMax).effort.max).toBe(false);
    expect(shapeThinking(claimsMax, { level: 'max', tools: false, maxTokens: 1_000 }).effort).toBe('high');
  });

  it('lets capabilities refuse what the table would allow (capabilities AND table)', () => {
    const refuses = parseAnthropicModel(documentedRow({ ...DOCUMENTED.find(entry => entry.id === 'claude-opus-5')!, disabled: false }))!;
    expect(deriveProfile(refuses)).toMatchObject({ kind: 'A', thinking: { disabled: false } });
    expect(deriveProfile(refuses).disagreements).toEqual([{ form: 'thinking.disabled', capabilities: false, table: true }]);
    // A known id whose capabilities are null falls to D, whatever the table says.
    expect(deriveProfile(parseAnthropicModel({ ...fakeModelRow({ id: 'claude-opus-5-5', variant: 'A' }), capabilities: null })!)).toMatchObject({ kind: 'D', prefixCheck: false });
  });

  it('logs a disagreement once per model id per process', () => {
    resetProfileDisagreementLog();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const claimsMore = parseAnthropicModel(documentedRow({ ...DOCUMENTED.find(entry => entry.id === 'claude-opus-5-5')!, disabled: true }))!;
    logProfileDisagreementsOnce(deriveProfile(claimsMore));
    logProfileDisagreementsOnce(deriveProfile(claimsMore));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('claude-opus-5-5');
    expect(String(warn.mock.calls[0][0])).toContain('thinking.disabled');
    // Agreement logs nothing.
    logProfileDisagreementsOnce(deriveProfile(parseAnthropicModel(documentedRow(DOCUMENTED[0]))!));
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    resetProfileDisagreementLog();
  });
});

describe('shapeThinking (D2 table)', () => {
  const sonnet55 = profileOf({ id: 'claude-sonnet-5-5', variant: 'A' });
  const haiku55 = profileOf({ id: 'claude-haiku-5-5', variant: 'B' });
  const haiku45 = profileOf({ id: 'claude-haiku-4-5-20251001', variant: 'C', maxTokens: 64_000, maxInputTokens: 200_000 });
  const opus45 = profileOf({ id: 'claude-opus-4-5-20251101', variant: 'C', effort: { low: true, medium: true, high: true }, maxTokens: 64_000, maxInputTokens: 200_000 });
  const none = profileOf({ id: 'claude-future', variant: 'null' });
  const noThinking = profileOf({ id: 'claude-plain', variant: 'D', maxTokens: 8_192 });
  const REQUESTED = 4_096;
  const shape = (profile: AnthropicModelProfile, level: 'off' | 'low' | 'high' | 'max', tools: boolean, display?: 'summarized' | 'omitted') =>
    shapeThinking(profile, { level, tools, maxTokens: REQUESTED, ...(display ? { display } : {}) });

  it('profile A: Off omits thinking and uses the lowest effort; levels use adaptive thinking with low / high / max effort', () => {
    for (const tools of [false, true]) {
      expect(shape(sonnet55, 'off', tools)).toEqual({ effort: 'low', maxTokens: REQUESTED + 2_048, allowance: 2_048 });
      expect(shape(sonnet55, 'low', tools)).toEqual({ thinking: { type: 'adaptive', display: 'omitted' }, effort: 'low', maxTokens: REQUESTED + 2_048, allowance: 2_048 });
      expect(shape(sonnet55, 'high', tools)).toEqual({ thinking: { type: 'adaptive', display: 'omitted' }, effort: 'high', maxTokens: REQUESTED + 8_192, allowance: 8_192 });
      expect(shape(sonnet55, 'max', tools)).toEqual({ thinking: { type: 'adaptive', display: 'omitted' }, effort: 'max', maxTokens: REQUESTED + 24_576, allowance: 24_576 });
    }
    expect(shape(sonnet55, 'high', true, 'summarized').thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('profile B: Off is native disabled without tools (no effort), and the lowest effort with tools', () => {
    expect(shape(haiku55, 'off', false)).toEqual({ thinking: { type: 'disabled' }, maxTokens: REQUESTED, allowance: 0 });
    expect(shape(haiku55, 'off', false)).not.toHaveProperty('effort');
    expect(shape(haiku55, 'off', true)).toEqual({ effort: 'low', maxTokens: REQUESTED + 2_048, allowance: 2_048 });
    expect(shape(haiku55, 'off', true)).not.toHaveProperty('thinking');
    for (const tools of [false, true]) {
      expect(shape(haiku55, 'high', tools)).toEqual({ thinking: { type: 'adaptive', display: 'omitted' }, effort: 'high', maxTokens: REQUESTED + 8_192, allowance: 8_192 });
      expect(shape(haiku55, 'max', tools).effort).toBe('max');
    }
  });

  it('profile C: Off omits everything; levels use a manual budget of 2,048 / 8,192 / 24,576 below max_tokens, with effort only where supported', () => {
    expect(shape(haiku45, 'off', false)).toEqual({ maxTokens: REQUESTED, allowance: 0 });
    expect(shape(haiku45, 'off', true)).toEqual({ maxTokens: REQUESTED, allowance: 0 });
    expect(shape(haiku45, 'low', false)).toEqual({ thinking: { type: 'enabled', budget_tokens: 2_048 }, maxTokens: REQUESTED + 2_048, allowance: 2_048 });
    expect(shape(haiku45, 'high', true)).toEqual({ thinking: { type: 'enabled', budget_tokens: 8_192 }, maxTokens: REQUESTED + 8_192, allowance: 8_192 });
    expect(shape(haiku45, 'max', false)).toEqual({ thinking: { type: 'enabled', budget_tokens: 24_576 }, maxTokens: REQUESTED + 24_576, allowance: 24_576 });
    // Opus 4.5 also takes effort, and max falls back to high.
    expect(shape(opus45, 'low', true).effort).toBe('low');
    expect(shape(opus45, 'high', true).effort).toBe('high');
    expect(shape(opus45, 'max', true)).toMatchObject({ effort: 'high', thinking: { type: 'enabled', budget_tokens: 24_576 } });
    expect(shape(opus45, 'off', true)).toEqual({ maxTokens: REQUESTED, allowance: 0 });
  });

  it('profile D and unknown models: nothing is sent, and the output cap stays conservative', () => {
    for (const profile of [none, noThinking]) {
      for (const level of ['off', 'low', 'high', 'max'] as const) {
        for (const tools of [false, true]) {
          const shaped = shape(profile, level, tools);
          expect(shaped.thinking, `${profile.id} ${level}`).toBeUndefined();
          expect(shaped.effort, `${profile.id} ${level}`).toBeUndefined();
          expect(shaped.allowance).toBe(0);
        }
      }
    }
    expect(shapeThinking(none, { level: 'max', tools: true, maxTokens: 100_000 }).maxTokens).toBe(16_384);
    expect(shapeThinking(noThinking, { level: 'off', tools: false, maxTokens: 100_000 }).maxTokens).toBe(8_192);
  });

  it('clamps max_tokens to the model maximum and keeps a manual budget valid (at least 1,024, below max_tokens)', () => {
    // Adaptive models: the headroom actually added is reported.
    expect(shapeThinking(sonnet55, { level: 'max', tools: true, maxTokens: 120_000 })).toMatchObject({ maxTokens: 128_000, allowance: 8_000 });
    expect(shapeThinking(sonnet55, { level: 'off', tools: true, maxTokens: 500_000 })).toMatchObject({ maxTokens: 128_000, allowance: 0 });
    const small = profileOf({ id: 'claude-small-4-5', variant: 'C', maxTokens: 10_000, maxInputTokens: 200_000 });
    // Extended-only: thinking gets what remains above the requested answer room.
    expect(shapeThinking(small, { level: 'max', tools: false, maxTokens: 8_000 })).toEqual({
      thinking: { type: 'enabled', budget_tokens: 2_000 }, maxTokens: 10_000, allowance: 2_000,
    });
    // Under 1,024 of room: no thinking, and the answer keeps its room.
    expect(shapeThinking(small, { level: 'max', tools: false, maxTokens: 9_500 })).toEqual({ maxTokens: 9_500, allowance: 0 });
    const tiny = profileOf({ id: 'claude-tiny-4-5', variant: 'C', maxTokens: 1_500, maxInputTokens: 200_000 });
    expect(shapeThinking(tiny, { level: 'low', tools: false, maxTokens: 1_400 })).toEqual({ maxTokens: 1_400, allowance: 0 });
    expect(shapeThinking(tiny, { level: 'low', tools: false, maxTokens: 100_000 })).toEqual({ maxTokens: 1_500, allowance: 0 });
    // A budget is always below max_tokens.
    for (const maxTokens of [1, 500, 1_024, 5_000, 63_000]) {
      for (const level of ['low', 'high', 'max'] as const) {
        const shaped = shapeThinking(haiku45, { level, tools: false, maxTokens });
        if (shaped.thinking?.type === 'enabled') {
          expect(shaped.thinking.budget_tokens).toBeGreaterThanOrEqual(1_024);
          expect(shaped.thinking.budget_tokens).toBeLessThan(shaped.maxTokens);
        }
      }
    }
    // Nonsense requests still yield a valid positive max_tokens.
    for (const maxTokens of [Number.NaN, -3, 0, Number.POSITIVE_INFINITY]) {
      expect(shapeThinking(sonnet55, { level: 'off', tools: false, maxTokens }).maxTokens).toBeGreaterThanOrEqual(1);
    }
  });

  it('never sends xhigh, never sends effort next to disabled, and the allowances match the table', () => {
    expect(THINKING_ALLOWANCE).toEqual({ low: 2_048, high: 8_192, max: 24_576 });
    for (const profile of [sonnet55, haiku55, haiku45, opus45, none, noThinking]) {
      for (const level of ['off', 'low', 'high', 'max'] as const) {
        for (const tools of [false, true]) {
          const shaped = shape(profile, level, tools);
          expect(shaped.effort, `${profile.id} ${level} ${tools}`).not.toBe('xhigh');
          if (shaped.thinking?.type === 'disabled') expect(shaped).not.toHaveProperty('effort');
        }
      }
    }
  });

  it('never produces a request the model itself refuses (checked against each model\'s own capabilities)', () => {
    const rows = [
      ...DOCUMENTED.map(entry => documentedRow(entry)),
      fakeModelRow({ id: 'unknown-a', variant: 'A' }), fakeModelRow({ id: 'unknown-b', variant: 'B' }),
      fakeModelRow({ id: 'unknown-c', variant: 'C', maxTokens: 64_000 }), fakeModelRow({ id: 'unknown-d', variant: 'D' }),
      fakeModelRow({ id: 'unknown-null', variant: 'null' }),
    ];
    let checked = 0;
    for (const row of rows) {
      const profile = parseAnthropicModel(row)!;
      for (const level of ['off', 'low', 'high', 'max'] as const) {
        for (const tools of [false, true]) {
          for (const display of ['omitted', 'summarized'] as const) {
            for (const maxTokens of [1, 4_096, 200_000]) {
              const shaped = shapeThinking(profile, { level, tools, maxTokens, display });
              const body = {
                max_tokens: shaped.maxTokens,
                ...(shaped.thinking ? { thinking: shaped.thinking } : {}),
                ...(shaped.effort ? { output_config: { effort: shaped.effort } } : {}),
              };
              expect(validateFakeMessagesBody(row as any, body), `${profile.id} ${level} tools=${tools} max=${maxTokens}`).toBeUndefined();
              checked += 1;
            }
          }
        }
      }
    }
    expect(checked).toBe(rows.length * 4 * 2 * 2 * 3);
  });

  it('is rejected by the fake exactly where the docs say (the validator is not vacuous)', () => {
    const rowA = documentedRow(DOCUMENTED.find(entry => entry.id === 'claude-opus-5-5')!) as any;
    const rowB = documentedRow(DOCUMENTED.find(entry => entry.id === 'claude-haiku-5-5')!) as any;
    const rowC = documentedRow(DOCUMENTED.find(entry => entry.id === 'claude-opus-4-5')!) as any;
    expect(validateFakeMessagesBody(rowA, { max_tokens: 100, thinking: { type: 'disabled' } })?.message).toContain('thinking.type.disabled');
    expect(validateFakeMessagesBody(rowA, { max_tokens: 100, thinking: { type: 'enabled', budget_tokens: 2048 } })?.message).toContain('thinking.type.enabled');
    expect(validateFakeMessagesBody(rowC, { max_tokens: 100, thinking: { type: 'adaptive' } })?.message).toContain('adaptive');
    expect(validateFakeMessagesBody(rowB, { max_tokens: 100, thinking: { type: 'disabled' }, output_config: { effort: 'max' } })?.message).toContain('thinking is disabled');
    expect(validateFakeMessagesBody(rowC, { max_tokens: 5_000, thinking: { type: 'enabled', budget_tokens: 5_000 } })?.message).toContain('budget_tokens');
    expect(validateFakeMessagesBody(rowC, { max_tokens: 100, output_config: { effort: 'max' } })?.message).toContain('effort');
    expect(validateFakeMessagesBody(rowA, { max_tokens: 1_000_000 })?.message).toContain('maximum');
  });
});

describe('what the key offers and which model is picked (D8)', () => {
  const sonnetNew = profileOf({ id: 'claude-sonnet-5-5', line: 'sonnet', variant: 'A' });
  const sonnetOld = profileOf({ id: 'claude-sonnet-5', line: 'sonnet', variant: 'B' });
  const opus = profileOf({ id: 'claude-opus-5-5', line: 'opus', variant: 'A' });
  const haiku = profileOf({ id: 'claude-haiku-5-5', line: 'haiku', variant: 'B' });
  const haikuOld = profileOf({ id: 'claude-haiku-4-5', line: 'haiku', variant: 'C' });

  it('offers active models, keeps a deprecated one only when previously held, and never offers retired ones', () => {
    const listed = [
      profileOf({ id: 'active-1', variant: 'A' }),
      profileOf({ id: 'dep-held', variant: 'B', lifecycle: 'deprecated', retiresAt: '2026-11-30T00:00:00Z' }),
      profileOf({ id: 'dep-new', variant: 'B', lifecycle: 'deprecated' }),
      profileOf({ id: 'retired-held', variant: 'C', lifecycle: 'retired' }),
      profileOf({ id: 'active-2', variant: 'C' }),
    ];
    expect(selectOfferedModels(listed).map(model => model.id)).toEqual(['active-1', 'active-2']);
    expect(selectOfferedModels(listed, new Set(['dep-held', 'retired-held'])).map(model => model.id)).toEqual(['active-1', 'dep-held', 'active-2']);
    expect(selectOfferedModels(listed, new Set(['dep-held']))[1]).toMatchObject({ lifecycle: 'deprecated', retiresAt: '2026-11-30T00:00:00Z' });
  });

  it('caps the list at 100 models after the lifecycle filter, in list order', () => {
    const listed = [
      ...Array.from({ length: 30 }, (_, i) => profileOf({ id: `retired-${i}`, variant: 'A', lifecycle: 'retired' })),
      ...Array.from({ length: 120 }, (_, i) => profileOf({ id: `active-${i}`, variant: 'A' })),
    ];
    const offered = selectOfferedModels(listed);
    expect(offered).toHaveLength(ANTHROPIC_MAX_STORED_MODELS);
    expect(offered[0].id).toBe('active-0');
    expect(offered[99].id).toBe('active-99');
  });

  it('picks the newest Sonnet-line model that reads images and schemas, else Opus, else Haiku, else the first active model', () => {
    expect(pickAnthropicDefaultModel([haiku, sonnetNew, sonnetOld, opus])).toBe('claude-sonnet-5-5');
    expect(pickAnthropicDefaultModel([haiku, opus])).toBe('claude-opus-5-5');
    expect(pickAnthropicDefaultModel([haiku, haikuOld])).toBe('claude-haiku-5-5');
    // A Sonnet that cannot read images or produce schemas is skipped.
    const blind = profileOf({ id: 'sonnet-blind', line: 'sonnet', variant: 'A', images: false });
    const plain = profileOf({ id: 'sonnet-plain', line: 'sonnet', variant: 'A', structuredOutputs: false });
    expect(pickAnthropicDefaultModel([blind, plain, opus])).toBe('claude-opus-5-5');
    expect(pickAnthropicDefaultModel([blind, plain])).toBe('sonnet-blind');
    // Unknown lines and a deprecated first entry: the first active model.
    const fable = profileOf({ id: 'claude-fable-5-1', line: 'fable', variant: 'A' });
    const deprecated = profileOf({ id: 'claude-old', line: 'sonnet', variant: 'A', lifecycle: 'deprecated' });
    expect(pickAnthropicDefaultModel([deprecated, fable])).toBe('claude-fable-5-1');
    expect(pickAnthropicDefaultModel([deprecated])).toBeUndefined();
    expect(pickAnthropicDefaultModel([])).toBeUndefined();
  });

  it('picks the newest Haiku-line model for Organizing, else the connection default', () => {
    expect(pickAnthropicProcessingModel([sonnetNew, haiku, haikuOld])).toBe('claude-haiku-5-5');
    expect(pickAnthropicProcessingModel([sonnetNew, opus])).toBe('claude-sonnet-5-5');
    expect(pickAnthropicProcessingModel([])).toBeUndefined();
    // A Haiku that cannot read images is not the Organizing default (the visual inspector needs images).
    const blindHaiku = profileOf({ id: 'haiku-blind', line: 'haiku', variant: 'B', images: false });
    expect(pickAnthropicProcessingModel([blindHaiku, sonnetNew])).toBe('claude-sonnet-5-5');
  });

  it('offers at most three verification candidates, the default pick first, without repeats', () => {
    expect(anthropicVerificationCandidates([haiku, sonnetNew, sonnetOld, opus])).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-opus-5-5']);
    expect(anthropicVerificationCandidates([haiku])).toEqual(['claude-haiku-5-5']);
    expect(anthropicVerificationCandidates([])).toEqual([]);
    const retired = profileOf({ id: 'retired', line: 'sonnet', variant: 'A', lifecycle: 'retired' });
    expect(anthropicVerificationCandidates([retired, haiku])).toEqual(['claude-haiku-5-5']);
  });
});

describe('listing and verifying against the fake API', () => {
  let fake: FakeAnthropicServer;
  const call = () => ({ endpoint: fake.url, apiKey: FAKE_ANTHROPIC_KEY, fetchImpl: fetch });

  beforeEach(async () => {
    fake = await startFakeAnthropic();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fake.close();
  });

  const manyModels = (count: number): FakeModelSpec[] =>
    Array.from({ length: count }, (_, i) => ({ id: `claude-model-${String(i).padStart(3, '0')}`, variant: 'A' as const, line: i % 2 ? 'haiku' : 'sonnet' }));

  it('lists a short list in one request with the pinned headers', async () => {
    const result = await listAnthropicModels(call());
    expect(result).toMatchObject({ pages: 1, truncated: false });
    expect(result.models.map(model => model.id)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-opus-4-5-20251101', 'claude-haiku-4-5-20251001']);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ method: 'GET', path: '/v1/models', query: { limit: ['1000'] } });
    expect(fake.requests[0].auth).toEqual({ style: 'x-api-key', key: FAKE_ANTHROPIC_KEY });
    expect(fake.requests[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(fake.requests[0].headers['anthropic-beta']).toBeUndefined();
  });

  it('follows has_more / last_id across pages, in order', async () => {
    await fake.close();
    fake = await startFakeAnthropic({ models: manyModels(7), pageSize: 3 });
    const result = await listAnthropicModels(call());
    expect(result.pages).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.models.map(model => model.id)).toEqual(manyModels(7).map(spec => spec.id));
    expect(fake.requests.map(request => request.query.after_id?.[0])).toEqual([undefined, 'claude-model-002', 'claude-model-005']);
  });

  it('stops after five pages and says so', async () => {
    await fake.close();
    fake = await startFakeAnthropic({ models: manyModels(9), pageSize: 1 });
    const result = await listAnthropicModels(call());
    expect(ANTHROPIC_MAX_MODEL_PAGES).toBe(5);
    expect(result.pages).toBe(5);
    expect(result.truncated).toBe(true);
    expect(result.models).toHaveLength(5);
    expect(fake.requests).toHaveLength(5);
  });

  it('stops when the server repeats a cursor instead of looping', async () => {
    const rows = manyModels(3).map(spec => fakeModelRow(spec));
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ data: rows, has_more: true, last_id: 'claude-model-002' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const result = await listAnthropicModels({ endpoint: 'http://unused.invalid', apiKey: FAKE_ANTHROPIC_KEY, fetchImpl });
    expect(calls).toBe(2);
    expect(result.models).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });

  it('holds a whole listing to one overall deadline, not one timeout per page (boot must not wait five times as long)', async () => {
    await fake.close();
    fake = await startFakeAnthropic({ models: manyModels(9), pageSize: 1 });
    const pageDelayMs = 120;
    let pageRequests = 0;
    const slow = ((input: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      pageRequests += 1;
      const timer = setTimeout(() => resolve(fetch(input as string, init)), pageDelayMs);
      init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason); });
    })) as typeof fetch;
    // Each page alone is well inside its 1 s timeout; together they pass a 300 ms overall deadline.
    const began = Date.now();
    const failure = await listAnthropicModels({ endpoint: fake.url, apiKey: FAKE_ANTHROPIC_KEY, fetchImpl: slow, timeoutMs: 1_000, overallTimeoutMs: 300 }).catch(e => e);
    expect(failure).toBeInstanceOf(AnthropicUnreachableError);
    expect(Date.now() - began).toBeLessThan(700);
    expect(pageRequests).toBeLessThan(5);
    // Without the deadline the same five pages complete (the per-page bound alone cannot stop them).
    pageRequests = 0;
    const whole = await listAnthropicModels({ endpoint: fake.url, apiKey: FAKE_ANTHROPIC_KEY, fetchImpl: slow, timeoutMs: 1_000 });
    expect(whole.pages).toBe(5);
    expect(pageRequests).toBe(5);
  });
  it('names a rejected model LIST at the key, and a rejected generation at the model', async () => {
    fake.respond = request => (request.path === '/v1/models' ? { status: 403, body: fakeErrorBody('permission_error', 'no') } : undefined);
    const onList = await verifyKey(call()).catch(e => e);
    expect(onList.classification).toMatchObject({ kind: 'forbidden', saveCode: 'forbidden' });
    expect(onList.classification.message).toBe('This key is not allowed to list Claude models.');
    fake.respond = request => (request.path === '/v1/messages' ? { status: 403, body: fakeErrorBody('permission_error', 'no') } : undefined);
    const onGeneration = await verifyKey(call()).catch(e => e);
    expect(onGeneration.classification.message).toBe('This key is not allowed to use that Claude model.');
  });
  it('serves retired rows to the filter but never offers them', async () => {
    await fake.close();
    fake = await startFakeAnthropic({
      models: [{ id: 'gone', variant: 'A', lifecycle: 'retired' }, { id: 'claude-sonnet-5-5', variant: 'A', line: 'sonnet' }],
      leakRetired: true,
    });
    const { models } = await listAnthropicModels(call());
    expect(models.map(model => model.id)).toEqual(['gone', 'claude-sonnet-5-5']);
    expect(selectOfferedModels(models).map(model => model.id)).toEqual(['claude-sonnet-5-5']);
    // By default the server hides retired rows.
    await fake.close();
    fake = await startFakeAnthropic({ models: [{ id: 'gone', variant: 'A', lifecycle: 'retired' }, { id: 'live', variant: 'A' }] });
    expect((await listAnthropicModels(call())).models.map(model => model.id)).toEqual(['live']);
  });

  it('turns every non-2xx answer into a classified error and a dropped connection into "unreachable"', async () => {
    for (const row of FAKE_D10_ROWS) {
      fake.respond = () => row.answer;
      const error = await listAnthropicModels(call()).catch(e => e);
      expect(error, row.name).toBeInstanceOf(AnthropicApiError);
      expect(error.classification.status, row.name).toBe(row.answer.status);
      expect(error.message, row.name).toMatch(new RegExp(`^HTTP ${row.answer.status}`));
    }
    fake.respond = undefined;
    fake.dropNext = 1;
    await expect(listAnthropicModels(call())).rejects.toBeInstanceOf(AnthropicUnreachableError);
    // A wrong key is a 401 from the fake.
    const unauthorized = await listAnthropicModels({ ...call(), apiKey: WRONG_KEY }).catch(e => e);
    expect(unauthorized.classification).toMatchObject({ kind: 'auth_rejected', saveCode: 'invalid_key' });
  });

  it('reports an unreadable 200 as a temporary server problem, never as success', async () => {
    for (const body of ['<html>captive portal</html>', '{"data":"nope"}', 'null', '']) {
      const fetchImpl = (async () => new Response(body, { status: 200 })) as typeof fetch;
      const error = await listAnthropicModels({ endpoint: 'http://unused.invalid', apiKey: FAKE_ANTHROPIC_KEY, fetchImpl }).catch(e => e);
      expect(error, body).toBeInstanceOf(AnthropicApiError);
      expect(error.classification.kind, body).toBe('server_error');
      expect(error.message).not.toContain('captive');
    }
  });

  it('verifies with exactly one minimal request on the default pick, and nothing else', async () => {
    const result = await verifyKey(call());
    expect(result.verifiedModel).toBe('claude-sonnet-5-5');
    expect(result.listed).toHaveLength(5);
    expect(result.models.map(model => model.id)).toEqual(result.listed.map(model => model.id));
    const posts = fake.requests.filter(request => request.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe('/v1/messages');
    // Exactly {model, max_tokens: 16, messages:[{role:'user',content:'ping'}]}: no thinking, output_config, tools or system.
    expect(posts[0].rawBody).toBe('{"model":"claude-sonnet-5-5","max_tokens":16,"messages":[{"role":"user","content":"ping"}]}');
    expect(posts[0].headers['content-type']).toBe('application/json');
    expect(posts[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(posts[0].headers['anthropic-beta']).toBeUndefined();
    expect(posts[0].auth).toEqual({ style: 'x-api-key', key: FAKE_ANTHROPIC_KEY });
  });

  it('tries the next default-pick candidate on a 403 or 404 (three at most), then reports the last answer', async () => {
    const forbidModels = (...ids: string[]) => {
      fake.requests.length = 0;
      fake.respond = request => (request.method === 'POST' && ids.includes(request.body?.model)
        ? { status: 404, body: { type: 'error', error: { type: 'not_found_error', message: `model: ${request.body.model}` } } }
        : undefined);
    };
    forbidModels('claude-sonnet-5-5');
    const second = await verifyKey(call());
    expect(second.verifiedModel).toBe('claude-opus-5-5');
    expect(fake.requests.filter(request => request.method === 'POST').map(request => request.body.model)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5']);

    forbidModels('claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-opus-4-5-20251101');
    const failure = await verifyKey(call()).catch(e => e);
    expect(failure).toBeInstanceOf(AnthropicApiError);
    expect(failure.classification).toMatchObject({ kind: 'model_unavailable', saveCode: 'model_unavailable' });
    // Three candidates at most: the fourth and fifth models are never tried.
    expect(fake.requests.filter(request => request.method === 'POST')).toHaveLength(3);

    fake.requests.length = 0;
    fake.respond = request => (request.method === 'POST' ? { status: 403, body: { type: 'error', error: { type: 'permission_error', message: 'no' } } } : undefined);
    const forbidden = await verifyKey(call()).catch(e => e);
    expect(forbidden.classification).toMatchObject({ kind: 'forbidden', saveCode: 'forbidden' });
    expect(fake.requests.filter(request => request.method === 'POST')).toHaveLength(3);
  });

  it('stops at the first answer that is not a 403 or 404 (credit, key, overload, rate limit, server error)', async () => {
    for (const row of FAKE_D10_ROWS.filter(entry => ![403, 404].includes(entry.answer.status))) {
      fake.requests.length = 0;
      fake.respond = request => (request.method === 'POST' ? row.answer : undefined);
      const error = await verifyKey(call()).catch(e => e);
      expect(error, row.name).toBeInstanceOf(AnthropicApiError);
      expect(error.classification.status, row.name).toBe(row.answer.status);
      expect(fake.requests.filter(request => request.method === 'POST'), row.name).toHaveLength(1);
    }
  });

  it('keeps a previously held deprecated model and sends nothing when no model is active', async () => {
    await fake.close();
    fake = await startFakeAnthropic({
      models: [
        { id: 'claude-sonnet-5-5', variant: 'A', line: 'sonnet' },
        { id: 'claude-old-held', variant: 'B', lifecycle: 'deprecated', retiresAt: '2026-11-30T00:00:00Z' },
        { id: 'claude-old-new', variant: 'B', lifecycle: 'deprecated' },
      ],
    });
    const held = await verifyKey({ ...call(), keep: new Set(['claude-old-held']) });
    expect(held.models.map(model => model.id)).toEqual(['claude-sonnet-5-5', 'claude-old-held']);
    expect(held.listed.map(model => model.id)).toEqual(['claude-sonnet-5-5', 'claude-old-held', 'claude-old-new']);

    await fake.close();
    fake = await startFakeAnthropic({ models: [{ id: 'claude-old', variant: 'B', lifecycle: 'deprecated' }, { id: 'dead', variant: 'A', lifecycle: 'retired' }] });
    const none = await verifyKey(call());
    expect(none).toMatchObject({ verifiedModel: null });
    expect(none.models).toEqual([]);
    expect(fake.requests.filter(request => request.method === 'POST')).toHaveLength(0);
  });

  it('accepts only a real Message as proof that the key works', async () => {
    for (const body of ['<html>ok</html>', '{"type":"error"}', '{"ok":true}', 'null']) {
      fake.respond = request => (request.method === 'POST' ? { status: 200, body } : undefined);
      const error = await verifyKey(call()).catch(e => e);
      expect(error, body).toBeInstanceOf(AnthropicApiError);
      expect(error.classification.kind, body).toBe('server_error');
    }
  });

  it('can authenticate with Bearer for the probe, and refuses to build headers for a malformed key', async () => {
    const bearerOnly = await startFakeAnthropic({ authStyles: ['bearer'] });
    try {
      expect((await listAnthropicModels({ endpoint: bearerOnly.url, apiKey: FAKE_ANTHROPIC_KEY, fetchImpl: fetch, authStyle: 'bearer' })).models).toHaveLength(5);
      const rejected = await listAnthropicModels({ endpoint: bearerOnly.url, apiKey: FAKE_ANTHROPIC_KEY, fetchImpl: fetch, authStyle: 'x-api-key' }).catch(e => e);
      expect(rejected.classification.kind).toBe('auth_rejected');
      const before = bearerOnly.requests.length;
      await expect(listAnthropicModels({ endpoint: bearerOnly.url, apiKey: 'not-a-key', fetchImpl: fetch })).rejects.toThrow(/not an Anthropic API key/);
      expect(bearerOnly.requests.length).toBe(before);
    } finally {
      await bearerOnly.close();
    }
  });

  it('never logs or throws the key', async () => {
    const sinks = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}));
    const seen: string[] = [];
    const record = (value: unknown) => { seen.push(value instanceof Error ? `${value.name}: ${value.message}` : JSON.stringify(value)); };
    // Provider text that echoes the key must not survive classification.
    fake.respond = request => (request.method === 'POST'
      ? { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${FAKE_ANTHROPIC_KEY}` } } }
      : undefined);
    record(await verifyKey(call()).catch(e => e));
    fake.respond = undefined;
    record(await verifyKey({ ...call(), apiKey: WRONG_KEY }).catch(e => e));
    record(await verifyKey(call()));
    fake.dropNext = 1;
    record(await verifyKey(call()).catch(e => e));
    for (const sink of sinks) for (const args of sink.mock.calls) seen.push(args.map(String).join(' '));
    for (const text of seen) {
      expect(text).not.toContain(FAKE_ANTHROPIC_KEY);
      expect(text).not.toContain(WRONG_KEY);
    }
    expect(seen.length).toBeGreaterThan(3);
  });
});

// ── The synthetic list (docs of 2026-10-13) ──
// No real list has been captured (the owner's key is on another machine), so the list the fake serves and the
// profile tests run against is built from the documented GET /v1/models shape and the documented thinking, effort
// and lifecycle tables. The owner capture (probe --models --save-list), reduced to public ids, replaces it.
const SYNTHETIC_LIST = JSON.parse(fs.readFileSync(new URL('./testdata/anthropic-models.synthetic.json', import.meta.url), 'utf8'));
const SYNTHETIC_ROWS: Record<string, any>[] = SYNTHETIC_LIST.data;

// Ids on the public models overview (models/overview.md): the current lineup and the legacy lines still available.
// Models before the 4.6 generation carry their dated snapshot id (their model pages).
const OVERVIEW_IDS = [
  'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5',
  'claude-fable-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5-20251101',
  'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
];
// Every model on the overview supports thinking and returns capabilities, so the rows that stand for a model with no
// thinking, a null capabilities object, and a model the known table does not know can only use ids the public
// model-deprecations page lists (Sonnet 4.5 is deprecated; the other three are retired). Pinned so it cannot grow quietly.
const DEPRECATIONS_PAGE_IDS = ['claude-sonnet-4-5-20250929', 'claude-3-7-sonnet-20250219', 'claude-3-5-haiku-20241022', 'claude-3-haiku-20240307'];

describe('the synthetic model list', () => {
  it('says what it is and carries no credential-shaped text', () => {
    expect(SYNTHETIC_LIST._synthetic).toMatch(/^SYNTHETIC/);
    expect(SYNTHETIC_LIST._synthetic).toContain('2026-10-13');
    expect(SYNTHETIC_LIST._synthetic).toContain('not captured from the Anthropic API');
    const text = fs.readFileSync(new URL('./testdata/anthropic-models.synthetic.json', import.meta.url), 'utf8');
    expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{6,}|Bearer\s|x-api-key|wrkspc_|api\.anthropic\.com/i);
  });

  it('follows the documented GET /v1/models shape: pagination fields and every ModelInfo field', () => {
    expect(SYNTHETIC_LIST).toMatchObject({ has_more: false, first_id: SYNTHETIC_ROWS[0].id, last_id: SYNTHETIC_ROWS[SYNTHETIC_ROWS.length - 1].id });
    for (const row of SYNTHETIC_ROWS) {
      expect(Object.keys(row), row.id).toEqual(expect.arrayContaining([
        'type', 'id', 'display_name', 'created_at', 'deprecated_at', 'lifecycle', 'line', 'max_input_tokens', 'max_tokens', 'retires_at', 'capabilities',
      ]));
      expect(row.type).toBe('model');
      expect(['active', 'deprecated', 'retired']).toContain(row.lifecycle);
      expect(Number.isFinite(Date.parse(row.created_at)), row.id).toBe(true);
      if (row.capabilities === null) continue;
      for (const leafName of ['batch', 'citations', 'code_execution', 'effort', 'image_input', 'pdf_input', 'structured_outputs', 'thinking']) {
        expect(typeof row.capabilities[leafName]?.supported, `${row.id} ${leafName}`).toBe('boolean');
      }
      for (const form of ['adaptive', 'enabled', 'disabled']) expect(typeof row.capabilities.thinking.types[form].supported, `${row.id} ${form}`).toBe('boolean');
      for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) expect(typeof row.capabilities.effort[level].supported, `${row.id} ${level}`).toBe('boolean');
    }
    // allowed_fallback_models is part of the documented shape; the parser ignores it.
    expect(SYNTHETIC_ROWS.some(row => Array.isArray(row.allowed_fallback_models))).toBe(true);
    const parsed = parseAnthropicModel(SYNTHETIC_ROWS.find(row => row.allowed_fallback_models)!)!;
    expect(parsed).not.toHaveProperty('allowed_fallback_models');
  });

  it('uses only public model ids: the overview ids, plus four deprecations-page ids for the rows that need them', () => {
    const ids = SYNTHETIC_ROWS.map(row => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    const outsideOverview = ids.filter(id => !OVERVIEW_IDS.includes(id));
    expect(outsideOverview.sort()).toEqual([...DEPRECATIONS_PAGE_IDS].sort());
    // A fallback name outside the public set would leak a non-public model.
    for (const row of SYNTHETIC_ROWS) for (const name of row.allowed_fallback_models ?? []) expect([...OVERVIEW_IDS, ...DEPRECATIONS_PAGE_IDS], name).toContain(name);
    // The ids outside the overview are exactly the lifecycle rows the docs give them.
    expect(Object.fromEntries(SYNTHETIC_ROWS.filter(row => !OVERVIEW_IDS.includes(row.id)).map(row => [row.id, row.lifecycle]))).toEqual({
      'claude-sonnet-4-5-20250929': 'deprecated',
      'claude-3-7-sonnet-20250219': 'retired',
      'claude-3-5-haiku-20241022': 'retired',
      'claude-3-haiku-20240307': 'retired',
    });
  });

  it('parses every row, and covers every profile, null capabilities, and a model the table does not know', () => {
    const page = parseAnthropicModelPage(SYNTHETIC_LIST);
    expect(page.models).toHaveLength(SYNTHETIC_ROWS.length);
    expect(page).toMatchObject({ hasMore: false });
    const derived = page.models.map(model => deriveProfile(model));
    const covered = new Set(derived.map(profile => profile.kind));
    const missing = (['A', 'B', 'C', 'D'] as const).filter(kind => !covered.has(kind));
    expect(missing, `profiles the list leaves uncovered: ${missing.join(', ')}`).toEqual([]);

    const byId = (id: string) => ({ model: page.models.find(model => model.id === id)!, derived: derived.find(profile => profile.id === id)! });
    // Unknown to the table: extended thinking by its own capabilities, no prefix check.
    expect(byId('claude-3-7-sonnet-20250219').derived).toMatchObject({ known: false, kind: 'C', prefixCheck: false, thinkingOff: 'native' });
    // capabilities: null reads as unknown: no thinking or schemas, images allowed, output capped at 16,384, unknown window.
    const nullCaps = byId('claude-3-5-haiku-20241022');
    expect(nullCaps.derived).toMatchObject({ kind: 'D', known: false });
    expect(nullCaps.model).toMatchObject({ structuredOutputs: false, maxOutputTokens: 16_384, contextWindow: 200_000, line: null });
    expect(nullCaps.model.images).toBeUndefined();
    // No thinking at all: the API still reports disabled.supported = true there, which BotBoy does not trust.
    const noThinking = byId('claude-3-haiku-20240307');
    expect(SYNTHETIC_ROWS.find(row => row.id === 'claude-3-haiku-20240307')!.capabilities.thinking.types.disabled.supported).toBe(true);
    expect(noThinking.model.thinking).toEqual({ adaptive: false, enabled: false, disabled: false });
    expect(noThinking.derived).toMatchObject({ kind: 'D', thinkingOff: 'unavailable' });
    expect(noThinking.model.maxOutputTokens).toBe(4_096);
  });

  it('derives every documented model in the list to its documented profile, effort ladder and prefix-check, with no disagreement', () => {
    const page = parseAnthropicModelPage(SYNTHETIC_LIST);
    let compared = 0;
    for (const entry of DOCUMENTED) {
      // The list carries pre-4.6 models under their dated snapshot id.
      const model = page.models.find(candidate => knownProfileId(candidate.id) === entry.id);
      if (!model) continue;
      const derived = deriveProfile(model);
      expect(derived, entry.id).toMatchObject({ kind: entry.kind, known: true, prefixCheck: entry.prefixCheck, effort: EFFORT_LADDERS[entry.effort], thinkingOff: THINKING_OFF_OF[entry.kind] });
      expect(derived.disagreements, entry.id).toEqual([]);
      compared += 1;
    }
    // Every table id the docs publish and the list holds: the Mythos ids are not public models, so 14 of 17.
    expect(compared).toBe(14);
    expect(DOCUMENTED.filter(entry => !page.models.some(model => knownProfileId(model.id) === entry.id)).map(entry => entry.id).sort())
      .toEqual(['claude-mythos-5', 'claude-mythos-5-1', 'claude-mythos-preview']);
  });

  it('keeps lifecycle and limits as the docs state them', () => {
    const page = parseAnthropicModelPage(SYNTHETIC_LIST);
    const model = (id: string) => page.models.find(candidate => candidate.id === id)!;
    expect(model('claude-sonnet-4-5-20250929')).toMatchObject({ lifecycle: 'deprecated', retiresAt: '2026-11-30T00:00:00Z', contextWindow: 200_000, maxOutputTokens: 64_000 });
    expect(model('claude-haiku-5-5')).toMatchObject({ lifecycle: 'active', line: 'haiku', contextWindow: 1_000_000, maxOutputTokens: 128_000 });
    expect(model('claude-opus-4-5-20251101').effort).toEqual({ low: true, medium: true, high: true, xhigh: false, max: false });
    expect(model('claude-haiku-4-5-20251001').effort).toEqual({ low: false, medium: false, high: false, xhigh: false, max: false });
  });

  describe('served by the fake API', () => {
    let fake: FakeAnthropicServer;
    const call = () => ({ endpoint: fake.url, apiKey: FAKE_ANTHROPIC_KEY, fetchImpl: fetch });
    afterEach(async () => {
      await fake.close();
    });

    it('lists active and deprecated models by default (retired are hidden), across pages, in list order', async () => {
      fake = await startFakeAnthropic({ models: SYNTHETIC_ROWS, pageSize: 4 });
      const result = await listAnthropicModels(call());
      expect(result.pages).toBe(4);
      expect(result.truncated).toBe(false);
      const expected = SYNTHETIC_ROWS.filter(row => row.lifecycle !== 'retired').map(row => row.id);
      expect(expected).toHaveLength(14);
      expect(result.models.map(model => model.id)).toEqual(expected);
    });

    it('offers 13 active models, adds the deprecated one only when previously held, and never offers retired ones even if the server leaks them', async () => {
      fake = await startFakeAnthropic({ models: SYNTHETIC_ROWS, leakRetired: true });
      const { models } = await listAnthropicModels(call());
      expect(models).toHaveLength(17);
      expect(selectOfferedModels(models)).toHaveLength(13);
      expect(selectOfferedModels(models).every(model => model.lifecycle === 'active')).toBe(true);
      const held = selectOfferedModels(models, new Set(['claude-sonnet-4-5-20250929', 'claude-3-haiku-20240307']));
      expect(held).toHaveLength(14);
      expect(held.map(model => model.id)).toContain('claude-sonnet-4-5-20250929');
      expect(held.map(model => model.id)).not.toContain('claude-3-haiku-20240307');
    });

    it('picks Sonnet 5.5 for the connection and Haiku 5.5 for Organizing, and verifies on the default pick', async () => {
      fake = await startFakeAnthropic({ models: SYNTHETIC_ROWS });
      const result = await verifyKey(call());
      expect(result.verifiedModel).toBe('claude-sonnet-5-5');
      expect(pickAnthropicDefaultModel(result.models)).toBe('claude-sonnet-5-5');
      expect(pickAnthropicProcessingModel(result.models)).toBe('claude-haiku-5-5');
      expect(anthropicVerificationCandidates(result.models)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6']);
      expect(result.models).toHaveLength(13);
      expect(fake.requests.filter(request => request.method === 'POST').map(request => request.body.model)).toEqual(['claude-sonnet-5-5']);
    });

    it('accepts, from every offered model, each request shapeThinking builds (levels, tools, display, max_tokens)', async () => {
      fake = await startFakeAnthropic({ models: SYNTHETIC_ROWS });
      const { models } = await verifyKey(call());
      for (const model of models) {
        const row = SYNTHETIC_ROWS.find(candidate => candidate.id === model.id)!;
        for (const level of ['off', 'low', 'high', 'max'] as const) {
          for (const tools of [false, true]) {
            for (const display of ['omitted', 'summarized'] as const) {
              const shaped = shapeThinking(model, { level, tools, display, maxTokens: 4_096 });
              const body = {
                model: model.id, max_tokens: shaped.maxTokens, messages: [{ role: 'user', content: 'ping' }],
                ...(shaped.thinking ? { thinking: shaped.thinking } : {}),
                ...(shaped.effort ? { output_config: { effort: shaped.effort } } : {}),
              };
              expect(validateFakeMessagesBody(row, body), `${model.id} ${level} tools=${tools}`).toBeUndefined();
              // And the HTTP path agrees with the validator.
              const response = await fetch(`${fake.url}/v1/messages`, {
                method: 'POST', headers: { 'x-api-key': FAKE_ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(body),
              });
              expect(response.status, `${model.id} ${level} tools=${tools}`).toBe(200);
              await response.text();
            }
          }
        }
      }
    });
  });
});

// A real list can disagree with the docs: it can allow a form the docs refuse, or refuse one the docs allow. The
// shape BotBoy sends must be accepted either way, so it may only use what BOTH allow (D2, F6.3).
describe('a list that disagrees with the table can never produce a rejected request', () => {
  const thinkingCombos = [0, 1, 2, 3, 4, 5, 6, 7].map(bits => ({ adaptive: !!(bits & 1), enabled: !!(bits & 2), disabled: !!(bits & 4) }));
  const ladders = Object.keys(EFFORT_LADDERS) as (keyof typeof EFFORT_LADDERS)[];

  function rowWith(id: string, forms: { adaptive: boolean; enabled: boolean; disabled: boolean; supported?: boolean }, ladder: keyof typeof EFFORT_LADDERS, maxTokens: number) {
    const levels = EFFORT_LADDERS[ladder];
    return {
      ...fakeModelRow({ id, variant: 'A', maxTokens, maxInputTokens: 1_000_000 }),
      capabilities: {
        ...(fakeCapabilities('A') as Record<string, unknown>),
        effort: {
          supported: ladder !== 'none',
          low: { supported: levels.low }, medium: { supported: levels.medium }, high: { supported: levels.high },
          xhigh: { supported: levels.xhigh }, max: { supported: levels.max },
        },
        thinking: {
          supported: forms.supported ?? true,
          types: { adaptive: { supported: forms.adaptive }, enabled: { supported: forms.enabled }, disabled: { supported: forms.disabled } },
        },
      },
    } as Record<string, any>;
  }

  it('sends only what the key\'s capabilities AND the documented table allow, for every documented model', () => {
    let checks = 0;
    for (const entry of DOCUMENTED) {
      const docsRow = documentedRow(entry) as Record<string, any>;
      const scenarios = [
        ...thinkingCombos.flatMap(forms => ladders.map(ladder => ({ forms, ladder }))),
        { forms: { adaptive: true, enabled: true, disabled: true, supported: false }, ladder: 'all' as const },
      ];
      for (const { forms, ladder } of scenarios) {
        const capsRow = rowWith(entry.id, forms, ladder, docsRow.max_tokens);
        const profile = parseAnthropicModel(capsRow)!;
        for (const level of ['off', 'low', 'high', 'max'] as const) {
          for (const tools of [false, true]) {
            for (const maxTokens of [1, 4_096]) {
              const shaped = shapeThinking(profile, { level, tools, maxTokens, display: 'summarized' });
              const body = {
                max_tokens: shaped.maxTokens,
                ...(shaped.thinking ? { thinking: shaped.thinking } : {}),
                ...(shaped.effort ? { output_config: { effort: shaped.effort } } : {}),
              };
              const label = `${entry.id} caps=${JSON.stringify(forms)} effort=${ladder} ${level} tools=${tools}`;
              // Accepted whether the truth is what the key says or what the docs say.
              expect(validateFakeMessagesBody(capsRow, body), `caps: ${label}`).toBeUndefined();
              expect(validateFakeMessagesBody(docsRow, body), `docs: ${label}`).toBeUndefined();
              checks += 1;
            }
          }
        }
      }
    }
    expect(checks).toBe(DOCUMENTED.length * (8 * 4 + 1) * 4 * 2 * 2);
  });

  it('would send a rejected form if capabilities alone decided (the validator and the scenario are not vacuous)', () => {
    // Opus 5.5 always thinks. A key claiming `disabled` works would, believed alone, make us send it.
    const entry = DOCUMENTED.find(candidate => candidate.id === 'claude-opus-5-5')!;
    const docsRow = documentedRow(entry) as Record<string, any>;
    const capsRow = rowWith(entry.id, { adaptive: true, enabled: false, disabled: true }, 'all', docsRow.max_tokens);
    const believedAlone = { max_tokens: 4_096, thinking: { type: 'disabled' } };
    expect(validateFakeMessagesBody(capsRow, believedAlone)).toBeUndefined();
    expect(validateFakeMessagesBody(docsRow, believedAlone)?.message).toContain('thinking.type.disabled');
    const shaped = shapeThinking(parseAnthropicModel(capsRow)!, { level: 'off', tools: false, maxTokens: 4_096 });
    expect(shaped.thinking).toBeUndefined();
  });
});
