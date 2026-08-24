import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createProductDocumentsRouter } from '../api/routers/product-documents.js';
import type { LlmClient, ChatCompletionRequest } from '../core/llm-client.js';
import { createPromptManager } from '../core/prompt-manager.js';
import type { DocumentParser } from '../core/document-parser.js';
import { createContextResolver } from './context-resolver.js';
import { createDocumentValidator } from './document-validator.js';
import { ProductDocumentGenerationError, createProductDocumentService } from './document-service.js';
import { createGlossaryResolver } from './glossary-resolver.js';
import { createProductDocumentStore } from './product-document-store.js';
import { createProfileRegistry } from './profile-registry.js';
import { buildSourceEvidenceIndex } from './source-fidelity.js';
import { createSteChecker } from './ste-checker.js';
import type { ContextResolution, ProductDocumentArtifact, ProductDocumentService, SteBundleLoader } from './types.js';
import { createWritingConfigStore } from './writing-config.js';

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});

const opContent = `# Document control
Purpose: propose the operating plan.
Plan mode: roadmap_vision.
Planning horizon: next planning period.
Document owner: Product owner.
Lifecycle status: draft.

# Purpose, mission, and vision
Mission: Define the direction.

# Background and operating context
The current context is supplied by the request.

# Current situation and learnings
Current-state evidence: Assumption-labelled input.

# Goals and operating mental model
Goal 1.

# Strategy portfolio and themes
Theme 1.

# Key initiatives and plans
Initiative 1.

# Executive diligence FAQ
Recommendation: Review the proposed direction.`;

const opInputs = {
  plan_mode: 'roadmap_vision',
  planning_horizon: 'next planning period',
  document_owner: 'Product owner',
  lifecycle_status: 'draft',
  authoritative_overview: true,
  mission_or_vision: 'Define the direction.',
  current_state_evidence: 'Assumption-labelled input.',
  goals: ['Goal 1'],
  strategy_themes: ['Theme 1'],
  key_initiatives: ['Initiative 1'],
  decision_or_recommendation: 'Review the proposed direction.',
};

const emptyContext: ContextResolution = {
  status: 'prompt_only',
  overviewAvailable: false,
  documents: [],
  manifest: [],
  diagnostics: [],
  totalCharacters: 0,
};
const fixtureRegistry = createProfileRegistry();

function inputSourceUnitId(profileId: string, key: string, value: unknown): string {
  const index = buildSourceEvidenceIndex(
    emptyContext,
    { prompt: '', inputs: { [key]: value } },
    fixtureRegistry.getProfile(profileId),
  );
  const unit = index.units.find((entry) => entry.sourceReference === `user input: ${key}`);
  if (!unit) throw new Error(`Missing fixture source unit for ${key}`);
  return unit.unitId;
}

function opClaims() {
  const definitions = [
    { key: 'plan_mode', value: opInputs.plan_mode, statement: 'Plan mode: roadmap_vision.', claim_type: 'other', state: 'stated' },
    { key: 'planning_horizon', value: opInputs.planning_horizon, statement: 'Planning horizon: next planning period.', claim_type: 'timing', state: 'stated' },
    { key: 'document_owner', value: opInputs.document_owner, statement: 'Document owner: Product owner.', claim_type: 'owner', state: 'stated' },
    { key: 'lifecycle_status', value: opInputs.lifecycle_status, statement: 'Lifecycle status: draft.', claim_type: 'other', state: 'stated' },
    { key: 'mission_or_vision', value: opInputs.mission_or_vision, statement: 'Mission: Define the direction.', claim_type: 'mission', state: 'stated' },
    { key: 'current_state_evidence', value: opInputs.current_state_evidence, statement: 'Current-state evidence: Assumption-labelled input.', claim_type: 'assumption', state: 'assumption' },
    { key: 'goals', value: opInputs.goals, statement: 'Goal 1.', claim_type: 'other', state: 'stated' },
    { key: 'strategy_themes', value: opInputs.strategy_themes, statement: 'Theme 1.', claim_type: 'other', state: 'stated' },
    { key: 'key_initiatives', value: opInputs.key_initiatives, statement: 'Initiative 1.', claim_type: 'other', state: 'stated' },
    { key: 'decision_or_recommendation', value: opInputs.decision_or_recommendation, statement: 'Recommendation: Review the proposed direction.', claim_type: 'recommendation', state: 'proposed' },
  ];
  return definitions.map((entry) => ({
    statement: entry.statement,
    claim_type: entry.claim_type,
    state: entry.state,
    source_unit_ids: [inputSourceUnitId('op_roadmap_vision.v1', entry.key, entry.value)],
    content_evidence: entry.statement,
  }));
}

function emailClaims(content: string) {
  const value = 'Proposal update.';
  return [{
    statement: content,
    claim_type: 'decision',
    state: 'stated',
    source_unit_ids: [inputSourceUnitId('communication/email.v1', 'answer_ask_decision_or_update', value)],
    content_evidence: content,
  }];
}

function modelJson(content = opContent, claims = opClaims()): string {
  return JSON.stringify({
    title: 'Planning draft',
    content,
    assumptions: ['Current-state evidence needs review.'],
    open_questions: ['Which baseline is authoritative?'],
    claims,
    omitted_source_units: [],
  });
}

function makeFixture(responseContent = modelJson()): {
  service: ProductDocumentService;
  configStore: ReturnType<typeof createWritingConfigStore>;
  calls: ChatCompletionRequest[];
  setResponse(value: string): void;
  setAvailable(value: boolean): void;
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-pm-service-'));
  cleanup.push(home);
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const registry = createProfileRegistry();
  const configStore = createWritingConfigStore(db, { homeDir: home });
  const parser: DocumentParser = {
    parse(filePath) { return { success: true, text: fs.readFileSync(filePath, 'utf8'), filePath, fileType: path.extname(filePath) }; },
    getSupportedFormats: () => ['.md', '.txt', '.json'],
  };
  const contextResolver = createContextResolver(parser, { homeDir: home });
  const glossaryResolver = createGlossaryResolver();
  const steBundleLoader: SteBundleLoader = {
    load: () => ({
      ready: false,
      available: false,
      approved: false,
      path: path.join(home, 'missing-ste-bundle.json'),
      diagnostics: ['Bundle is absent in this test.'],
    }),
  };
  const validator = createDocumentValidator({ registry, steChecker: createSteChecker(), steBundleLoader });
  const calls: ChatCompletionRequest[] = [];
  let response = responseContent;
  let available = true;
  const llmClient = {
    isAvailable: () => available,
    getActiveModel: () => 'test-model',
    chatCompletion: async (input: ChatCompletionRequest) => {
      calls.push(input);
      return {
        content: response,
        toolCalls: null,
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        finishReason: 'stop' as const,
      };
    },
  } as unknown as LlmClient;
  const service = createProductDocumentService({
    llmClient,
    promptManager: createPromptManager(),
    registry,
    configStore,
    contextResolver,
    glossaryResolver,
    validator,
    steBundleLoader,
    now: () => new Date('2026-08-08T15:00:00.000Z'),
    createArtifactId: () => 'artifact-test-1',
  });
  return {
    service,
    configStore,
    calls,
    setResponse(value) { response = value; },
    setAvailable(value) { available = value; },
  };
}

function buildApp(service?: ProductDocumentService, configStore?: ReturnType<typeof createWritingConfigStore>) {
  const app = express();
  app.use(express.json());
  app.use('/api', createProductDocumentsRouter({
    nodeManager: {} as never,
    ...(service ? { productDocumentService: service } : {}),
    ...(configStore ? { writingConfigStore: configStore } : {}),
  }));
  return app;
}

describe('native product-manager generation service', () => {
  it('uses the native no-tool persona, structured output, manifests, and deterministic validation', async () => {
    const fixture = makeFixture();
    const artifact = await fixture.service.generate({
      profileId: 'op_roadmap_vision.v1',
      prompt: 'Draft the proposed operating plan without inventing evidence.',
      steMode: 'advisory',
      inputs: opInputs,
    });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0].tools).toBeUndefined();
    expect(fixture.calls[0].responseFormat).toEqual({ type: 'json_object' });
    expect(fixture.calls[0].messages[0].content).toContain("BotBoy's native product-manager writing specialist");
    expect(fixture.calls[0].messages[0].content).toContain('No configured product, technical, or domain context was loaded');
    expect(artifact).toMatchObject({
      artifactId: 'artifact-test-1',
      state: 'draft_review',
      profileId: 'op_roadmap_vision.v1',
      profileVersion: '1.0.0',
      model: 'test-model',
      emailSendApprovalRequired: false,
    });
    expect(artifact.context.status).toBe('prompt_only');
    expect(artifact.overlayVersions).toHaveProperty('amazon_writing.v1', '1.1.0');
    expect(artifact.validation.ste.findings.some((finding) => finding.code === 'STE_BUNDLE_LIMITED')).toBe(true);
  });

  it('does not call the model when a configured overview becomes unreadable', async () => {
    const fixture = makeFixture();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-pm-overview-'));
    cleanup.push(home);
    // The fixture store has its own home boundary, so use its missing-overview behavior through a validated file in that home.
    const fixtureHome = path.dirname(fixture.service.getSteBundleReadiness().path);
    fs.mkdirSync(fixtureHome, { recursive: true });
    const overview = path.join(fixtureHome, 'overview.md');
    fs.writeFileSync(overview, '# Overview\nTemporary context.');
    const saved = fixture.configStore.set({ overviewFile: overview });
    expect(saved.ok).toBe(true);
    fs.rmSync(overview);

    const artifact = await fixture.service.generate({
      profileId: 'op_roadmap_vision.v1',
      prompt: 'Draft the plan.',
      inputs: opInputs,
    });
    expect(artifact.state).toBe('blocked_for_context');
    expect(artifact.validation.findings[0].code).toBe('CTX_OVERVIEW_REQUIRED');
    expect(fixture.calls).toHaveLength(0);
  });

  it('rejects malformed structured model output without treating free text as a draft', async () => {
    const fixture = makeFixture('not json');
    await expect(fixture.service.generate({
      profileId: 'op_roadmap_vision.v1',
      prompt: 'Draft the plan.',
      inputs: opInputs,
    })).rejects.toMatchObject<ProductDocumentGenerationError>({ code: 'malformed_output' });
  });

  it('normalizes JSON null for an optional claim caveat', async () => {
    const generated = JSON.parse(modelJson()) as { claims: Array<Record<string, unknown>> };
    generated.claims[0].caveat = null;
    const fixture = makeFixture(JSON.stringify(generated));
    const artifact = await fixture.service.generate({
      profileId: 'op_roadmap_vision.v1',
      prompt: 'Draft the plan.',
      inputs: opInputs,
    });
    expect(artifact.claims[0]).not.toHaveProperty('caveat');
  });

  it('applies email hard gates and never exposes send capability', async () => {
    const fixture = makeFixture(modelJson('URGENT: Please complete the action ASAP.'));
    const validation = await fixture.service.validate({
      profileId: 'communication/email.v1',
      content: 'URGENT: Please complete the action ASAP.',
      steMode: 'advisory',
      inputs: {
        audience: ['Reviewer'],
        answer_ask_decision_or_update: 'Complete the action.',
        essential_context: 'Request context.',
        deadline_when_applicable: 'Friday',
      },
      email: {
        purposeType: 'action_required',
        sender: 'Sender',
        toRecipients: ['actor@example.test'],
        ccRecipients: [],
        bccRecipients: ['hidden@example.test'],
        sensitivity: 'Confidential',
        subject: 'URGENT: Action required',
        actions: [{ action: 'Complete the review.' }],
        attachmentsOrLinks: [],
      },
    });
    const codes = validation.findings.map((finding) => finding.code);
    expect(codes).toEqual(expect.arrayContaining([
      'EMAIL_BCC_APPROVAL_REQUIRED',
      'EMAIL_ACTION_OWNER_MISSING',
      'EMAIL_ACTION_DEADLINE_MISSING',
      'EMAIL_FALSE_URGENCY_RISK',
      'EMAIL_SENSITIVE_DATA_REVIEW',
      'EMAIL_SEND_APPROVAL_REQUIRED',
    ]));
    expect(validation.status).toBe('blocked');
  });
});

describe('product-document HTTP API', () => {
  it('returns 503 when the optional service dependency is absent', async () => {
    await request(buildApp()).get('/api/product-documents/profiles').expect(503);
  });

  it('discovers compact profiles, persists context config, validates, and keeps email draft-only', async () => {
    const fixture = makeFixture();
    const app = buildApp(fixture.service, fixture.configStore);
    const discovery = await request(app).get('/api/product-documents/profiles').expect(200);
    expect(discovery.body.profiles).toHaveLength(9);
    expect(discovery.body.overlays).toHaveLength(3);
    expect(discovery.body.ste.dictionary).toBeUndefined();
    expect(discovery.body.controls).toEqual({ emailDraftOnly: true, emailSendEndpointAvailable: false });

    const config = await request(app)
      .put('/api/product-documents/context-config')
      .send({ productDocDirectories: [] })
      .expect(200);
    expect(config.body.config.schemaVersion).toBe('writing-context.v1');

    const checked = await request(app)
      .post('/api/product-documents/validate')
      .send({ profileId: 'op_roadmap_vision.v1', content: opContent, steMode: 'advisory', inputs: opInputs })
      .expect(200);
    expect(checked.body.validation.checkerVersion).toBeTruthy();

    const emailContent = 'Please review the proposal and reply by Friday.';
    fixture.setResponse(modelJson(emailContent, emailClaims(emailContent)));
    const email = await request(app)
      .post('/api/product-documents/email/draft')
      .send({
        prompt: 'Draft an information-only email.',
        steMode: 'advisory',
        inputs: {
          audience: ['Reviewer'],
          answer_ask_decision_or_update: 'Proposal update.',
          essential_context: 'Request context.',
        },
        email: {
          purposeType: 'information_only',
          sender: 'Sender',
          toRecipients: ['reader@example.test'],
          ccRecipients: [],
          sensitivity: 'Internal',
          subject: 'Proposal update',
          actions: [],
          attachmentsOrLinks: [],
        },
      })
      .expect(200);
    expect(email.body.artifact.profileId).toBe('communication/email.v1');
    expect(email.body.artifact.emailSendApprovalRequired).toBe(true);
    expect(email.body.artifact).not.toHaveProperty('send');
    await request(app).post('/api/product-documents/email/send').send({}).expect(404);
  });

  it('maps malformed model output to a safe 502 response', async () => {
    const fixture = makeFixture('free text, not JSON');
    const response = await request(buildApp(fixture.service, fixture.configStore))
      .post('/api/product-documents/generate')
      .send({ profileId: 'op_roadmap_vision.v1', prompt: 'Draft the plan.', inputs: opInputs })
      .expect(502);
    expect(response.body).toEqual({ error: 'The model did not return valid JSON.', code: 'malformed_output' });
  });
});


describe('document authoring mode routing and detail preservation', () => {
  it('saves a chat-authored document with a max-reasoning conformance review and advisory-only validation', async () => {
    const fixture = makeFixture();
    // Conformance reviewer verdict: conformant, no correction.
    fixture.setResponse(JSON.stringify({
      conformant: true,
      summary: 'Follows the adaptive guide.',
      findings: [{ aspect: 'style', severity: 'note', message: 'Consistent terminology throughout.' }],
    }));
    const artifact = await fixture.service.saveAuthoredDocument({
      title: 'AppsFlyer & CleverTap 3P SDK Requirements',
      content: '# Requirements\n\nComplete chat-authored document body with every supplied table preserved. [c1]',
      citations: [
        { id: 'c1', label: 'PVD email thread — Pradip reply', source: 'email', quote: 'Each title carries a different value' },
        { id: '!!bad id!!', label: 'malformed id is dropped, never rejected' },
        { id: 'c2', label: '' },
      ],
    });
    // Exactly ONE model pass runs: the post-authoring conformance review, at
    // maximum reasoning. The writing itself has no second-model pass.
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0].think).toBe(true);
    expect(fixture.calls[0].reasoningEffort).toBe('max');
    expect(fixture.calls[0].messages[1].content).toContain('Writing guide for this document type');
    expect(fixture.calls[0].messages[1].content).toContain('Complete chat-authored document body');
    expect(artifact.conformanceReview?.status).toBe('conformant');
    expect(artifact.conformanceReview?.correctionApplied).toBe(false);
    // Citations: bounded normalization keeps valid entries, silently drops
    // malformed ones (a bad annotation must never lose a document).
    expect(artifact.citations).toHaveLength(1);
    expect(artifact.citations?.[0]).toMatchObject({ id: 'c1', label: 'PVD email thread — Pradip reply', source: 'email' });
    expect(artifact.state).toBe('ready_for_review');
    expect(artifact.profileId).toBe('business_document/adaptive.v1');
    expect(artifact.maturity).toBe('working');
    expect(artifact.revisionOrigin).toBe('chat_authored');
    expect(artifact.content).toContain('Complete chat-authored document body');
    // Validation runs advisory-only — the artifact carries findings but is never blocked.
    expect(artifact.validation.status).toBeDefined();
    expect(artifact.state).not.toBe('blocked_validation');

    await expect(fixture.service.saveAuthoredDocument({
      title: 'Orphan revision',
      content: 'Revision body.',
      parentArtifactId: 'missing-artifact-id',
    })).rejects.toThrow(/artifact being revised does not exist/i);
  });

  it('applies a safe reviewer correction and refuses a destructive one', async () => {
    const fixture = makeFixture();
    const authored = `# Decision memo\n\n${'Substantive requirement line preserved verbatim. '.repeat(20)}`;
    // Safe correction: complete document, similar size, real changes.
    const correctedDocument = `# Decision Memo\n\n## Requested decision\n\n${'Substantive requirement line preserved verbatim. '.repeat(20)}`;
    fixture.setResponse(JSON.stringify({
      conformant: false,
      summary: 'Section contract deviation corrected.',
      findings: [{ aspect: 'section_contract', severity: 'deviation', message: 'Missing requested-decision heading.' }],
      correctedContent: correctedDocument,
    }));
    const corrected = await fixture.service.saveAuthoredDocument({
      title: 'Launch decision',
      content: authored,
      profileId: 'business_document/adaptive.v1',
    });
    expect(corrected.conformanceReview?.status).toBe('corrected');
    expect(corrected.conformanceReview?.correctionApplied).toBe(true);
    expect(corrected.content).toBe(correctedDocument);

    // Destructive "correction" (loses most of the document) must be refused:
    // findings stay, content stays as authored.
    fixture.setResponse(JSON.stringify({
      conformant: false,
      findings: [{ aspect: 'structure', severity: 'deviation', message: 'Wrong order.' }],
      correctedContent: '# Too short',
    }));
    const refused = await fixture.service.saveAuthoredDocument({
      title: 'Launch decision',
      content: authored,
    });
    expect(refused.conformanceReview?.status).toBe('deviations_noted');
    expect(refused.conformanceReview?.correctionApplied).toBe(false);
    expect(refused.content).toBe(authored);
  });

  it('exposes the single save authoring surface without mode gating', () => {
    const prompts = createPromptManager();
    const toolNames = prompts.getToolDefinitions('chat', { nodes: [] })
      .map((tool) => tool.function.name);

    expect(toolNames).toContain('write_file');
    expect(toolNames).toContain('save_product_document');
    expect(toolNames).toContain('get_document_writing_guide');
    expect(toolNames).not.toContain('generate_product_document');
    expect(toolNames).not.toContain('list_product_document_profiles');

    const chatPrompt = prompts.getSystemPrompt('chat', { nodes: [] });
    expect(chatPrompt).toContain('save_product_document');
    expect(chatPrompt).toContain('YOU are the document writer');
    expect(chatPrompt).not.toContain('CHOOSE DOCUMENT MODE');
  });

  it('indexes every digit-free event-table row instead of replacing the table header', () => {
    const events = [
      'minutes_consumed',
      '1_min_consumed',
      '2_min_consumed',
      '5_min_consumed',
      '10_min_consumed',
      'af_first_streamed',
      'af_three_video_consumed',
      'af_twenty_min_consumed',
    ];
    const prompt = [
      'Create a formal product document for the AppsFlyer playback workstream.',
      '',
      '## Event inventory',
      '| Event | Required | Scope |',
      '| --- | --- | --- |',
      ...events.map((event) => `| ${event} | Yes | In scope |`),
    ].join('\n');
    const index = buildSourceEvidenceIndex(
      emptyContext,
      { prompt },
      fixtureRegistry.getProfile('business_document/adaptive.v1'),
    );

    for (const event of events) {
      expect(index.units.some((unit) => unit.text.includes(event)), `missing source unit for ${event}`).toBe(true);
    }
  });
});


describe('non-publication review readiness', () => {
  it('keeps discussion items visible without reopening a ready artifact generation loop', async () => {
    const fixture = makeFixture();
    const artifact = await fixture.service.generate({
      profileId: 'op_roadmap_vision.v1',
      prompt: 'Draft an alignment operating plan without inventing evidence.',
      maturity: 'alignment',
      steMode: 'advisory',
      inputs: opInputs,
    });

    expect(artifact.openQuestions).not.toHaveLength(0);
    expect(artifact.state).toBe('ready_for_review');
  });
});

describe('artifact deletion and local export', () => {
  function fakeArtifact(artifactId: string, parentArtifactId?: string, content = `# Doc ${artifactId}\n\nBody of ${artifactId}.`) {
    return {
      artifactId,
      persisted: true,
      state: 'draft_review',
      profileId: 'op_roadmap_vision.v1',
      profileVersion: '1',
      title: `Title ${artifactId}`,
      content,
      checkerVersion: 'test-checker',
      validation: { status: 'not_checked' },
      createdAt: `2026-08-0${artifactId.length % 9 + 1}T00:00:00.000Z`,
      ...(parentArtifactId ? { parentArtifactId, revisionOrigin: 'owner_edit' as const } : {}),
    } as unknown as ProductDocumentArtifact;
  }

  function storeBackedService() {
    const store = createProductDocumentStore(new Database(':memory:'));
    const service = {
      listArtifacts: (limit: number) => store.list(limit),
      getArtifact: (artifactId: string) => store.get(artifactId),
      deleteArtifact: (artifactId: string) => store.remove(artifactId),
    } as unknown as ProductDocumentService;
    return { store, service };
  }

  it('removes one version and re-links its children to the deleted version parent', () => {
    const { store } = storeBackedService();
    store.save(fakeArtifact('root'));
    store.save(fakeArtifact('middle', 'root'));
    store.save(fakeArtifact('leaf', 'middle'));

    expect(store.remove('middle')).toBe(true);
    expect(store.get('middle')).toBeNull();
    const summaries = store.list(10);
    expect(summaries.map((entry) => entry.artifactId).sort()).toEqual(['leaf', 'root']);
    expect(summaries.find((entry) => entry.artifactId === 'leaf')?.parentArtifactId).toBe('root');
    expect(store.remove('middle')).toBe(false);
  });

  it('deletes artifacts over HTTP with strict id validation', async () => {
    const { store, service } = storeBackedService();
    store.save(fakeArtifact('keep'));
    store.save(fakeArtifact('gone', 'keep'));
    const app = buildApp(service);

    await request(app).delete('/api/product-documents/gone').expect(204);
    await request(app).get('/api/product-documents/gone').expect(404);
    await request(app).delete('/api/product-documents/gone').expect(404);
    await request(app).delete('/api/product-documents/bad%20id').expect(400);
    const remaining = await request(app).get('/api/product-documents').expect(200);
    expect(remaining.body.documents).toHaveLength(1);
  });

  it('exports markdown directly with a safe attachment filename', async () => {
    const { store, service } = storeBackedService();
    store.save(fakeArtifact('md-doc', undefined, '# Export me\n\nHello **world**.'));
    const app = buildApp(service);

    const response = await request(app)
      .get('/api/product-documents/md-doc/export?format=markdown')
      .expect(200);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-disposition']).toBe('attachment; filename="Title-md-doc.md"');
    expect(response.text).toBe('# Export me\n\nHello **world**.');

    await request(app).get('/api/product-documents/md-doc/export?format=rtf').expect(400);
    await request(app).get('/api/product-documents/absent/export?format=markdown').expect(404);
  });

  it('converts to HTML through the local pandoc install when available', async (ctx) => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const pandocAvailable = await promisify(execFile)('pandoc', ['--version'], { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!pandocAvailable) return ctx.skip();

    const { store, service } = storeBackedService();
    store.save(fakeArtifact('html-doc', undefined, '# Heading\n\nParagraph with **bold** text.'));
    const response = await request(buildApp(service))
      .get('/api/product-documents/html-doc/export?format=html')
      .expect(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['content-disposition']).toBe('attachment; filename="Title-html-doc.html"');
    const html = response.text;
    expect(html).toContain('<h1');
    expect(html).toContain('<strong>bold</strong>');
  });
});
