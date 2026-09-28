# Daily standup and dependable issue editing

27 September 2026 · Review draft · Implementation awaits structured approval

## Outcome and scope

Add a dedicated Daily page showing one sprint’s goal, time left, per-person workload, observed burndown and qualified finish forecast. Repair list and Kanban status dragging, simplify the issue sidebar, and edit title/description with dnd-kit and Tiptap. “Drop work” means explicitly move an individual unfinished issue to a named future sprint, never delete or send to backlog.

Approval authorizes implementation and fixture verification; no implementation before structured Plannotator approval. No live Jira writes are authorized. Preserve servers, cache, credentials, pending operations and unrelated changes. No hashing, replacement queue, general framework, sprint creation, arbitrary ranking or unrelated editors. The prior approved drag-drop plan’s future/backlog ranking remains unimplemented and is not silently included here.

## Evidence and implementation ownership

WorkspaceIssueViews.tsx has no DND and hides empty list groups; IssueDetailDialog.tsx has a read-only title and ADF renderer. IssueEditors.tsx has a cumbersome search/separate-select assignee flow. Reuse these components and Workspace.tsx navigation, adding focused Daily/editor components. Extend workspace/model.rs, cache.rs, jira.rs, write_api.rs and outbox.rs with typed summary, ADF and sprint-membership values alongside existing status/assignee writes.

Cached sprints have goals/dates; issues have status/assignee/estimates/sprint IDs. Cache publication replaces the current snapshot; no history exists. Daily needs a sprintId-specific full-scope native query because current views paginate/search and may combine active sprints. Verify configured estimation field metadata and units before calling estimates story points; time estimates are not points.

## 1. Assignee and status dragging

Use compact property rows; clicking the current assignee opens an anchored searchable combobox, keeping that value visible during search. Debounce remote searches, key by identity/site/workspace/issue/search, and ignore stale responses. Pointer or Enter selection saves durably locally without a second Save. Support arrow keys, announcements and restored focus; Escape closes the picker before the dialog. Distinguish loading/no matches/permission/offline cached choices. Offer Unassigned only when Jira permits, with nullable accountId end-to-end and fresh validation. Keep other values compact without unrelated editors.

Use current @dnd-kit/react APIs and verify compatible package versions during implementation. Share status movement between list groups and Kanban columns, including empty targets. Real handles, activation threshold, overlay, auto-scroll and cancellation preserve row click and property controls. Provide keyboard operation and a Move status menu equivalent.

Use issue-specific transitions: one compatible action enqueues; multiple actions open a chooser; none explains why and leaves the issue unchanged. Required-field transitions remain unavailable without supported forms. Same-group drops are no-ops; Other statuses is not a synthetic target. Offline intent needs cached capabilities and fresh preflight before sending. Status movement is not ranking. Project only after native durable enqueue; on failure restore position. Reuse pending/confirmed/conflict recovery and existing queue.

## 2. Title, Tiptap and durable writes

Title has explicit inline Save/Cancel and empty-title validation. Tiptap description has focused formatting controls and Save/Cancel. Preserve independent dirty drafts through refreshes, unrelated updates and failed saves; closing or switching issue offers keep editing/discard rather than silent loss.

Tiptap JSON is not Jira ADF. Use an explicit supported node/mark adapter. Preserve unsupported nodes, marks and attributes losslessly via opaque extensions or refuse unsafe saves with an explanation and Jira link. Never strip mentions, media or tables. Test nested unsupported structures and edits beside them; use a read-only fallback where preservation cannot be proven.

Extend typed native values/capabilities, transactional migration, base/intended/remote comparison, owner isolation, ordered dispatch, conflict/rejection handling and fresh readback. Retain existing pending writes and accepted flags. Offline edits remain visibly pending and survive restart. Unknown outcomes reconcile by reads and never automatically resend. No second browser queue.

## 3. Daily and honest observations

Choose one active sprint, show a selector for multiple and an explicit empty state for none. Show goal, dates, last successful sync and coverage. Aggregate the complete sprint independently of search/pagination. Exclude epics/containers using authoritative hierarchy/type metadata, and avoid counting parent rollups plus subtasks by using a documented single counting level consistent with estimate semantics. Unknown hierarchy/units makes coverage incomplete; keep records accessible in Downloaded issues.

For participants in this cached sprint, show To do/In progress/Done counts, remaining points and missing-estimate count, including Unassigned. This is workload, not whole-team capacity or productivity. Use Jira status categories. Count Monday–Friday in a visibly named viewer timezone, including today when within sprint dates and a weekday. Do not infer holidays, leave or hours. Missing/reversed dates and ended sprints receive explicit states, without division by zero.

Persist per-issue confirmed observations atomically only after a complete successful sync, scoped by account/site/project/board/sprint and preserved across snapshot replacement. Capture membership, status category, estimate evidence and time. Failed/partial syncs create no sample. Pending local projections remain separate. Never synthesize backfill before the first observation.

Chart label: “Observed since [date]”. Show remaining work, an observed ideal from first sample to sprint end, scope additions/removals and estimate changes separately, gaps and last sync. Observations show net changes between syncs, not exact completion events or a complete Jira historical report. Same-day syncs do not manufacture distinct working-day intervals.

Show required points per remaining workday immediately when dates/units support it, marking incomplete estimates as estimated scope only. Show projected finish only after at least three distinct observed working-day intervals, positive confirmed net completion and complete comparable point coverage. Eligible completion requires presence in both observations, non-done to done, unchanged known estimate and no concurrent membership change; reopening offsets completion. Scope removal/estimate reduction is never throughput. Expose observation window and continued-pace assumption; uncertain/large gaps or insufficient evidence suppress forecast. Zero rate shows no positive observed completion pace.

**Material limitation for approval:** a new installation cannot immediately provide past burndown or a credible finish date. The initial slice accumulates local confirmed observations; until sufficient history exists it shows workload/time left/required pace and explains the missing forecast. Full Jira changelog ingestion is deferred.

## 4. Move work to next sprint

Suggest the earliest valid future sprint beginning after the active sprint’s end; show name/dates and allow selection. Missing dates, tied or ambiguous/undated candidates require explicit selection. If no destination exists, explain that a sprint must be created in Jira; never auto-create.

An optional “Consider moving” selection simulates remaining scope/required pace with missing-estimate warnings. Simulation saves nothing. Apply is an explicit per-issue confirmation naming the target, not automatic bulk movement.

Persist focused typed membership intent with base active/future associations, target and revision evidence. Preserve closed sprint history. Preflight verifies unfinished status, source, future target and permission; reject unforeseen active/future membership conflicts. Use the sprint endpoint directly, without intermediate backlog operation or raw sprint-array replacement.

Project pending membership before full-scope totals/pagination, leaving confirmed history unchanged. Keep moved issue/recovery accessible in pending changes. Maintain cross-board consistency without inventing filter membership. Fresh readback confirms membership; accepted-awaiting-confirmation differs from confirmed. Unknown never resends automatically; rejected/conflict/changed-target/local-failure states remain actionable.

## Sequence and acceptance

1. Assignee/property UX and shared list/Kanban status DND with accessible alternatives.
2. Typed title/description writes, Tiptap preservation and draft safeguards.
3. Daily full-scope reads, atomic observations, qualified forecast and explicit next-sprint movement. Read-only groundwork can begin earlier; forecast depends on trustworthy observations and moves on durable membership writes.

Tests: more than 100 issues; multiple sprints; missing dates/points/type metadata; parent/subtask double counting; weekdays/timezones; owner isolation; history surviving snapshot replacement; failed sync producing no sample; gaps; scope drops never completion; reopenings/estimate changes; insufficient forecast evidence; pending local state separate from history. Exercise assignee search races, issue/account switches, Unassigned permissions, offline states, keyboard/focus/Escape, pointer and keyboard DND, empty targets, ambiguous transitions, cancel/auto-scroll/click behavior. Test draft protection, independent fields, validation, failed saves and ADF round-trip/refusal.

Native fixtures cover migration retaining pending writes, restart, dispatch owner changes, ordering, enqueue failure, rejection/conflict, accepted-but-unconfirmed and unknown-never-resend. Sprint fixtures preserve closed history, reject unexpected live memberships/changed target, and verify projected full-scope totals/readback. No live mutations required.

After implementation run pnpm test, pnpm build and cargo test --manifest-path src-tauri/Cargo.toml --lib. Inspect wide/narrow light/dark layouts, focus, accessible names and overflow. Report local verification separately from unperformed live Jira verification. Completion means all requested behavior and acceptance checks, not just plan approval.

## Sources and review decisions

Existing src/styles.css supplies system sans typography, purple accent and light/dark tokens. Mockups are labelled illustrative sample data, not the actual app.

- https://dndkit.com/react/quickstart/ — current React API and compatibility verification.
- https://tiptap.dev/docs/editor/core-concepts/schema — explicit editor schema.
- https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/ — Jira ADF structure.
- https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/ — issue edits and metadata.
- https://developer.atlassian.com/cloud/jira/software/rest/api-group-sprint/ — sprint membership endpoint.

Review the observation-only limitation, conservative forecast threshold, weekday convention, ADF fallback and explicit next-sprint selection. Implementation must define a conservative gap cutoff before enabling forecasts and validate real board estimate/hierarchy metadata; these are evidence checks, not permission to invent missing data.
