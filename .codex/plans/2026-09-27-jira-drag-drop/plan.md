# Keep epics out of sprints · drag work where it belongs

27 September 2026 · Review draft · Both board status and backlog planning

## 01 — Scope and approval

Yi explicitly requested both board drag-and-drop and moving/reordering issues in the combined Backlog view. This plan covers both, in sequenced implementation milestones. Epics must not appear as executable sprint/backlog rows; future epic grouping is not part of this slice.

Approval authorizes implementation and fixture-based verification after Plannotator review. No live Jira mutation is authorized: Yi declined that testing, and any later live check still needs a named test issue and explicit approval. Preserve the running app, existing cache, credentials, pending operations, and unrelated changes. No implementation occurs during this review.

**Included:** single-issue status drops between board columns; single-issue moves between Unscheduled backlog and future sprints; anchored reordering within those planning sections; equivalent keyboard/menu actions; durable offline persistence and recovery. **Excluded:** multi-issue drag, epic grouping, active-sprint planning moves, sprint creation/lifecycle, issue creation, and ranking within board columns. Current sprint remains a status board; no new active-sprint planning section is added.

## 02 — Epic classification before pagination

Persist Jira issue-type ID and authoritative hierarchy metadata alongside each issue. Resolve by fields.issuetype.hierarchyLevel when supplied, otherwise by the cached site/project type-ID registry fetched from Jira. Treat hierarchy level 1 and above as epic/container work; standard tasks and subtask levels remain eligible. Do not classify solely by an English display name, a hard-coded type ID, or presence of an epic parent relationship.

Filter epic/container rows out of current, future, and unscheduled planning membership queries before COUNT, ORDER BY, and LIMIT/OFFSET. Keep their detail and raw data, retain task-to-epic relationships, and keep them accessible in Downloaded issues. The current board/list and all planning section totals must agree. This filtering does not remove sprint links in Jira or mutate existing epic issues.

Backfill the cache from saved raw issue-type IDs/metadata first; fetch missing type definitions on the next normal read sync. Unknown types must not silently masquerade as tasks: omit them from actionable sprint rows and report an explicit “type metadata pending” count with access through Downloaded issues. Mark the affected scope incomplete until classification is known. Downloaded search remains available. Preserve ordinary work and queued mutations through this migration; no cache reset.

## 03 — Board drops are workflow actions

A card has a small drag handle; pointer dragging does not interfere with click-to-open, text selection, or property controls. When dragging starts, expose valid destination columns from that issue's cached transition capabilities. Never infer a workflow transition from a column's first status.

One supported transition reaching the destination column can enqueue directly. If several valid transition IDs reach that column, drop opens a small chooser naming the actions and resulting statuses; no write is queued until the user chooses. If none are known, show the reason and leave the card in place. Required-field transitions remain unavailable because their forms are outside this slice. Offline dragging works only with previously captured issue-specific capabilities, revalidated before sending.

A same-column drop is a no-op: board order is not sprint rank in this slice. Other statuses has no drop target because it is a catch-all, not a Jira state. It may still contain a draggable task with valid transitions into real columns. Container issues visible in Downloaded issues have no sprint/status drag handle in this slice.

After native durable enqueue succeeds, project the status and show Saved locally. A failed local commit restores the prior position and announces failure. Reuse existing status outbox ordering, owner guard, capability checks, field locking, conflict handling, accepted/unknown lineage, and native dispatch barrier. Never implement a second browser-side write queue.

## 04 — Planning drops express membership and relative position

The approved combined Backlog layout remains: future sprint sections and Unscheduled backlog, with independent paging. Drag a task to a section header to change membership only, without claiming a global first/last position. Drop before or after a visible row to change membership if needed and request that relative rank. Within the same section, row drops change rank only; a header drop is a no-op.

Insertion cues say “Before CK-123” or “After CK-123”. A page boundary is not the start/end of the entire sprint. Do not expose “Top” or “Bottom” unless all required boundary evidence exists; this slice simply uses visible anchors. Empty-section header drops change membership only. Cross-page actions use a Move menu rather than pretending that unloaded rows exist.

When text search is active, disable rank insertion and explain why; header/menu membership moves remain available. A collapsed section header can receive a membership-only drop without downloading all of its issues. Keep two concurrent local section reads and existing per-section totals/page limits. No duplicate aggregate count across sprint memberships.

Provide a non-drag Move action for every draggable issue: select an eligible future sprint or Unscheduled backlog; optionally choose Before/After one of the loaded target rows. Keyboard users can focus a handle, pick up with Space, navigate available targets, confirm with Enter, and cancel with Esc, with spoken pickup/target/result announcements. The menu is the equivalent fallback and works without pointer precision. Dragging never opens issue detail accidentally.

Only backlog↔future and future↔future placement is enabled. Revalidate that both the issue and target still fit this scope. If a sprint starts while offline, or the issue acquires an active-sprint association, block the placement for review rather than silently removing it from active work. Preserve closed-sprint history. Do not guess how to resolve multiple conflicting live sprint memberships.

## 05 — Typed durable placement intent

Extend the native outbox with a focused placement operation, not fake scalar status values. Identity remains owner/site plus stable issue ID; board is ranking context. One unresolved placement per issue, alongside existing status/assignee operations, with stable per-issue ordering. A blocked field with no ambiguous side effect may be resolved independently; an earlier sending/confirming/unknown step prevents later conflicting issue mutations from overtaking it.

Persist original active/future membership, requested destination, optional before/after anchor ID, origin board, configured rank-field ID, relevant remote revision/rank evidence, pinned detail, enqueue sequence, and separate membership/rank step states. Each step records never-attempted, sending, accepted-awaiting-readback, confirmed, blocked, conflict, or outcome-unknown. A placement is complete only when every requested step is confirmed or explicitly resolved.

A never-attempted placement can be replaced by the user's latest placement while retaining its original base. Once any step starts, the placement is immutable until recovery. Returning to the original placement cancels only an entirely unsent operation. Local enqueue, projection revision, and both step records commit in one SQLite transaction. Use ordinary stable local IDs, no hashing.

Migrate the current schema forward transactionally, retaining existing status/assignee operations and their accepted flags, account identities, capabilities, pins, and confirmed data. Do not reuse historical CachedIssue.rank integers as Jira rank values: they are local snapshot ordinals. Read ranking.rankCustomFieldId from board configuration; persist the opaque server rank field only as evidence, never generate LexoRank strings.

## 06 — Projection must precede counts and paging

Maintain confirmed issue membership/rank snapshots separately from pending placement overlays. For each local section query: establish confirmed eligible IDs, apply owner-wide pending destination membership, apply epic/type eligibility, apply anchored ordering, then compute matching total and slice the requested page. Overlaying only the returned 100 rows is incorrect: moved issues must disappear/appear and totals change even across page boundaries.

For local ordering, reuse confirmed order and apply ordered before/after placement constraints against loaded/persisted anchor identities. Store these constraints rather than synthesizing Jira rank tokens. Reject cycles/self-anchors and conflicting pending-anchor dependencies. Anchor IDs must belong to the target context; anchors awaiting unresolved placement cannot themselves serve as a new destination anchor in this first implementation. Show a blocked/conflict state if an anchor becomes unavailable rather than picking another silently.

Apply canonical membership changes across cached board copies, while respecting each board's known filter membership. Share ordering overlays between cached boards using the same configured rank field; do not apply them to a different ranking field. A move does not prove the issue belongs to an unrelated board; mark that board membership pending verification instead of inventing a row. Keep the origin-board planning projection and pinned detail visible, then reconcile all cached affected boards after server confirmation. Never let destructive snapshot publication erase a queued move or its recovery access.

## 07 — Jira replay and partial success

Use the existing serialized native remote coordinator and owner dispatch barrier. Preflight fetches fresh issue membership, target sprint state, board/rank configuration, anchors, and relevant permissions. Cached evidence permits offline intent, not unconditional authorization. A missing/changed rank configuration, inaccessible anchor, moved issue, or changed target state blocks for review. Compare base, intended, and fresh membership/rank evidence before dispatch; no compare-and-swap guarantee is assumed.

**Membership step:** use Jira's sprint issue endpoint for a future destination and the backlog endpoint for removal from future planning. This plan deliberately performs membership before a separate rank request. The extra request makes partial success explicit and avoids assuming membership plus rank is atomic. Preserve the server's closed-sprint associations; do not replace a raw custom-field sprint array yourself.

**Rank step:** use PUT /rest/agile/1.0/issue/rank with the board's configured field ID and exactly the selected relative anchor. Parse 207 per-issue results even for a one-issue request; generic “all 2xx succeeded” handling is forbidden. A malformed/missing result is uncertain. Re-fetch membership and server-ordered moved/anchor issues before declaring the step confirmed; do not compare local ordinals or invent an opaque rank ordering algorithm.

The server accepts only supported sprint states. The backlog operation can remove active as well as future associations, so the local scope guard must prevent dispatch when an active association is observed. A concurrent Jira writer can still race after validation; retain and expose the resulting evidence rather than claiming atomic protection. If membership succeeds and rank fails, show “Moved to Sprint 25 · order needs attention”. Do not roll the issue back or repeat the accepted membership step.

Membership movement may itself change the issue rank. After confirming membership, record the fresh post-membership issue rank as the rank-step baseline; retain the user's anchor intent and independently check that the anchor has not moved from its recorded context. Do not compare the moved issue blindly against its pre-membership rank. Before rank dispatch, verify that the observed moved/anchor ranks and memberships still match these step-specific bases or already meet the intended relationship. Concurrent changes require explicit review; label-only changes do not. After dispatch, read the server's rank-ordered relationship for the known IDs, using enhanced-search reconciliation where supported. This confirms the requested before/after relationship, not exclusive adjacency against all concurrent writers.

Timeouts, crashes in sending, and ambiguous responses produce outcome unknown. Reconcile by reads; if the intended membership/relation is now observed, resolve as observed success without claiming proof of which writer caused it. Otherwise keep the recovery visible and never automatically resend. Accepted membership remains accepted if rank or confirmation fails. Permission/validation failures become actionable blocked states, while 401 pauses that owner's worker and definitive rate limits defer safely.

## 08 — Implementation sequence and tests

1. Add hierarchy/type and rank-context metadata; migrate without loss; filter executable scopes before totals/paging. Keep Downloaded issues and epic relationships intact.
2. Wire board handles and Move/status chooser to the existing durable status flow, with pointer/keyboard cancellation and no guessed actions.
3. Add native typed placement storage, projection, membership/rank replay and recovery with fixtures before exposing planning drops. Integrate planning DnD and its equivalent menu. Both surfaces are required to complete this approved scope.

Native ownership: workspace model/cache for migration and projected queries; Jira adapter for metadata and endpoint-specific results; outbox/coordinator for ordered step state and recovery. Frontend ownership: shared row/card handles, board targets, Backlog section/insertion targets, Move chooser, and Sync changes presentation. Reuse the approved UI; add one accessible DnD primitive only if it reduces implementation complexity. No broad visual redesign.

Acceptance includes renamed/localized epics, hierarchy containers, unknown legacy types, standard tasks with epic links, more than 100 mixed-type issues, correct totals across every scope, and preserved old pending writes. Verify column mapping with zero/one/multiple valid transitions, unsupported forms, offline missing capabilities, and same-column no-op.

Placement fixtures cover independent section pagination, filtering restrictions, duplicate memberships, cross-board copies, dropped/changed anchors, cycles, started/deleted sprints, status changes during placement, and local crash recovery. Test membership success/rank failure, 207 partial/malformed results, accepted responses with failed/divergent readback, unknown requests that must never resend, owner changes at dispatch, and queued replacement during preflight.

UI checks cover pointer and keyboard equivalence, visible insertion cues, no accidental issue opening, announcements, focus restoration, drag cancellation, reduced motion, 960/1280/1440 layouts, and preserving current read-only details. Run affected native/frontend suites and production builds. Fixture verification is sufficient for implementation review; live Jira mutation remains untested unless separately authorized.

## 09 — Sources and review focus

- [Jira issue types](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-types/) — type identity and hierarchy metadata.
- [Sprint API](https://developer.atlassian.com/cloud/jira/software/rest/api-group-sprint/) — move issues to an open/active sprint and optional ranking fields.
- [Backlog API](https://developer.atlassian.com/cloud/jira/software/rest/api-group-backlog/) — removing active/future planning associations and board-specific alternatives.
- [Issue ranking API](https://developer.atlassian.com/cloud/jira/software/rest/api-group-issue/) — anchor-based rank operations and per-issue 207 outcomes.
- [Board API](https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/) — board rank configuration and Scrum issue scope.

Review the two illustrative drop surfaces and the partial-success behavior. The design intentionally uses future/backlog membership only, no board-column ranking, and explicit choices for ambiguous workflow columns. These conservative limits preserve both requested DnD workflows and offline durability.
