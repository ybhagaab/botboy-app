/**
 * Slack routes — joined-conversation discovery, the DB-backed watched channel
 * config with monitor hot-reload, and history backfill.
 *
 * Backfill triggers:
 *   - automatic: PUT /slack/config diffs the persisted set and backfills any
 *     newly added channel that has no completion marker (fire-and-forget)
 *   - manual: POST /slack/backfill { channelId, days?, maxMessages? } → 202
 *   - observability: GET /slack/backfill/status → in-flight + completion markers
 */

import { Router, Request, Response } from 'express';
import { WebClient } from '@slack/web-api';
import { collectConversationRecords } from '../../monitors/slack-mcp-client.js';
import {
  getChannelConfig,
  setChannelConfig,
  listJoinedConversations,
  toJoinedConversation,
  type JoinedConversation,
} from '../../core/slack-config.js';
import { getSetting } from '../../core/storage.js';
import { readLocalEnvValue, upsertLocalEnvValue } from '../../core/local-env.js';
import { loadEnv } from '../../monitors/slack-monitor.js';
import type { RouterDeps } from './deps.js';

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** Secret-bearing routes stay on the local machine boundary. */
function acceptsLocalSecretRequest(req: Request, res: Response): boolean {
  if (isLoopbackAddress(req.socket.remoteAddress) && isLoopbackAddress(req.socket.localAddress)) return true;
  res.status(403).json({ error: 'Token management is available only through the local BotBoy dashboard' });
  return false;
}

function maskToken(token: string | undefined): string | null {
  if (!token || token.length < 12) return null;
  return `${token.slice(0, 5)}…${token.slice(-4)}`;
}

/** app_settings key recording a completed backfill for a channel. */
const backfillMarkerKey = (channelId: string) => `slack.backfill.${channelId}`;

export function createSlackRouter(deps: RouterDeps): Router {
  const router = Router();

  // ── Slack channel config ──

  // Short-lived cache: walking Slack's paginated conversation list takes
  // seconds for hundreds of conversations, and the panel refreshes on every
  // open. Two minutes keeps the list effectively live (membership changes
  // show on the next open after the TTL) without the multi-second wait.
  const CONVERSATIONS_CACHE_TTL_MS = 2 * 60 * 1000;
  let conversationsCache: { at: number; data: JoinedConversation[] } | null = null;
  let conversationsInFlight: Promise<JoinedConversation[]> | null = null;

  /** Channel picker via the managed Slack MCP: one paged list_channels walk
   * over every conversation kind, mapped through the same normalizer as the
   * token route so the picker payload is transport-identical. */
  async function listConversationsViaMcp(): Promise<JoinedConversation[]> {
    const manager = deps.mcpManager;
    if (!manager) throw new Error('MCP manager unavailable');
    const out: JoinedConversation[] = [];
    const seen = new Set<string>();
    // One kind per request: combined requests underreport channels, and each
    // kind has a stable shape (sections for channels, flat lists for DMs).
    for (const kind of ['public_and_private', 'dm', 'group_dm'] as const) {
      let cursor: string | undefined;
      for (let page = 0; page < 12; page++) {
        const result = await manager.callTool('slack', 'list_channels', {
          channelTypes: [kind],
          limit: 200,
          ...(cursor ? { cursor } : {}),
        }, { source: 'api', timeoutMs: 90_000 });
        if (result.isError) throw new Error(result.text.slice(0, 300));
        const payload = JSON.parse(result.text);
        for (const ch of collectConversationRecords(payload)) {
          if (ch?.id && !ch.is_archived && !seen.has(ch.id)) {
            seen.add(ch.id);
            out.push(toJoinedConversation(ch));
          }
        }
        const next = payload?.response_metadata?.next_cursor || payload?.next_cursor;
        cursor = typeof next === 'string' && next.length > 0 ? next : undefined;
        if (!cursor) break;
      }
    }
    return out;
  }

  async function slackMcpRunning(): Promise<boolean> {
    try {
      const snapshot = await deps.mcpManager?.getServer('slack');
      return snapshot?.state === 'running';
    } catch { return false; }
  }

  async function fetchJoinedConversations(web: RouterDeps['slackWebClient']): Promise<JoinedConversation[]> {
    if (conversationsCache && Date.now() - conversationsCache.at < CONVERSATIONS_CACHE_TTL_MS) {
      return conversationsCache.data;
    }
    if (!conversationsInFlight) {
      conversationsInFlight = (async () => {
        const out: JoinedConversation[] = [];
        if (await slackMcpRunning()) {
          out.push(...await listConversationsViaMcp());
        } else if (web) {
          for await (const c of listJoinedConversations(web)) out.push(c);
        } else {
          throw new Error('Slack is not connected: start the Slack MCP connection or configure a user token');
        }
        conversationsCache = { at: Date.now(), data: out };
        return out;
      })().finally(() => { conversationsInFlight = null; });
    }
    return conversationsInFlight;
  }

  router.get('/slack/conversations', async (_req: Request, res: Response) => {
    if (!deps.slackMonitor) {
      return res.status(503).json({ error: 'Slack capture is not running' });
    }
    try {
      res.json({ conversations: await fetchJoinedConversations(deps.slackWebClient) });
    } catch (err: any) {
      res.status(502).json({ error: `Slack API error: ${err?.data?.error || err.message}` });
    }
  });

  // ── Slack user token (dashboard onboarding) ──
  // The token the RUNNING monitor booted with; a differing saved value means
  // a restart is needed before the new token takes effect.
  const bootToken = process.env.SLACK_USER_TOKEN || loadEnv().SLACK_USER_TOKEN || '';

  router.get('/slack/token/status', (req: Request, res: Response) => {
    if (!acceptsLocalSecretRequest(req, res)) return;
    const saved = readLocalEnvValue('SLACK_USER_TOKEN') || process.env.SLACK_USER_TOKEN || '';
    res.json({
      configured: saved.length > 0,
      tokenMasked: maskToken(saved),
      captureMode: deps.slackMonitor?.getCaptureMode?.() ?? 'disabled',
      restartPending: saved.length > 0 && saved !== bootToken,
    });
  });

  router.put('/slack/token', async (req: Request, res: Response) => {
    if (!acceptsLocalSecretRequest(req, res)) return;
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token) return res.status(400).json({ error: 'token is required' });
    if (token.startsWith('xoxb-')) {
      return res.status(400).json({
        error: 'That is the Bot User OAuth Token (xoxb). BotBoy needs the User OAuth Token (xoxp) — the one shown ABOVE it on the app\'s OAuth & Permissions page — so capture sees your own channels and DMs.',
      });
    }
    if (!token.startsWith('xoxp-') || token.length < 20 || token.length > 300) {
      return res.status(400).json({ error: 'Expected a Slack User OAuth Token starting with xoxp-' });
    }
    // Verify against Slack BEFORE persisting, and show the owner exactly whose
    // identity this token carries. Nothing is written when verification fails.
    let identity: { user: string; team: string };
    try {
      const auth = await new WebClient(token).auth.test();
      identity = { user: String(auth.user ?? ''), team: String(auth.team ?? '') };
    } catch (err: any) {
      return res.status(400).json({ error: `Slack rejected the token: ${err?.data?.error || err.message}` });
    }
    try {
      upsertLocalEnvValue('SLACK_USER_TOKEN', token);
    } catch (err: any) {
      return res.status(500).json({ error: `Could not save the token: ${err?.message ?? err}` });
    }
    res.json({
      saved: true,
      identity,
      tokenMasked: maskToken(token),
      restartRequired: token !== bootToken,
    });
  });

  router.get('/slack/config', (_req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'DB not available' });
    res.json({ ids: getChannelConfig(db) });
  });

  router.put('/slack/config', (req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'DB not available' });
    const body = req.body;
    if (!Array.isArray(body?.ids) || !body.ids.every((s: unknown) => typeof s === 'string')) {
      return res.status(400).json({
        error: 'Expected JSON body of shape { "ids": string[] }',
      });
    }
    const previous = new Set(getChannelConfig(db));
    const persisted = setChannelConfig(db, body.ids);
    deps.slackMonitor?.setWatchedChannels(persisted);

    // History backfill for newly added channels (fire-and-forget so the
    // config save stays instant). Channels with a completion marker are
    // skipped — remove-then-re-add doesn't refetch; use the manual POST
    // endpoint to force one. Failures only log: the config change itself
    // succeeded, and a manual retry stays available.
    const added = persisted.filter((id) => !previous.has(id));
    for (const id of added) {
      if (getSetting(db, backfillMarkerKey(id))) continue;
      deps.slackMonitor?.backfillChannel?.(id)
        .then((r) => {
          if (r.error) console.warn(`[Slack] auto-backfill ${id} failed: ${r.error}`);
        })
        .catch((err) => console.warn(`[Slack] auto-backfill ${id} crashed: ${err?.message ?? err}`));
    }

    res.json({ ids: persisted });
  });

  // ── History backfill (manual trigger + status) ──

  router.post('/slack/backfill', (req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'DB not available' });
    const monitor = deps.slackMonitor;
    if (!monitor?.backfillChannel) {
      return res.status(503).json({ error: 'Slack monitor not available' });
    }
    const { channelId, days, maxMessages } = req.body ?? {};
    if (typeof channelId !== 'string' || channelId.length === 0) {
      return res.status(400).json({ error: 'channelId (string) is required' });
    }
    if (days !== undefined && (typeof days !== 'number' || days <= 0)) {
      return res.status(400).json({ error: 'days must be a positive number' });
    }
    if (maxMessages !== undefined && (typeof maxMessages !== 'number' || maxMessages <= 0)) {
      return res.status(400).json({ error: 'maxMessages must be a positive number' });
    }
    if (monitor.backfillStatus?.().inFlight.includes(channelId)) {
      return res.status(409).json({ error: `Backfill already running for ${channelId}` });
    }

    // Fire-and-forget: a large channel can take minutes (paging + Tier-3
    // rate limits). Progress lands in the status endpoint + app log.
    monitor.backfillChannel(channelId, { oldestDays: days, maxMessages })
      .then((r) => {
        if (r.error) console.warn(`[Slack] manual backfill ${channelId} failed: ${r.error}`);
      })
      .catch((err) => console.warn(`[Slack] manual backfill ${channelId} crashed: ${err?.message ?? err}`));

    res.status(202).json({ started: true, channelId });
  });

  router.get('/slack/backfill/status', (_req: Request, res: Response) => {
    const db = deps.db;
    if (!db) return res.status(503).json({ error: 'DB not available' });
    const inFlight = deps.slackMonitor?.backfillStatus?.().inFlight ?? [];
    const rows = db
      .prepare("SELECT key, value FROM app_settings WHERE key LIKE 'slack.backfill.%'")
      .all() as { key: string; value: string }[];
    const completed: Record<string, unknown> = {};
    for (const row of rows) {
      const channelId = row.key.slice('slack.backfill.'.length);
      try { completed[channelId] = JSON.parse(row.value); } catch { completed[channelId] = row.value; }
    }
    res.json({ inFlight, completed });
  });

  return router;
}
