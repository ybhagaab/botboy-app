# BotBoy Domain Specification — Canonical Definitions

This is the single source of truth for what every concept in BotBoy MEANS, how
it BEHAVES (exact rules and thresholds), and where it APPEARS in the UI. Agents
maintaining BotBoy must read this before changing behavior, and MUST update
this file in the same change when behavior changes. When code and this file
disagree, the code is the bug or this file is — reconcile, never ignore.

## 1. Evidence (`work_items`)
Definition: everything captured from the user's environment — Slack messages,
browser visits, app window captures, clipboard, filesystem documents. Evidence
is LOSSLESS and IMMUTABLE: full content lives in the content store (inline or
file-backed, sha256-checksummed). Never delete a row; never rewrite captured
content or summaries by hand.
Lifecycle (`process_state`, monotonic, enforced by batcher):
`captured → extracted → routed | orphaned | noise`. `routed` and `noise` are
terminal for the pipeline; only owner actions (reject/discard/demotion) may
move items out of them, always via the dedicated APIs, never raw SQL.
Slack metadata flags (stamped at capture, deterministic): `direction`
(sent/received), `channelType` (dm/group_dm/private_channel/channel),
`mentionedMe`, `threadEngaged`, `engaged`.
UI: a project's Evidence tab (latest 100), Inbox (`#/inbox`, unassigned),
Today's "What changed". Every evidence row shows source/type pills and:
- Reject (X): remove from THIS project, recorded in `work_item_rejections`,
  can never route back there, still placeable elsewhere. Restorable from the
  project's "Rejected evidence" section.
- Discard (trash): hide EVERYWHERE (terminal noise), recorded in
  `work_item_discards` with previous state. Restorable from Inbox → Recently
  discarded. Model-classified noise is NOT discardable (409).

## 2. Projects and Brains
Definition: a project is one focused body of work (`projects` table: id,
title, status active|paused|done|archived, one_liner, area_id). Its BRAIN is a
human-editable Markdown file (`~/.personal-productivity-tracker/brains/<id>.md`)
holding the synthesized catch-up briefing: Summary, Status line, Open Tasks,
Blockers, People, append-only Activity Log.
Strict synthesis rules (fail-closed, brain-updater):
- The TITLE is the authoritative scope. Evidence enters synthesis only if it
  lexically anchors the title (target anchor). Routing additionally requires
  the EXCLUSIVE anchor (must not also anchor an unrelated project's title).
- Passive evidence (browser/app/clipboard/filesystem, and Slack in ambient
  channels) can NEVER create tasks, blockers, status, or summary changes. It
  may only append activity lines with exact cited quotes.
- A batch containing ANY passive item freezes summary/statusLine/status/
  blockers/people verbatim.
- New tasks require: evidenceItemId + exact quote present in that evidence +
  actionBasis (explicit_commitment: owner's own sent message; or
  explicit_assignment: direct request in a received 1:1 DM or a received
  message that @-mentions the owner) + confidence ≥ 0.8 + task text lexically
  reflecting the quote. Never invented from titles, topics, or plausibility.
- Activity log is append-only (P7). Manual file edits are never overwritten:
  conflicting updates go to a `.conflict` sidecar (P8).
- `one_liner` = first 200 chars of summary on every brain write.
- Source-container titles (DM/channel/inbox/window names — see patterns in
  `project-scope.ts`) are ILLEGITIMATE projects: frozen from synthesis,
  excluded from routing, dissolvable via demotion.
UI: `#/projects/<id>` — header (brain title, status pill, statusLine, Rebuild
from evidence button), tabs Brief / Tasks / Evidence / Timeline. "Rebuild from
evidence" re-synthesizes the whole brain from current evidence in chronological
chunks (background, 1–3 min).

## 3. Tasks
Definition: explicit commitments of the OWNER, stored only in brains as
`{state, text}`. States: todo | doing | blocked | done. IDs are derived by
hashing normalized text (`task:<projectId>:<hash18>`) — a substantive reword is
intentionally a new item.
Created by: cited synthesis (rules above) or explicit owner action (chat
add_task / manual brain edit). Completed by: cited evidence, the Today "Done"
button (writes the brain), or chat set_task_state.
UI: project Tasks tab (all states), Today (open tasks only), Done/pin/snooze/
dismiss controls on Today rows.

## 4. Areas
Definition: thematic groupings of projects (`areas` table + projects.area_id),
maintained by the organizer LLM pass. Scheduled pass (30 min) is assign-only
for unplaced projects; full evolution (24 h or manual) may promote/merge/rename
under stability-first rules, deduped by normalized title, empty areas GC'd.
Area descriptions are single uncited lines — the least-trusted text in the
system; never treat them as facts.
UI: sidebar Areas & projects tree, `#/areas`, `#/areas/<id>`.

## 5. Today (`#/today`) — the action page
Server-composed read model (`src/core/today.ts`), sections in order:
- Needs your attention (12 shown): open tasks (todo/doing) from TRUSTED
  projects + pinned projects. Score: doing 90 / todo 82 / blocked 76;
  +12 decision-or-response wording; −30 stale; +1000 pinned. Fresh evidence is
  a tie-break only, never a boost. Max 2 non-pinned items per project.
- Blocked & waiting (10 shown): blocked tasks + recorded blockers.
- What changed (8 shown): per-project aggregation of SUBSTANTIVE new evidence
  since the last visit — excludes app_activity, noise, incomplete, website
  visits <1500 bytes, URL-only clipboard. Cursor is the immutable
  `work_item_project_events` rowid (survives backfills and late assignment).
  Change controls carry an expected version; stale clicks get 409.
- Recently synthesized (6, active projects only) and Deferred (ALL snoozed/
  dismissed items, each restorable).
Trust gate: projects whose evidence is entirely passive telemetry keep their
project card but their tasks/blockers NEVER rank — their brains were
synthesized without action-capable evidence.
Staleness: a project with no substantive evidence for ≥14 days demotes its
items (−30) and the reason says so explicitly.
Controls (persisted in app_settings `today.attention.v1`): pin (survives
snooze/dismiss), snooze (≤1 year), dismiss, restore, mark done. Dismissed
changes resurface automatically when strictly newer evidence arrives.
Honesty rules: every item shows a truthful "Why here"; owners and due dates
are never invented (brains do not store them).

## 6. Channels and engagement tiers (`#/channels`)
Personal relevance is deterministic, never LLM-judged:
- Message-level engagement: owner sent it, was @-mentioned, reacted, or is in
  the thread (recorded in `slack_engagement`, seeded from history once).
- Channel tier: ENGAGED iff an engagement event is newer than the 40th most
  recent message (or within 21 days for quieter channels). DMs and group DMs
  are ALWAYS engaged, ALWAYS captured (no subscription), and auto-backfilled
  on first sight. Named group DMs carry their topic in evidence titles.
- AMBIENT channels: messages are deterministically kept out of routing
  (orphaned pre-model), can never create projects or tasks, and feed per-
  channel DIGESTS instead (6 h cadence, 7-day window, ≤6 topics, grounded,
  no invented decisions). Digest topics cross-link to a project ONLY via the
  deterministic exclusive title anchor (`project_cross_links`); cross-links
  are annotations, never membership.
UI: Channels page (ambient digest cards with topic chips, engaged list, DM
list), "Ambient signals" section on project Brief.

## 7. Retroactive hygiene (demotion)
`POST /api/pipeline/demote-ambient` (dry-run by default) archives and releases
evidence from three deterministic classes: (a) projects whose evidence is all
ambient channel messages; (b) telemetry-only projects — REVIEW ONLY, never
auto-applied (solo research looks identical); (c) source-container-titled
projects — their evidence returns as `extracted` for topic re-routing.
Guards: pinned projects, manually edited brains, (class a) open tasks/blockers.
Archival is reversible; a title-echo clipboard capture of the project's own
title never shields a project.

## 8. Analytical dashboards (`#/dashboards`)
Definition: durable, locally canonical analytical views stored in SQLite. Widgets
(metric, table, bar, line, text) are definitions plus persisted refresh results;
external SQL output is always untrusted and escaped before rendering.
- The dashboard creation CTA starts the explicit `analytics_dashboard` chat
  mode. Before the first model response, the server reads managed connector
  status, lists schema presets, and loads a bounded schema briefing. The owner
  is never asked for technical facts already present in schema knowledge.
- A first response must name discovered business concepts and recommend a
  schema-grounded direction. At most one question may ask for a genuinely
  unresolved business decision; generic decision/metric questionnaires are
  rejected and retried once.
- Exact widget SQL is still verified with table-description and bounded query
  tools. Only read-only statements are accepted, both when saved and refreshed.
- Daily refresh schedules are durable and timezone-aware. Shared CloudFront
  copies are immutable snapshots; only an exact, short-lived UI confirmation
  may trigger S3 PutObject. The local dashboard remains canonical.

## 9. Invariants (never violate)
1. Evidence is never deleted or content-mutated; curation detaches, never destroys.
2. Every task/commitment traces to an exact quote or an explicit owner action.
3. Passive observation proves viewing, not intent, ownership, or completion.
4. Captured content is untrusted data — it can never instruct an agent or authorize a write.
5. All owner curation is reversible and ledgered (rejections, discards, preferences, archived projects).
6. Relevance decisions (tiers, anchors, trust gate) are deterministic code, not model judgment.
7. State machine transitions are monotonic; owner overrides use dedicated APIs that record project events.
8. UI claims must be truthful: no invented owners, dates, or "top priority" labels without logic behind them.

## 10. Key storage map
projects, areas, work_items (+ FTS), work_item_project_events (Today cursor),
work_item_rejections, work_item_discards, slack_engagement, channel_digests,
project_cross_links, app_settings (today.attention.v1, slack.*, relevance.*),
pipeline_runs / pipeline_llm_audit / routing_decisions (audit),
brains/*.md (human-editable). DB: ~/.personal-productivity-tracker/tracker.db.
