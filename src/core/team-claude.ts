/**
 * Claude on the team gateway (owner request 2026-11-13: "no new key should be needed by any teammates, same existing
 * mantle key, gives them claude models along with sol models"; docs/maps/team-claude.md).
 *
 * The gateway's general Mantle connector target (`bedrock-mantle-luna`, us-east-1) forwards Anthropic's Messages API
 * (`/inference/v1/messages` → Mantle `/anthropic/v1/messages`) with the gateway's own IAM role, so every teammate's existing
 * gateway credential (Cognito client id/secret) reaches these models. The connector lists Mantle's models itself; a model
 * Mantle adds later needs one `SynchronizeGatewayTargets` on that target (docs/CREDENTIALS_RUNBOOK.md).
 *
 * This module is Operating Knowledge only: which Claude models the team offers, their titles, and the profile the Messages
 * client shapes each request from. Opus 5.5 was live-verified through the gateway on 2026-11-13 after that sync; Fable 5 is
 * refused by Mantle under the account's default data-retention mode (dropped by the owner); Sonnet 5.5 is not on Mantle in
 * any region checked.
 */
import { KNOWN_PROFILES, type AnthropicModelProfile } from './anthropic-models.js';

export interface TeamClaudeModel {
  /** Picker key after `team.` (stable; stored in chats and jobs). */
  readonly key: string;
  readonly label: string;
  /** Mantle's model id; the wire id is the gateway target prefix plus this. */
  readonly bareId: string;
  /** Anthropic's own id, which the known-model table and the request shaping read. */
  readonly profileId: string;
  readonly line: 'opus' | 'sonnet' | 'haiku';
}

/** In picker order: the newest and strongest first. */
export const TEAM_CLAUDE_MODELS: readonly TeamClaudeModel[] = Object.freeze([
  Object.freeze({ key: 'claude-opus-5-5', label: 'Claude Opus 5.5', bareId: 'anthropic.claude-opus-5-5', profileId: 'claude-opus-5-5', line: 'opus' as const }),
  Object.freeze({ key: 'claude-opus-5', label: 'Claude Opus 5', bareId: 'anthropic.claude-opus-5', profileId: 'claude-opus-5', line: 'opus' as const }),
  Object.freeze({ key: 'claude-sonnet-5', label: 'Claude Sonnet 5', bareId: 'anthropic.claude-sonnet-5', profileId: 'claude-sonnet-5', line: 'sonnet' as const }),
  Object.freeze({ key: 'claude-opus-4-8', label: 'Claude Opus 4.8', bareId: 'anthropic.claude-opus-4-8', profileId: 'claude-opus-4-8', line: 'opus' as const }),
]);

export const TEAM_CLAUDE_FAMILY = 'Claude';
/** Anthropic documents a 1M-token window and 128K output for these models; BotBoy's own context budget is far smaller. */
const TEAM_CLAUDE_CONTEXT_TOKENS = 1_000_000;
const TEAM_CLAUDE_MAX_OUTPUT_TOKENS = 128_000;

/** The exact wire id for one model behind a gateway target prefix (`bedrock-mantle-luna/`). */
export function teamClaudeWireModel(targetPrefix: string, model: TeamClaudeModel): string {
  return `${targetPrefix}${model.bareId}`;
}

/**
 * The profile the Messages client shapes a request from. Mantle's Anthropic path lists no models, so the forms come from
 * the known-model table (capabilities and table agree by construction, so the stricter-shape rule changes nothing).
 */
export function teamClaudeProfile(model: TeamClaudeModel): AnthropicModelProfile {
  const known = KNOWN_PROFILES[model.profileId];
  if (!known) throw new Error(`No known profile for ${model.profileId}`);
  return Object.freeze({
    id: model.profileId,
    name: model.label,
    line: model.line,
    lifecycle: 'active' as const,
    retiresAt: null,
    contextWindow: TEAM_CLAUDE_CONTEXT_TOKENS,
    maxOutputTokens: TEAM_CLAUDE_MAX_OUTPUT_TOKENS,
    images: true,
    structuredOutputs: true,
    thinking: known.thinking,
    effort: known.effort,
  });
}

/** Profiles by wire id, for the Messages client's per-call lookup. */
export function teamClaudeProfiles(targetPrefix: string): ReadonlyMap<string, AnthropicModelProfile> {
  return new Map(TEAM_CLAUDE_MODELS.map(model => [teamClaudeWireModel(targetPrefix, model), teamClaudeProfile(model)] as const));
}

/** The gateway's Messages base: the Messages client appends `/v1/messages` to it (`…/inference/v1` → `…/inference`). */
export function gatewayMessagesBase(gatewayEndpoint: string): string {
  return gatewayEndpoint.replace(/\/+$/, '').replace(/\/v1$/, '');
}
