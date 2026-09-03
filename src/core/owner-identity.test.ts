import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStorage, StorageLayer, setSetting } from './storage.js';
import { createOwnerMatcher, resolveOwnerIdentity } from './owner-identity.js';

/**
 * Owner identity + mention matching (2026-09-01 incident: a Word mention
 * chip fused with the next typed word — "@Bhagat, ABWhat is the expected
 * latency here?" — and the boundary-only matcher stamped mentionedMe=false).
 * Rules under test are GENERAL: they derive from whatever identity is
 * configured, with guardrails against prefix collisions and short tokens.
 */
describe('owner-identity', () => {
  let storage: StorageLayer;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });
  afterEach(() => storage.close());

  function matcherFor(name: string, email = 'ybhagaab@amazon.com') {
    const db = storage.getDb();
    setSetting(db, 'owner_identity.name', '');
    setSetting(db, 'owner_identity.alias', '');
    setSetting(db, 'sharepoint_sync.owner_name', '');
    setSetting(db, 'grasp_sync.owner_name', name);
    setSetting(db, 'grasp_sync.owner_email', email);
    return createOwnerMatcher(db);
  }

  describe('determination precedence', () => {
    it('override > sharepoint override > grasp; alias from email local part', () => {
      const db = storage.getDb();
      setSetting(db, 'grasp_sync.owner_name', 'Bhagat, AB');
      setSetting(db, 'grasp_sync.owner_email', 'ybhagaab@amazon.com');
      let identity = resolveOwnerIdentity(db);
      expect(identity).toMatchObject({ known: true, displayName: 'Bhagat, AB', alias: 'ybhagaab', nameSource: 'grasp', aliasSource: 'email' });

      setSetting(db, 'sharepoint_sync.owner_name', 'AB Bhagat');
      identity = resolveOwnerIdentity(db);
      expect(identity).toMatchObject({ displayName: 'AB Bhagat', nameSource: 'sharepoint' });

      setSetting(db, 'owner_identity.name', 'Ab Bhagat');
      setSetting(db, 'owner_identity.alias', 'abbhagat');
      identity = resolveOwnerIdentity(db);
      expect(identity).toMatchObject({ displayName: 'Ab Bhagat', alias: 'abbhagat', nameSource: 'override', aliasSource: 'override' });
    });

    it('unknown identity: no name, no alias → known=false and nothing matches', () => {
      const matcher = matcherFor('', '');
      expect(matcher.identity.known).toBe(false);
      expect(matcher.isOwner('Bhagat, AB')).toBe(false);
      expect(matcher.mentionsOwner('@Bhagat, AB please look')).toBe(false);
      expect(matcher.nearMiss('@Bhagat, AB please look')).toBe(false);
    });
  });

  describe('mentionsOwner — chip fusion (the 2026-09-01 shape)', () => {
    it('catches the literal missed mention: chip fused with the next CamelCase word', () => {
      const matcher = matcherFor('Bhagat, AB');
      const live = '↪ replying to Kalyankar, Nitin: "@Wang, Zeng: Exactly what data are we sending to the third party ?"\n\n@Wang, Zeng @Bhagat, ABWhat is the expected latency here?';
      expect(matcher.mentionsOwner(live)).toBe(true);
    });

    it('generalizes to any display name, both token orders', () => {
      const nitin = matcherFor('Kalyankar, Nitin', 'nitink@amazon.com');
      expect(nitin.mentionsOwner('@Kalyankar, NitinCan you review?')).toBe(true);
      expect(nitin.mentionsOwner('@Nitin KalyankarPlease check')).toBe(true);
      expect(nitin.mentionsOwner('@Kalyankar, Nitin please')).toBe(true);
    });

    it('rejects lowercase continuations — a longer name sharing the prefix is NOT the owner', () => {
      const matcher = matcherFor('Bhagat, AB');
      expect(matcher.mentionsOwner('@Bhagat, Abhishek can you take this?')).toBe(false);
      const chen = matcherFor('Wang, Chen', 'chenw@amazon.com');
      expect(chen.mentionsOwner('@Wang, Chenxi replied already')).toBe(false);
    });

    it('rejects ALL-CAPS continuations (same prefix risk)', () => {
      const matcher = matcherFor('Bhagat, AB');
      expect(matcher.mentionsOwner('@Bhagat, ABHISHEK ping')).toBe(false);
    });
  });

  describe('mentionsOwner — boundary forms', () => {
    it('matches prose name forms in both orders and the alias', () => {
      const matcher = matcherFor('Bhagat, AB');
      expect(matcher.mentionsOwner('loop in Bhagat, AB please')).toBe(true);
      expect(matcher.mentionsOwner('cc AB Bhagat on this')).toBe(true);
      expect(matcher.mentionsOwner('ask @ybhagaab for the data')).toBe(true);
    });

    it('does not match token fragments or unrelated text', () => {
      const matcher = matcherFor('Bhagat, AB');
      expect(matcher.mentionsOwner('abnormal bhagat-adjacent wording')).toBe(false);
      expect(matcher.mentionsOwner('the ab test results are in')).toBe(false);
      expect(matcher.mentionsOwner('')).toBe(false);
    });

    it('short-token guard: ≤2-char single names/aliases only match @-prefixed', () => {
      const li = matcherFor('Li', 'li@amazon.com');
      expect(li.mentionsOwner('the li element is broken')).toBe(false); // standalone 2-char: never
      expect(li.mentionsOwner('@Li please approve')).toBe(true);         // @-chip form: fine
    });
  });

  describe('isOwner — author strings', () => {
    it('matches directory order, natural order, alias-only, and alias/email-decorated forms', () => {
      const matcher = matcherFor('Bhagat, AB');
      expect(matcher.isOwner('Bhagat, AB')).toBe(true);
      expect(matcher.isOwner('AB Bhagat')).toBe(true);
      expect(matcher.isOwner('ybhagaab')).toBe(true);
      expect(matcher.isOwner('Bhagat, AB (ybhagaab)')).toBe(true);
      expect(matcher.isOwner('AB Bhagat <ybhagaab@amazon.com>')).toBe(true);
    });

    it('rejects colleagues sharing a surname or unrelated extras', () => {
      const matcher = matcherFor('Bhagat, AB');
      expect(matcher.isOwner('Bhagat, Abhishek')).toBe(false);
      expect(matcher.isOwner('Wang, Chen')).toBe(false);
      expect(matcher.isOwner('AB Bhagat and Wang Chen')).toBe(false);
    });
  });

  describe('nearMiss — observability for the next fusion-shaped failure', () => {
    it('flags @-text containing an owner token that no rule matched', () => {
      const matcher = matcherFor('Bhagat, AB');
      expect(matcher.nearMiss('@Bhagat should we proceed?')).toBe(true);   // surname only
      expect(matcher.nearMiss('@Bhagat, AB please look')).toBe(false);     // real match → not a near miss
      expect(matcher.nearMiss('no at-sign bhagat text')).toBe(false);      // no '@' → not mention-shaped
      expect(matcher.nearMiss('@Wang, Chen only')).toBe(false);            // no owner token
    });
  });
});
