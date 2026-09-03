# ETL Data Work — Tooling Guide (BotBoy operating knowledge)

You are reading this because a data task routes through the Datanet ETL
connection (the SQL warehouse connection is not configured or not
connected, or the task is explicitly about DataCentral/Datanet). This
guide tells you exactly which tool to use for which job, what "done"
means, and how to handle failures. Follow it literally.

Two facts to hold: (1) Datanet ETL runs on the company Redshift — the
data is the same warehouse data; only the access path differs. (2) Every
run is a batch job: minutes per attempt, so a wrong guess is expensive —
decide with this guide instead of experimenting.

## The decision ladder — always walk it in order

**Step 0 — Does an existing profile already answer the question?**
First ground yourself: `mcp_analytics_list_context`, then
`mcp_analytics_load_context` on the ONE file matching the question's
domain. Check that file's Profile inventory (if it has one), then confirm
with `mcp_etl_search` (searches jobs/profiles by keyword; paginate with
start/size).
- A SCHEDULED profile computes exactly this, recently → get its latest
  run (`mcp_etl_latest_run`) and download the results
  (`mcp_etl_download_results`). Done — do not recompute what production
  already computed.
- The profile fits but has no recent successful run → resubmit its job:
  `mcp_etl_submit_run` (ownerRequested: true — the user's data request
  is the authorization), then follow the RUN LIFECYCLE below.
- Nothing fits → Step 1.

**Step 1 — Fresh question ⇒ one-off query: `mcp_etl_run_query`.**
One tool, one call: give it the final SQL (and optionally a dataset
date). It manages BotBoy's own scratch profile, submits, waits, downloads
and returns parsed rows. Never create a new profile for a one-off
question — the Datanet namespace is shared with the user's whole team,
and the scratch profile exists precisely so ad-hoc work leaves no litter.
Ground the SQL in the loaded knowledge file (its cookbook shapes and
table facts) — loaded via `mcp_analytics_list_context` →
`mcp_analytics_load_context`. If no knowledge file covers the domain, say
so in the answer and state which tables you used and why. ONE query at a time: the
tool refuses while a previous ad-hoc run is still in flight (Datanet
collapses duplicate queued runs) — poll the named run instead of
submitting again.

**Step 2 — "Pull the report file" (rendered xlsx/pdf reports).**
These are METRICS profiles. Find them via `mcp_etl_search`, then
`mcp_etl_download_results` with format 'xlsx' or 'pdf'. Plain data runs
use no format (TSV default). Old runs get purged server-side — download
promptly, the file is saved locally and the path returned.

**Step 3 — Ground new SQL in production practice.**
`mcp_etl_profile_sql` fetches any profile's stored SQL (works for every
profile type). Use it to copy how production computes a metric before
writing your own variant.

## Writing SQL for ETL (differences from ad-hoc warehouse SQL)

- Start the SQL with a dependency header comment. For ad-hoc work always
  use `/* NO DEPENDENCIES */` — without it the run can hang waiting on
  upstream datasets. (`mcp_etl_run_query` adds it if you forget.)
- Multi-statement staging is normal: `CREATE TEMP TABLE ... AS (...)`
  chains; the LAST statement's SELECT is the result set that downloads.
- `{RUN_DATE_YYYYMMDD}` is substituted with the run's dataset date — use
  it for reproducible date windows.
- Non-temp DDL/DML is forbidden. You read and aggregate; you never
  create, update, or drop real tables.

## Run lifecycle (when you submitted a run yourself)

1. Submit returns a numeric run id.
2. Poll with `mcp_etl_job_run` — every 30–60 seconds, not faster.
2a. WAITING_FOR_RESOURCES means the run is in the cluster's compute-slot
   QUEUE, ordered strictly by priority — common at peak hours and NOT an
   error. Never restart a queued run: restarting forfeits its queue
   position. If it stays queued unreasonably long, ONE
   `mcp_etl_alter_run` with action 'prioritize' moves it to the
   "Prioritized Run" bucket (`mcp_etl_run_query` does this for you
   automatically after a minute).
3. Status SUCCESS → `mcp_etl_download_results` → verify (below) → answer.
4. Status ERROR → `mcp_etl_diagnose_run` ONCE, read the root cause, fix
   the SQL, resubmit ONCE. If the second attempt fails for the same
   class of reason: STOP. Report the root cause, the SQL you ran, and
   what you would try next. Never enter a submit-diagnose loop.
5. WAITING_FOR_DEPENDENCIES on an ad-hoc run → the dependency header is
   wrong (see above) or upstream data genuinely is not ready; report it,
   do not force dependencies unless the user explicitly asks.

## Completion contract — what "done" means

A task is complete when the user has VERIFIED DATA, never when a run was
submitted. Before presenting numbers, check:
- Subset sanity: a part is never larger than its whole (downloads ≤
  total streams, paid ≤ total users). A violated subset means a wrong
  table or filter — fix it, do not present it.
- Empty results are explained (wrong date window? filter too tight?),
  never silently reported as zero.
- Disclosures accompany the numbers, every time:
  - Which filter regime: reproducing a REPORT ⇒ you matched that
    profile's exact filters; measuring REALITY ⇒ you used the analytical
    filters from the context file. Name which one you used.
  - Which counting key (user id vs device/ad id) when counting people.
- The result file path is mentioned so the user can open the full data.

## Two sources of context knowledge — how to tell them apart

Knowledge files (listed/loaded with the `mcp_analytics_*` tools) carry a
provenance header on load:
- "Production ETL conventions" (derived from the team's own profiles):
  trust it for table usage, wrapper mechanics, submission conventions,
  reference profiles, and what reports ACTUALLY filter on.
- "User-supplied warehouse/schema knowledge": trust it for column
  semantics, event meanings, analytical filter recommendations, and
  performance guidance.
Schema facts agree across both. Where filters differ, that is the regime
choice above — not a contradiction. Never copy deprecated concepts from
old production SQL when the user-supplied knowledge marks them dead.

## Failures and auth — what self-heals and what does not

- Sentry/session errors self-heal: the tools silently re-prime and retry
  once. If a tool still answers "needs re-authentication", tell the user
  to run `mwinit -o -s` (or Connections → Datanet ETL → Refresh) — that
  is the ONLY manual step that exists on this path; everything else is
  yours to complete.
- Every error message names the next action. Take that action. If the
  same action fails twice, stop and report honestly — a partial answer
  with a clear blocker beats a loop.
- `redshift_query` and `batch_*` tools are blocked by policy. The block
  is correct behavior, never an error to work around: warehouse SQL
  belongs to the SQL connection when it exists, and batch operations are
  owner-only territory.

## Defaults (never ask the user for these)

- Dataset date: today, unless the question names a period.
- Date window: the question's period; otherwise last 7 full days.
- Result format: TSV (omit format) except rendered METRICS reports.
- Row previews: the tools cap returned rows; the full file is on disk —
  reference its path rather than re-querying for more rows.
