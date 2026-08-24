import { Router, type Request, type Response } from 'express';
import { createPageLayoutService, type LayoutScope } from '../../core/page-layouts.js';
import {
  createWorkspaceCatalogService,
  type WorkspaceActor,
  type WorkspaceCommandContext,
} from '../../core/workspace-catalog.js';
import { paramStr, type RouterDeps } from './deps.js';

function isSameOriginMutation(req: Request): boolean {
  const origin = req.get('origin');
  if (!origin) return true; // Native app, tests, and local agent clients omit Origin.
  const host = req.get('host');
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function commandContext(req: Request): WorkspaceCommandContext {
  const requestedActor = req.get('x-botboy-actor');
  const actor: WorkspaceActor = requestedActor === 'agent' || requestedActor === 'system'
    ? requestedActor
    : 'ui';
  const rawCommandId = req.get('x-botboy-command-id')?.trim();
  return {
    actor,
    commandId: rawCommandId ? rawCommandId.slice(0, 160) : undefined,
  };
}

function parseScope(value: string): LayoutScope | null {
  return value === 'area' || value === 'project' ? value : null;
}

function sendMutationError(res: Response, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const status = /not found/i.test(message)
    ? 404
    : /version conflict|already exists|manual edits|contains \d+ project|evidence item|changed before deletion|is archived/i.test(message)
      ? 409
      : 400;
  return res.status(status).json({ error: message });
}

export function createWorkspaceRouter(deps: RouterDeps): Router {
  const router = Router();
  const catalog = deps.db && deps.brainStore
    ? createWorkspaceCatalogService({ db: deps.db, brainStore: deps.brainStore })
    : null;
  const layouts = deps.db ? createPageLayoutService({ db: deps.db }) : null;

  const rejectCrossOrigin = (req: Request, res: Response): boolean => {
    if (isSameOriginMutation(req)) return false;
    res.status(403).json({ error: 'Cross-origin workspace mutation rejected' });
    return true;
  };

  router.get('/workspace/areas', (req: Request, res: Response) => {
    if (!catalog) return res.status(503).json({ error: 'Workspace catalog is unavailable' });
    const areas = catalog.listAreas(req.query.includeArchived === 'true');
    return res.json({ areas, count: areas.length });
  });

  router.get('/workspace/areas/:id', (req: Request, res: Response) => {
    if (!catalog) return res.status(503).json({ error: 'Workspace catalog is unavailable' });
    const area = catalog.getArea(paramStr(req.params.id));
    return area ? res.json({ area }) : res.status(404).json({ error: 'Area not found' });
  });

  router.post('/workspace/areas', (req: Request, res: Response) => {
    if (!catalog) return res.status(503).json({ error: 'Workspace catalog is unavailable' });
    if (rejectCrossOrigin(req, res)) return;
    try {
      return res.status(201).json({ area: catalog.createArea(req.body ?? {}, commandContext(req)) });
    } catch (error) {
      return sendMutationError(res, error);
    }
  });

  router.patch('/workspace/areas/:id', (req: Request, res: Response) => {
    if (!catalog) return res.status(503).json({ error: 'Workspace catalog is unavailable' });
    if (rejectCrossOrigin(req, res)) return;
    try {
      return res.json({ area: catalog.updateArea(paramStr(req.params.id), req.body ?? {}, commandContext(req)) });
    } catch (error) {
      return sendMutationError(res, error);
    }
  });

  router.post('/workspace/areas/:id/archive', (req: Request, res: Response) => {
    if (!catalog) return res.status(503).json({ error: 'Workspace catalog is unavailable' });
    if (rejectCrossOrigin(req, res)) return;
    try {
      return res.json({ area: catalog.archiveArea(paramStr(req.params.id), req.body ?? {}, commandContext(req)) });
    } catch (error) {
      return sendMutationError(res, error);
    }
  });

  router.post('/workspace/areas/:id/restore', (req: Request, res: Response) => {
    if (!catalog) return res.status(503).json({ error: 'Workspace catalog is unavailable' });
    if (rejectCrossOrigin(req, res)) return;
    try {
      return res.json({ area: catalog.restoreArea(paramStr(req.params.id), req.body ?? {}, commandContext(req)) });
    } catch (error) {
      return sendMutationError(res, error);
    }
  });

  router.delete('/workspace/areas/:id', (req: Request, res: Response) => {
    if (!catalog) return res.status(503).json({ error: 'Workspace catalog is unavailable' });
    if (rejectCrossOrigin(req, res)) return;
    try {
      return res.json(catalog.deleteArea(paramStr(req.params.id), req.body ?? {}, commandContext(req)));
    } catch (error) {
      return sendMutationError(res, error);
    }
  });

  router.get('/workspace/projects', (req: Request, res: Response) => {
    if (!catalog) return res.status(503).json({ error: 'Workspace catalog is unavailable' });
    const projects = catalog.listProjects(req.query.includeArchived === 'true');
    return res.json({ projects, count: projects.length });
  });

  router.get('/workspace/projects/:id', (req: Request, res: Response) => {
    if (!catalog) return res.status(503).json({ error: 'Workspace catalog is unavailable' });
    const project = catalog.getProject(paramStr(req.params.id));
    return project ? res.json({ project }) : res.status(404).json({ error: 'Project not found' });
  });

  router.post('/workspace/projects', (req: Request, res: Response) => {
    if (!catalog) return res.status(503).json({ error: 'Workspace catalog is unavailable' });
    if (rejectCrossOrigin(req, res)) return;
    try {
      return res.status(201).json({ project: catalog.createProject(req.body ?? {}, commandContext(req)) });
    } catch (error) {
      return sendMutationError(res, error);
    }
  });

  router.patch('/workspace/projects/:id', (req: Request, res: Response) => {
    if (!catalog) return res.status(503).json({ error: 'Workspace catalog is unavailable' });
    if (rejectCrossOrigin(req, res)) return;
    try {
      return res.json({ project: catalog.updateProject(paramStr(req.params.id), req.body ?? {}, commandContext(req)) });
    } catch (error) {
      return sendMutationError(res, error);
    }
  });

  router.post('/workspace/projects/:id/move', (req: Request, res: Response) => {
    if (!catalog) return res.status(503).json({ error: 'Workspace catalog is unavailable' });
    if (rejectCrossOrigin(req, res)) return;
    try {
      return res.json({ project: catalog.moveProject(paramStr(req.params.id), req.body ?? {}, commandContext(req)) });
    } catch (error) {
      return sendMutationError(res, error);
    }
  });

  router.post('/workspace/projects/:id/archive', (req: Request, res: Response) => {
    if (!catalog) return res.status(503).json({ error: 'Workspace catalog is unavailable' });
    if (rejectCrossOrigin(req, res)) return;
    try {
      return res.json({ project: catalog.archiveProject(paramStr(req.params.id), req.body ?? {}, commandContext(req)) });
    } catch (error) {
      return sendMutationError(res, error);
    }
  });

  router.post('/workspace/projects/:id/restore', (req: Request, res: Response) => {
    if (!catalog) return res.status(503).json({ error: 'Workspace catalog is unavailable' });
    if (rejectCrossOrigin(req, res)) return;
    try {
      return res.json({ project: catalog.restoreProject(paramStr(req.params.id), req.body ?? {}, commandContext(req)) });
    } catch (error) {
      return sendMutationError(res, error);
    }
  });

  router.delete('/workspace/projects/:id', (req: Request, res: Response) => {
    if (!catalog) return res.status(503).json({ error: 'Workspace catalog is unavailable' });
    if (rejectCrossOrigin(req, res)) return;
    try {
      return res.json(catalog.deleteProject(paramStr(req.params.id), req.body ?? {}, commandContext(req)));
    } catch (error) {
      return sendMutationError(res, error);
    }
  });

  router.get('/page-layouts/templates', (_req: Request, res: Response) => {
    if (!layouts) return res.status(503).json({ error: 'Page layouts are unavailable' });
    const templates = layouts.listTemplates();
    return res.json({ templates, count: templates.length });
  });

  router.get('/page-layouts/:scopeType/:scopeId', (req: Request, res: Response) => {
    if (!layouts) return res.status(503).json({ error: 'Page layouts are unavailable' });
    const scope = parseScope(paramStr(req.params.scopeType));
    if (!scope) return res.status(400).json({ error: 'scopeType must be area or project' });
    return res.json({ layout: layouts.getLayout(scope, paramStr(req.params.scopeId)) });
  });

  router.put('/page-layouts/:scopeType/:scopeId', (req: Request, res: Response) => {
    if (!layouts) return res.status(503).json({ error: 'Page layouts are unavailable' });
    if (rejectCrossOrigin(req, res)) return;
    try {
      const context = commandContext(req);
      const layout = layouts.setLayout({
        ...(req.body ?? {}),
        scopeType: paramStr(req.params.scopeType),
        scopeId: paramStr(req.params.scopeId),
        updatedBy: context.actor,
      });
      return res.json({ layout });
    } catch (error) {
      return sendMutationError(res, error);
    }
  });

  router.delete('/page-layouts/:scopeType/:scopeId', (req: Request, res: Response) => {
    if (!layouts) return res.status(503).json({ error: 'Page layouts are unavailable' });
    if (rejectCrossOrigin(req, res)) return;
    try {
      layouts.resetLayout({
        scopeType: paramStr(req.params.scopeType),
        scopeId: paramStr(req.params.scopeId),
        expectedVersion: req.body?.expectedVersion,
      });
      return res.json({ ok: true, layout: null });
    } catch (error) {
      return sendMutationError(res, error);
    }
  });

  return router;
}
