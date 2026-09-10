import { Router, Request, Response } from 'express';
import { paramStr, type RouterDeps } from './deps.js';
import { VisualAssetError } from '../../core/visual-assets.js';

/** ID-only owner preview for immutable local visual originals. */
export function createVisualAssetsRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/visual-assets/:assetId/original', (req: Request, res: Response) => {
    if (!deps.visualAssets) return res.status(503).json({ error: 'visual asset registry unavailable' });
    try {
      const assetId = String(req.params.assetId ?? '');
      const versionId = paramStr(req.query.versionId as any);
      const resolved = deps.visualAssets.resolveOriginalPath(assetId, versionId);
      res.setHeader('Content-Type', resolved.record.mime);
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.setHeader('ETag', `"${resolved.record.sha256}"`);
      res.sendFile(resolved.path);
    } catch (error) {
      if (error instanceof VisualAssetError) {
        const status = error.code === 'VISUAL_ASSET_NOT_FOUND' || error.code === 'VISUAL_ORIGINAL_MISSING' ? 404 : 422;
        return res.status(status).json({ error: error.message, code: error.code, nextAction: error.nextAction });
      }
      return res.status(500).json({ error: String((error as Error)?.message ?? error) });
    }
  });

  return router;
}
