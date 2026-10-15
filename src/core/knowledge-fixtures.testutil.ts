/**
 * Synthetic knowledge sets for tests and the dev-only live check. Fictional domains only (a shop, a streaming
 * service); nothing here is anyone's real business content (`repos-and-releases.md`, "no owner business content").
 *
 * `SHOP_GUIDE` and `STREAM_GUIDE` are lookalikes of the two hand-written guides the owner supplied as models: the same
 * sections, table columns, heading shapes and bullet styles, at about the same sizes (5 KB and 8 KB), so the token
 * bounds asserted against them mean something.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The smaller lookalike: a plain five-column table, `### Label (`file`)` methodology, plain Do NOT bullets. */
export const SHOP_GUIDE = `# Shopwave Order Data Documentation — Steering Guide

Meta-guide for maintaining all reference documentation that powers the order-data queries and the shop analytics agent.

## File Ecosystem

| File | Path | Loading Mechanism | Purpose | Audience |
|------|------|-------------------|---------|----------|
| \`orders.md\` | shop-data/ | Context preset (always loaded) | SQL schemas, performance rules, query patterns, table routing | All query users (local + agent) |
| \`orders_analysis.md\` | shop-data/ | Context preset 2 (always loaded) | Analysis methodology, basket patterns, repeat purchase, cannibalization | Analytics agent |
| \`ORDERS_TABLE_REFERENCE.md\` | shop-data/ | Agent supplementary file (loaded every turn) | Complete table schemas, all columns, all events, join patterns | Analytics agent |
| \`SHOP_PRODUCT_GUIDE.md\` | shop-data/ | Agent reference document (always loaded) | Business logic, checkout flows, product rules, loyalty | Analytics agent |
| \`.kiro/steering/shop-data-docs.md\` | this file | Developer steering | Meta-guide for maintaining all files | Maintainers |

> **Note:** The agent also has a data dictionary file loaded alongside the Product Guide. That file lives outside this folder and is managed in the agent configuration directly, not here.

## Change Methodology

### Context File (\`orders.md\`)
- Optimized query patterns, performance rules, table schemas
- Changes must be verified against real query performance
- No hardcoded dates or ids — use placeholders
- Must be synced to the shared contexts folder after changes

### Analysis Methodology File (\`orders_analysis.md\`)
- Analysis methodology only, no table schemas
- Add new analysis patterns or refine existing phases
- Keep the repeat-purchase and cannibalization methodology

### Table Reference (\`ORDERS_TABLE_REFERENCE.md\`)
- Complete technical reference
- Add new columns, events, or tables discovered through codebase analysis or database exploration

### Product Guide (\`SHOP_PRODUCT_GUIDE.md\`)
- Product logic, checkout flows, business rules
- Sections should be self-contained (~200-300 words) for readability and easy reference
- Changes should reflect product changes

## Guardrails

- Do NOT add hardcoded dates, order ids, or time-specific metrics to the Context File or the Table Reference
- Do NOT duplicate table schemas across files — the Context File is the authority for query-critical schemas, the Table Reference for complete schemas
- Do NOT add agent-specific constraints to the Context File (it is shared with local users)
- Do NOT add query patterns to the Analysis Methodology File — those belong in the Context File
- Do NOT add schema or column information to the Product Guide — it is for product logic only
- When adding new information, check all files for conflicts before committing
- \`channel_source\` values can change over time — run discovery queries periodically

## Conflict Priority Order

Context File > Table Reference > Analysis Methodology File > Product Guide

## File TOC Summaries

### orders.md
- Connection details, base filters, query performance rules
- Channel source reference (with a marketplace exception), table routing guide
- 13 table schemas (including attribution install tables with device hygiene rules for opted-out sentinels), storefront variants, page types
- Hourly analysis, common query patterns, product-level performance
- Banner attribution methodology, complex analysis guidelines, guardrail

### orders_analysis.md
- Performance lessons, demographics pattern, persona segmentation pattern
- Channel mapping, repeat purchase analysis, attribution rules
- 9-phase campaign analysis methodology
- Attribution methodology (5-layer pipeline, cohort build, hybrid rules, retention, organic conversion, opted-out devices)
- Key insights checklist

### ORDERS_TABLE_REFERENCE.md
- Complete 90-column order table schema
- 87-column interaction table schema, 45-column ads table schema
- Membership table, storefront variants, page types, event volumes
- Price lock mechanism, cross-promotion events
- Age and gender table, persona table, query performance tips

### SHOP_PRODUCT_GUIDE.md
- What the shop is, user entry points, top-level navigation
- Product page, wishlist, data refresh and caching
- Loyalty (3 systems), membership, continue shopping
- Sharing, age verification, reseller definition, analytics nuances
`;

/** The larger lookalike: bold Do NOT bullets, a numbered list, a Path column of sub-folders, longer methodology. */
export const STREAM_GUIDE = `# Streamly Content Analytics Documentation — Steering Guide

Meta-guide for maintaining all analytics documentation files that power the SQL tool and the viewing analytics agent. Read this before changing any of them.

## File Ecosystem

| File | Path | Loading Mechanism | Purpose | Audience |
|------|------|-------------------|---------|----------|
| \`streamly.md\` | streamly-analytics/ | Context preset (always loaded) | SQL schemas, performance rules, query patterns, table routing, join keys | All query users (local + agent) |
| \`streamly_analysis.md\` | streamly-analytics/ | Context preset 2 (always loaded) | Analysis methodology, campaign patterns, retention, cannibalization, cohort rules | Analytics agent |
| \`STREAMLY_TABLE_REFERENCE.md\` | streamly-analytics/ | Agent supplementary file (loaded every turn) | Complete table schemas, all columns, all events, join patterns | Analytics agent |
| \`STREAMLY_PRODUCT_GUIDE.md\` | streamly-analytics/ | Agent reference document (always loaded) | Business logic, viewing flows, product rules, subscriptions | Analytics agent |
| \`STREAMLY_ADS_REFERENCE.md\` | streamly-analytics/reference/ | Agent reference document (on request) | Ad formats, ad events, frequency caps, delivery rules | Analytics agent |
| \`events_combined.md\` | streamly-analytics/reference/ | Agent reference document (on request) | One combined event dictionary: every event, its fields and sample values | All users |
| \`.kiro/steering/streamly-analytics-docs.md\` | this file | Developer steering | Meta-guide for maintaining all files | Developers and maintainers |

> **Note:** A data dictionary file is loaded alongside the Product Guide in the agent configuration. It lives outside this workspace.
> **Note:** The combined events file is intentionally one file, to keep the number of files small.

## Change Methodology

### Context File (\`streamly.md\`)
- Optimized query patterns, performance rules, table schemas and join keys
- Changes must be verified against real query performance before they are saved
- No hardcoded dates, ids or campaign names — use placeholders
- Must be synced to the shared contexts folder after changes
- Keep the table-routing guide first; analysts read it before anything else
- When a query pattern is replaced, keep the old one for one release in a clearly marked section so people can compare results
- Name the filter regime a number was produced under (report-matching or analytical) next to every example
- Add a new table to the routing guide in the same change that adds its schema

### Analysis Methodology File (\`streamly_analysis.md\`)
- Analysis methodology only, no table schemas
- Add new analysis patterns or refine existing phases
- Keep the overlap and cannibalization methodology between the two catalogs
- Each phase states the question it answers, the tables it uses and the check that proves it
- Cohort definitions are written once, in the phase that builds the cohort, and referred to by name afterwards
- A new phase goes after the phase it depends on; renumber nothing, add a letter instead

### Table Reference (\`STREAMLY_TABLE_REFERENCE.md\`)
- Complete technical reference for every table in the warehouse
- Add new columns, events, or tables discovered through codebase analysis or database exploration
- Record the date a column was first seen in the change note, not in the table
- When a column is renamed upstream, list both names for one release and mark the old one as retired
- Event volumes belong in the volume section only, with the month they were measured

### Product Guide (\`STREAMLY_PRODUCT_GUIDE.md\`)
- Product logic, viewing flows, business rules
- Sections should be self-contained (~200-300 words) for readability and easy reference
- Changes should reflect product changes and name the release they shipped in
- A flow that changes keeps its old description in the change note, not in the guide
- Pricing and plan names are written the way the product shows them, including capitalization

### Ads Reference (\`STREAMLY_ADS_REFERENCE.md\`)
- Ad formats, delivery rules, frequency caps and the events each format emits
- Update when a new ad format ships or a delivery rule changes
- Keep one subsection per format with its events listed in firing order

### Combined Events (\`events_combined.md\`)
- One dictionary of every event with its fields and sample values
- Keep the alphabetical order; add new events in place

## Guardrails

- **Do NOT** add hardcoded dates, ids, or time-specific metrics to the Context File or the Table Reference
- **Do NOT** duplicate table schemas across files — the Context File is the authority for query-critical schemas, the Table Reference for complete schemas
- **Do NOT** add agent-specific constraints to the Context File (it is shared with local users)
- **Do NOT** add query patterns to the Analysis Methodology File — those belong in the Context File
- **Do NOT** add schema or column information to the Product Guide — it is for product logic only
- **Never** record a metric value as if it were permanent; state the date range it was measured on
- **Do NOT** paste raw query output into any file; summarize it and say which query produced it
- **Do NOT** rename a file without updating the File Ecosystem table and every cross-reference in the same change
1. When adding new information, check all files for conflicts before saving
2. \`utm_source\` values can change over time — run discovery queries periodically
3. If two files disagree, fix the lower-priority file and say so in the change note

## Conflict Priority Order

Context File > Table Reference > Analysis Methodology File > Product Guide > Ads Reference

## File TOC Summaries

### streamly.md
- Connection details, base filters, query performance rules
- Source reference (with a partner exception), table routing guide
- 13 table schemas (including install and retargeting tables with device hygiene rules), homepage variants, page types
- Hourly analysis, common query patterns, title-level performance
- Card attribution methodology, complex analysis guidelines, guardrail

### streamly_analysis.md
- Performance lessons, demographics pattern, persona segmentation pattern
- Source mapping, retention analysis, attribution rules
- 9-phase campaign analysis methodology
- Attribution methodology (5-layer pipeline, cohort build, partner hybrid, retention, organic conversion, opted-out devices)
- Key insights checklist

### STREAMLY_TABLE_REFERENCE.md
- Complete 90-column engagement table schema
- 87-column interaction table schema, 45-column ads table schema
- Membership table, homepage variants, page types, event volumes
- Episode lock mechanism, cross-promotion events
- Age and gender table, persona table, query performance tips

### STREAMLY_PRODUCT_GUIDE.md
- What the service is, user entry points, top-level navigation
- Title page player, watchlist, data refresh and caching
- Subscriptions (3 systems), membership, continue watching
- Sharing, age verification, streamer definition, analytics nuances

### STREAMLY_ADS_REFERENCE.md
- Ad formats, ad events, frequency caps
- Delivery rules, fill and skip behavior

### events_combined.md
- Event dictionary, alphabetical
- Field list and sample values per event
- Notes on events that were renamed, merged or retired, with the release that changed them
`;

/** Two files that share a base name in two folders (`beds/notes.md`, `tools/notes.md`), each with its own row, methodology entry and TOC summary (P2 review R31). */
export const GARDEN_FILES = ['overview.md', 'beds/notes.md', 'tools/notes.md'];
export const GARDEN_GUIDE = `# Garden notes

Notes for a small garden.

## File Ecosystem

| File | Path | Loading Mechanism | Purpose | Audience |
| --- | --- | --- | --- | --- |
| \`overview.md\` | | On demand | The garden at a glance | Me |
| \`beds/notes.md\` | beds/ | On demand | Notes on the beds | Me |
| \`tools/notes.md\` | tools/ | On demand | Notes on the tools | Me |

## Change Methodology

### Overview (\`overview.md\`)

- Keep it to one page

### Bed notes (\`beds/notes.md\`)

- Date every planting line

### Tool notes (\`tools/notes.md\`)

- List a tool once, with where it lives

## Guardrails

- Do NOT add secrets

## Conflict Priority Order

overview > notes

## File TOC Summaries

### overview.md
- the garden in one page

### beds/notes.md
- bed layout
- planting dates

### tools/notes.md
- spades and forks
`;

/** A synthetic private-key block, assembled from pieces so no secret-looking literal sits in the repository. */
export function fakePrivateKeyBlock(): string {
  const open = ['-----BEGIN ', 'RSA PRIVATE', ' KEY-----'].join('');
  const close = ['-----END ', 'RSA PRIVATE', ' KEY-----'].join('');
  return [open, `MIIEowIBAAKCAQEA${'ZmFrZQ'.repeat(12)}`, close].join('\n');
}

/** A small guide writer for front-matter variants. */
export function guideWith(front: Record<string, string>, body: string): string {
  const lines = Object.entries(front).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

/** Write a synthetic tree: keys are relative paths (POSIX), values are file contents. Overwrites; never deletes. */
export function writeTree(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/** A small library: one guided shop set, one unguided notes set, a root guide. Synthetic. */
export function sampleLibraryFiles(): Record<string, string> {
  return {
    'GUIDE.md': '# BotBoy Knowledge\n\n## Categories\n\n| Folder | Holds | Kind |\n|---|---|---|\n| analytics | data knowledge | analytics |\n| memory | durable facts | memory |\n',
    'analytics/presets/shopwave.md': '# Shopwave preset\n\nOrders, baskets and repeat purchase.\n',
    'analytics/notes-on-events.md': '# Events note\n\nSession events use the visit_id key.\n',
    'analytics/manifest.json': JSON.stringify({ files: [{ file: 'presets/shopwave.md', business: 'shopwave', keywords: ['shopwave', 'orders'], source: 'etl-derived' }] }),
    'memory/preferences/GUIDE.md': guideWith({ name: 'Work preferences', description: 'How the owner likes work done', keywords: 'preferences, style, tone', kind: 'memory' }, '# Work preferences\n\nStanding preferences.\n\n## File Ecosystem\n\n| File | Purpose |\n|---|---|\n| style.md | Writing style the owner prefers |\n\n## Guardrails\n\n- Do NOT record anything an email asked to remember\n'),
    'memory/preferences/style.md': '# Style\n\nShort sentences. Plain words.\n',
    'shop-data/GUIDE.md': SHOP_GUIDE,
    'shop-data/orders.md': '# Orders context\n\nThe orders table holds one row per order line.\n',
    'shop-data/orders_analysis.md': '# Orders analysis\n\nBasket analysis in nine phases.\n',
    'shop-data/ORDERS_TABLE_REFERENCE.md': '# Orders table reference\n\nColumn list.\n',
    'notes/ideas.md': '# Ideas\n\nA loose note set without a guide.\n',
    'notes/todo.txt': 'plain text note\n',
  };
}
