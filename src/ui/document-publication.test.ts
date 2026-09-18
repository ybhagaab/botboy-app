import { describe, expect, it } from 'vitest';
import {
  defaultPublicationDraft,
  publicationAttemptCanApply,
  publicationAttemptCanReject,
  publicationEffectLabel,
  publicationPresentation,
  publicationStageRequest,
} from './document-publication.js';

const updateBase = {
  publicationId: 'base-1',
  serverRelativeUrl: '/personal/u/Documents/Strategy.docx',
  format: 'docx',
};

describe('generated-document publication view model', () => {
  it('uses physical-effect copy for every owner-visible phase', () => {
    expect(publicationPresentation({ phase: 'create_configuration_required' }).button).toBe('Publish to SharePoint…');
    expect(publicationPresentation({ phase: 'update_ready' }).button).toBe('Review update…');
    expect(publicationPresentation({ phase: 'pending' })).toMatchObject({ label: 'Publication awaiting review', tone: 'accent' });
    expect(publicationPresentation({ phase: 'approved' })).toMatchObject({ label: 'Approved · write not started', tone: 'good' });
    expect(publicationPresentation({ phase: 'in_flight' })).toMatchObject({ label: 'Publication phase recorded', button: 'Review receipt' });
    expect(publicationPresentation({ phase: 'conflicted' })).toMatchObject({ label: 'Publication conflict · no write', tone: 'warn' });
    expect(publicationPresentation({ phase: 'complete', currentLocationCount: 2 }).label)
      .toBe('Current at 2 SharePoint locations');
    expect(publicationEffectLabel('update_existing', { final: true })).toBe('Update SharePoint version');
    expect(publicationEffectLabel('create', { final: false })).toBe('Stage new copy for review');
  });

  it('defaults to the sole exact update base and never sends destination overrides', () => {
    const view = { phase: 'update_ready', updateBases: [updateBase] };
    const draft = defaultPublicationDraft(view);
    expect(draft).toMatchObject({ mode: 'update_existing', basePublicationId: 'base-1', format: 'docx' });
    expect(publicationStageRequest(view, draft)).toEqual({
      ok: true,
      body: { ownerRequested: true, action: 'update_existing', basePublicationId: 'base-1' },
    });
  });

  it('prefills a verified personal Documents folder only for create mode', () => {
    expect(defaultPublicationDraft({ updateBases: [] }, {
      status: 'resolved', targetFolder: '/personal/user_amazon_com/Documents',
    })).toMatchObject({ mode: 'create', targetFolder: '/personal/user_amazon_com/Documents', siteUrl: '' });
    expect(defaultPublicationDraft({ updateBases: [updateBase] }, {
      status: 'resolved', targetFolder: '/personal/user_amazon_com/Documents',
    })).toMatchObject({ mode: 'update_existing', targetFolder: '' });
  });

  it('requires explicit selection when multiple locations exist', () => {
    const view = { updateBases: [updateBase, { ...updateBase, publicationId: 'base-2' }] };
    expect(publicationStageRequest(view, { mode: 'update_existing', basePublicationId: '' }))
      .toEqual({ ok: false, error: 'Choose the exact SharePoint copy to update.' });
    expect(publicationStageRequest(view, { mode: 'update_existing', basePublicationId: 'not-a-candidate' }).ok).toBe(false);
  });

  it('validates a new-copy destination and preserves only the selected destination shape', () => {
    const view = { updateBases: [] };
    expect(publicationStageRequest(view, { mode: 'create', format: 'docx' }).ok).toBe(false);
    expect(publicationStageRequest(view, {
      mode: 'create', format: 'docx', targetFolder: '/personal/u/Documents', serverRelativeUrl: '/personal/u/Documents/x.docx',
    }).ok).toBe(false);
    expect(publicationStageRequest(view, {
      mode: 'create', format: 'md', serverRelativeUrl: '/personal/u/Documents/x.docx',
    }).ok).toBe(false);
    expect(publicationStageRequest(view, {
      mode: 'create', format: 'docx', targetFolder: '/personal/u/Documents', siteUrl: '',
    })).toEqual({
      ok: true,
      body: { ownerRequested: true, action: 'create', format: 'docx', targetFolder: '/personal/u/Documents' },
    });
  });

  it('exposes only legal pending/conflict/apply controls', () => {
    expect(publicationAttemptCanReject({ phase: 'pending' })).toBe(true);
    expect(publicationAttemptCanReject({ phase: 'conflicted' })).toBe(true);
    expect(publicationAttemptCanReject({ phase: 'approved' })).toBe(false);
    expect(publicationAttemptCanApply({ phase: 'approved', attempt: { docKey: 'x' } })).toBe(true);
    expect(publicationAttemptCanApply({ phase: 'approved', attempt: {} })).toBe(false);
    expect(publicationAttemptCanApply({ phase: 'in_flight', attempt: { docKey: 'x' } })).toBe(false);
    expect(publicationAttemptCanApply({
      phase: 'failed', attempt: { docKey: 'x', publicationStatus: 'upload_failed', pendingStatus: 'approved' },
    })).toBe(true);
    expect(publicationAttemptCanApply({
      phase: 'failed', attempt: { docKey: 'x', publicationStatus: 'verification_failed', pendingStatus: 'conflicted' },
    })).toBe(false);
  });
});
