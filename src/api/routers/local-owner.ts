import type { Request, Response } from 'express';

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Require both ends of the socket and any browser Origin to identify this
 * exact loopback app. Omitted Origin remains valid for native clients and
 * Supertest; explicit owner attestation is checked separately by each
 * mutation because JSON and raw-body routes carry it differently.
 */
export function requireLocalOwnerRequest(
  req: Request,
  res: Response,
  label = 'Analytics owner request',
): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress) || !isLoopbackAddress(req.socket.localAddress)) {
    res.status(403).json({ error: `${label} is local-only.` });
    return false;
  }
  const origin = req.get('origin');
  if (origin) {
    try {
      const parsed = new URL(origin);
      const hostname = parsed.hostname.toLowerCase();
      const loopbackHost = hostname === 'localhost' || hostname === '127.0.0.1'
        || hostname === '[::1]' || hostname === '::1';
      const originPort = Number(parsed.port || (parsed.protocol === 'http:' ? 80 : 443));
      if (parsed.protocol !== 'http:' || !loopbackHost || originPort !== req.socket.localPort) {
        res.status(403).json({ error: `${label} origin does not match this loopback app.` });
        return false;
      }
    } catch {
      res.status(403).json({ error: `${label} origin is malformed.` });
      return false;
    }
  }
  return true;
}

export function requireLocalOwnerMutation(req: Request, res: Response): boolean {
  return requireLocalOwnerRequest(req, res, 'Analytics owner mutation');
}

/**
 * Effects reserved for a rendered owner control additionally require a real
 * same-origin browser request. Native/no-Origin clients remain valid for read
 * and staging APIs but cannot mint or retry an import approval.
 */
export function requireLocalOwnerUiRequest(
  req: Request,
  res: Response,
  label = 'Owner UI action',
  nextAction = 'Open the Data Room import review and use its owner control.',
): boolean {
  if (!requireLocalOwnerRequest(req, res, label)) return false;
  if (!req.get('origin')) {
    res.status(403).json({
      error: `${label} requires the same-origin BotBoy owner interface.`,
      code: 'owner_action_required',
      nextAction,
    });
    return false;
  }
  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite !== 'same-origin') {
    res.status(403).json({
      error: `${label} requires a same-origin browser navigation context.`,
      code: 'owner_action_required',
      nextAction,
    });
    return false;
  }
  return true;
}
