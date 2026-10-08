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
`mcp_analytics_load_context` on the file matching the question's domain,
plus one file for each other domain the request itself names (a "Local &
OTT" dashboard loads both). Check each file's Profile inventory (if it has
one), then confirm with `mcp_etl_search` (searches jobs/profiles by
keyword; paginate with start/size).
- A SCHEDULED profile computes exactly this, recently → get its latest
  run (`mcp_etl_latest_run`) and download the results
  (`mcp_etl_download_results`). Done — do not recompute what production
  already computed.
- The profile fits but has no recent successful run → resubmit its job:
  `mcp_etl_submit_run` (ownerRequested: true — the user's data request
  is the authorization), then follow the RUN LIFECYCLE below.
- Nothing fits → Step 1.

**Step 1 — Fresh question ⇒ one-off query: `mcp_etl_run_query`.**
Give it the final SQL (and optionally a dataset date and a short
`purpose`). It manages BotBoy's own scratch profile, submits, waits up to
`waitSeconds` (default 90, max 600), downloads, and returns parsed rows
plus the saved file. Never create a new profile for a one-off question —
the Datanet namespace is shared with the user's whole team, and the
scratch profile exists precisely so ad-hoc work leaves no litter. Ground
the SQL in the loaded knowledge file (its cookbook shapes and table facts)
— loaded via `mcp_analytics_list_context` → `mcp_analytics_load_context`.
If no knowledge file covers the domain, say so in the answer and state
which tables you used and why. Parallel queries are fine: each claims its
own scratch pair from BotBoy's pool (Datanet's duplicate-collapse applies
per JOB, and every pair is its own job). Submit independent queries back
to back with a short wait each, then wait once (below). A run handed off
alive keeps only its own pair busy — never resubmit that run.

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
- `LIMIT` is NOT supported by the ETLM wrapper (the run fails with "Limit
  Clause is not supported on ETLM"). Write top-N lane-portably instead:
  `SELECT ... FROM (SELECT ..., ROW_NUMBER() OVER (ORDER BY metric DESC)
  AS rn FROM ...) WHERE rn <= N ORDER BY metric DESC`. This matters for
  dashboard widgets especially — they may execute on EITHER lane.
- Non-temp DDL/DML is forbidden. You read and aggregate; you never
  create, update, or drop real tables.

## Run lifecycle (runs are async)

Runs take minutes, often longer than one tool call. BotBoy does the
waiting for you: every run submitted with `mcp_etl_run_query` in a chat
job is WATCHED. BotBoy checks it every 30 seconds, downloads the result on
SUCCESS (or reads the diagnosis on failure), and then continues the job in
the same chat on its own, with no owner message. So:

1. `mcp_etl_run_query` returns either the result (the run finished within
   `waitSeconds`) or the `runId` with "BotBoy is watching run …".
2. Then choose:
   - use the result in this turn: `wait_for_etl_run` with the runId
     (waits server-side up to 600 s per call; call it again to keep
     waiting — it is exempt from the repeat breaker), or
   - keep working on other steps, or end your reply saying what is running
     and what comes next. BotBoy continues the job when the run finishes.
   Never ask the owner to "check back" or to say "continue", and never
   resubmit a running run. Status reads (`mcp_etl_job_run`) may repeat;
   BotBoy paces identical ones to one per 10 seconds.
2a. WAITING_FOR_RESOURCES means the run is in the cluster's compute-slot
   QUEUE, ordered strictly by priority — common at peak hours and NOT an
   error. Never restart a queued run: restarting forfeits its queue
   position. `mcp_etl_run_query` prioritizes a queued run once for you
   after a minute; otherwise ONE `mcp_etl_alter_run` with action
   'prioritize' moves it to the "Prioritized Run" bucket.
3. SUCCESS → the TSV is in the files workspace (`etl-results/`, the path
   is in `savedTo`/`workspacePath`): analyze it with `run_command`
   (pandas, duckdb, sqlite), import it with `create_data_room_dataset`
   (`local_file`), verify (below), then answer or build.
4. ERROR → read the root cause (the result carries it; use
   `mcp_etl_diagnose_run` for the full bundle), fix the SQL, and run it
   again. Keep going while each failure has a NEW root cause. When the
   same failure comes back three times, STOP: report the root cause, the
   SQL you ran, and what you would try next.
5. WAITING_FOR_DEPENDENCIES on an ad-hoc run → the dependency header is
   wrong (see above) or upstream data genuinely is not ready; report it,
   do not force dependencies unless the user explicitly asks.

Scratch runs (`mcp_etl_run_query`, `wait_for_etl_run`, and prioritizing,
killing, or restarting the job's own scratch runs) are steps of the
owner's data job: the owner's request authorizes them. Production writes
(`mcp_etl_submit_run`, `mcp_etl_update_profile_sql`,
`mcp_etl_create_profile`, `mcp_etl_force_deps`, altering runs outside the
job) still need the owner's explicit ask in the conversation.

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
  same failure comes back three times, stop and report honestly — a
  partial answer with a clear blocker beats a loop.
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
