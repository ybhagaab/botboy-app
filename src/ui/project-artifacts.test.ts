import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  beginProjectArtifactLoad,
  beginUnassignedArtifactLoad,
  completeProjectArtifactLoad,
  completeUnassignedArtifactLoad,
  failUnassignedArtifactLoad,
} from './project-artifacts.js';

describe('project artifact browser state', () => {
  it('preserves unassigned results when a later project response settles', () => {
    const loadingProject = beginProjectArtifactLoad({ artifacts: null, unassigned: null, attachOpen: true });
    const loadingBoth = beginUnassignedArtifactLoad(loadingProject);
    const unassignedFirst = completeUnassignedArtifactLoad(loadingBoth, [{ id: 'u1' }]);
    const projectLast = completeProjectArtifactLoad(unassignedFirst, [{ id: 'a1' }]);
    expect(projectLast).toMatchObject({
      artifacts: [{ id: 'a1' }], unassigned: [{ id: 'u1' }],
      loading: false, unassignedLoading: false, attachOpen: true,
    });
  });

  it('preserves project results when a later unassigned response settles', () => {
    const loadingBoth = beginUnassignedArtifactLoad(beginProjectArtifactLoad({ artifacts: null, unassigned: null }));
    const projectFirst = completeProjectArtifactLoad(loadingBoth, [{ id: 'a1' }]);
    const unassignedLast = completeUnassignedArtifactLoad(projectFirst, [{ id: 'u1' }]);
    expect(unassignedLast).toMatchObject({
      artifacts: [{ id: 'a1' }], unassigned: [{ id: 'u1' }],
      loading: false, unassignedLoading: false,
    });
  });

  it('turns unassigned failure into a retryable terminal state', () => {
    const failed = failUnassignedArtifactLoad(beginUnassignedArtifactLoad({ artifacts: [] }), 'network unavailable');
    expect(failed).toMatchObject({ unassignedLoading: false, unassignedError: 'network unavailable', attachOpen: true });
  });

  it('keeps activation, tool invalidation, lazy disclosure, retry, and 409 refresh seams wired', () => {
    const dashboard = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');
    const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
    expect(dashboard).toContain("loadProjectArtifacts(state.route.projectId, { force: true })");
    expect(dashboard).toContain("window.addEventListener('botboy:project-artifact-changed'");
    expect(dashboard).toContain("event.target?.matches?.('.project-artifact-attach')");
    expect(dashboard).toContain('void loadUnassignedArtifacts(state.route.projectId)');
    expect(dashboard).toContain("data-action=\"artifact-retry-unassigned\"");
    expect(dashboard).toContain("if (/HTTP 409|changed/i.test");
    expect(dashboard).not.toContain('autoOpenAttach');
    expect(app).toContain("new CustomEvent('botboy:project-artifact-changed'");
  });
});
