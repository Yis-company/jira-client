# Slice 2a · Durable status and assignee edits

27 September 2026 · Review before implementation

## 01 — Outcome and approval

Make the existing client start syncing after one setup action, reopen cached work immediately, and save status or assignee changes locally before sending them to Jira. This is the first narrow write slice: no issue creation, comment editing, versions, sprint mutations, bulk editing, or general custom-field editors.

Yi confirmed live read synchronization and said “go on” after this next step was proposed. The repository workflow still requires this concrete Plannotator review before implementation. Approval authorizes code and fixture-based verification for this slice. Live Jira mutations require a separately named test issue and explicit authorization; no test issue is chosen here. Keep the currently open app running during planning, without closing or reopening it. Preserve existing credentials, cache, and unrelated changes.

Personal desktop-only API-token authentication remains unchanged. SQLite remains authoritative for local work; TanStack Query caches IPC reads and invalidates on Rust domain events. Use existing shadcn/ui and ReUI patterns. No server, hashing, new synchronization framework, or TanStack DB layer is needed.

## 02 — Evidence and the narrow changes

The current schema is version 1. In src-tauri/src/workspace/cache.rs, issues and memberships are keyed by site, account, project, and board. publish deletes and recreates a board's issue rows. Pending edits cannot safely live only in those rows or cascade with them. The same Jira issue can exist in several boards.

workspace/mod.rs already serializes read sync and rejects stale publication using an identity generation. It captures the connection and generation separately today; writes require atomic capture and dispatch checks. workspace/jira.rs exposes a GET-only Api with read retries. Write methods must have a separate result classification and must not inherit automatic read retries.

src/lib/workspace.ts and Workspace.tsx already read cached issues through TanStack Query. The UI uses reconnect/focus/60-second refresh and separate initial selection/sync steps. Reuse these seams instead of replacing the working read layer. Keep existing paging, comments, descriptions, raw fields, off-board visibility, and completed current-sprint issues intact.

## 03 — User journeys

**Setup:** choose project and Scrum board, then Continue starts the first sync automatically. Show progress and retry if it fails. There is no Enable offline action: local persistence is inherent. If an existing cache is available, show it immediately while refreshing in the background. Deduplicate initial, focus, reconnect, timer, and React StrictMode triggers for the same selection/account; an online hint is not proof that Jira is reachable.

**Edit:** open an issue and choose its status transition or assignee. After the SQLite transaction commits, update the detail and every cached board/list copy, showing “Saved locally · waiting to sync”. Failure to persist leaves the confirmed value visible with an error; never claim a saved edit based only on a React update.

**Offline capabilities:** cache issue-specific transitions and assignable-user results when the issue is opened online or a picker is searched. Show the capture time and “Cached options; checked when syncing”. A never-opened issue may be readable offline without editable options. Disable unavailable controls with “Connect once to load options”; never infer transitions from board columns or candidates from existing assignees. Cached search results are a subset, not the whole directory. Additional offline transition chains are unavailable until a new source status has verified options.

**Recovery:** a persistent Sync changes entry lists pending, blocked, conflicted, and uncertain operations, including issues that leave downloaded scope. The issue panel shows both requested and latest Jira values when they differ. A conflict offers Use Jira or Keep mine with fresh validation; blocked operations explain the required action. Unknown outcomes offer Check again and Accept current Jira value, never a blind Retry transition. Choosing a new action after reviewing uncertainty requires an explicit warning that the earlier action may have run.

**Scope changes:** after a status change, Jira may remove the issue from a board or backlog. The operation and last detail remain reachable in Sync changes until resolved. Do not invent new sprint membership. Refresh authoritative membership after confirmation; moving between visible status columns uses the projected status, with Other statuses when unmapped.

## 04 — Persistence and identity

Migrate version 1 to 2 in one transaction; retain all existing workspace/issue/membership/comment/raw-field data. Add owner-and-issue tables outside the board-row foreign-key cascade. Identity is the existing normalized site plus account email plus stable Jira issue ID; board/project are context, not operation identity. Account-ID normalization is a separate migration, not part of this slice.

**Confirmed editable fields:** one canonical status, assignee, remote updated value, and local revision per owner/issue. During migration choose the newest valid Jira updated value among board copies; use a deterministic board-ID tie-break. If copies disagree or timestamps are invalid, preserve raw copies and mark baseline uncertain until a direct issue read. Never replay against an uncertain baseline.

**Durable outbox:** integer local operation ID, owner/issue, field, base value, requested value, transition ID/source/target where relevant, state, attempted flag, sequence, timestamps, last error, and pinned last-known detail. The projection is derived from confirmed fields plus unresolved intents; enqueue/rewrite/discard and revision updates occur atomically. List/detail queries overlay both summary and corresponding raw status/assignee fields, so UI surfaces cannot disagree.

**Capabilities:** store issue/source-status transition metadata and timestamp, plus issue-specific assignee search results and permission evidence. Invalidate status capabilities when confirmed source status changes. No promise of offline editing all issues before capability discovery.

**Queue policy:** one unresolved operation per field per issue. A queued, never-attempted assignment may be replaced by the latest choice; retain its original base. A queued transition may be replaced only by another verified transition from that same base status. Returning to the base cancels an unsent operation. Do not append speculative workflow chains. Sending, uncertain, blocked, and conflicted entries are immutable until their recovery action; disable further edits to that field. A different field can still queue independently. Issue-level ordering is stable, but a conflict isolated to one field does not block a validated independent field.

Normal board publication refreshes confirmed snapshots, then reconciles overlays; it never overwrites local intent. Pending records and pins survive issue deletion from board rows. An inaccessible or deleted issue becomes blocked/uncertain rather than silently discarded. When the user resolves the last operation, normal scope retention may remove the pin.

## 05 — Coordinator and replay

Use one native remote-work coordinator for the pilot, covering full snapshot fetch/publication and outbox dispatch/readback. This deliberately serializes remote work across issues initially, which also guarantees issue-level serialization. It prevents a pre-write snapshot from publishing after a write. Local reads and enqueue transactions do not hold the remote gate, so offline interaction stays responsive. An already-running full refresh can delay queued writes until it finishes; show that wait honestly. Give one bounded batch of queued writes priority before beginning a scheduled full refresh, rather than draining an unbounded queue. At sync start, process at most 10 eligible operations or 5 seconds of dispatch work, whichever is reached first (an in-flight request may finish), refresh the selected workspace, then continue queued work; coalesce redundant refresh requests. This bounds write priority so refreshes cannot starve. Use finite request timeouts. A cooldown ends or defers the current remote job before releasing the gate; discard any partial snapshot and restart its fetch later. Never release and reacquire the remote gate between a snapshot fetch and its publication, and never retain a preflight result across another remote job. Performance concurrency can be revisited with evidence.

Capture owner, credentials, and generation together under the short identity lock. Before dispatch, recheck them at a defined dispatch barrier shared with disconnect/account changes. No new request starts after the barrier revokes that identity. Already-dispatched requests may still complete; cancellation cannot undo a Jira write. Persist their outcome only to the captured owner's outbox, never the new account's UI, and reconcile uncertain outcomes when that owner reconnects. Do not hold the identity lock across a network wait. Events include owner and revision; inactive-account listeners ignore them. Account changes clear relevant frontend caches.

For each eligible operation, fetch the issue directly and current capabilities. Compare base, requested, and remote values for that field. If remote equals requested, resolve as “already matches” without another write. If remote differs from both base and requested, require conflict resolution. If remote equals base, validate and durably mark sending before dispatch. Separate status and assignee operations are reconciled independently; a transition's side effects can change assignee, so refetch both fields before the next operation.

After a success response, fetch the issue by ID and reconcile current state. Do not use an ordinary JQL page as write acknowledgement. Keep confirmation pending if readback fails. If a successful response is followed by a direct read whose field differs from the requested value, retain the operation as a visible conflict (or blocked if the issue is inaccessible); HTTP success alone never clears the overlay as confirmed. The recovery view shows the requested and observed values without automatically resending. Ignore older board copies when applying canonical fields. Enhanced search can lag; use reconcileIssues for affected IDs where appropriate during membership refresh, without treating it as atomic write protection.

## 06 — Jira contracts and limits

**Status:** GET /rest/api/3/issue/{id}/transitions with expand=transitions.fields supplies available transitions and field metadata; POST to that path submits the selected transition ID. This slice supports transitions requiring no additional user field entry. Show unsupported transition requirements explicitly and leave them unavailable; general transition forms remain future work. Revalidate immediately before sending and preserve Jira validation errors.

**Assignment:** issue-scoped GET /rest/api/3/user/assignable/search supplies candidates; PUT /rest/api/3/issue/{id}/assignee sends accountId. The API supports null for unassignment, but this slice defers the Unassign action: the selected issue-scoped candidate endpoint does not establish that the site permits an unassigned issue, and no extra administration probe is added. Existing unassigned values remain readable; selecting an assignable person is supported. Do not use email or display name as an assignee identifier. Search/pagination is bounded and may be incomplete; never infer completeness from a short page.

**Consistency:** direct issue reads provide the reconciliation values. The inspected transition/assignment contracts do not document a conditional revision parameter that guarantees compare-and-swap. Three-way comparison detects observed conflicts, but another client can race between preflight and write. Readback detects some races, not every overwritten edit. Do not promise exactly-once side effects or zero lost updates. Jira transitions can trigger workflow automation even when the final status alone is insufficient to prove what happened.

### Durable operation states

- **Queued:** saved and never attempted; eligible for validation or safe local replacement. Offline and transient pre-dispatch failures leave it here.
- **Sending:** attempt recorded before dispatch. Success goes to confirming; a crash, timeout, or ambiguous server response goes to outcome unknown, including every sending row found on restart.
- **Confirming:** Jira returned success; readback pending. Retry reads only, never repeat the mutation just because confirmation failed.
- **Confirmed / already matches:** update canonical values and resolve the overlay transactionally; emit one owner-scoped change event.
- **Blocked:** permission denial, invalid target, missing required fields, or inaccessible issue. Retain intent and error; revalidation or cancellation is explicit. A 401 pauses that owner's worker for reconnection. A documented definitive rate-limit rejection waits before fresh validation, rather than tight retrying.
- **Conflict:** remote differs from base and intent for that field. Use Jira discards the intent; Keep mine creates a newly based operation only after current validation.
- **Outcome unknown:** perform reads, not automatic replay. Matching current value resolves as observed desired state without claiming proof of this attempt's execution. A different value, even the old base, cannot prove the request never ran; keep recovery visible. Explicit acceptance or a newly reviewed action resolves it.

## 07 — Implementation ownership and sequence

**Native store/model:** workspace/cache.rs and model.rs own migration, canonical fields, outbox/capability records, projection, queue replacement, and scope pins. Add focused store tests first. No destructive cache reset.

**Native adapter/coordinator:** workspace/jira.rs owns typed mutation responses and capability reads; a small workspace/outbox.rs owns replay policy. workspace/mod.rs and narrow lib.rs registration/identity hooks own IPC, events, and dispatch coordination. Keep token handling in the existing native connection layer.

**Frontend:** src/lib/workspace.ts owns typed commands/events; Workspace.tsx and focused editor/recovery components own issue actions, statuses, and local-query invalidation. App.tsx changes only setup-to-workspace handoff and identity reset. Reuse current components and styles. No broad layout redesign.

Implement persistence and fixture-tested reconciliation first, then native command wiring, then automatic setup sync and editors. A reviewer checks the integrated diff and acceptance evidence once implementation stabilizes. Work may be delegated by owned files, with a single integrator resolving contracts; preserve other contributors' edits.

## 08 — Acceptance evidence

- Migration 1→2 retains multiple boards, details/comments/raw fields, counts and membership; rollback on failure, concurrent migration safety, and refusal of newer schemas. Disagreeing duplicate baselines require refresh rather than guessed replay.
- One issue on two boards produces one field intent; both lists/detail update consistently. Read sync and an edit overlap without losing the overlay or publishing a stale confirmed field. Status leaving scope preserves a recovery entry and pinned detail.
- Local edit plus outbox insertion is atomic across simulated interruption. Unsent replacement/cancellation preserves base; sending/uncertain entries cannot be rewritten. A status conflict and independent assignee change reconcile separately, including transition side effects.
- Account switch/disconnect at capture, dispatch, response, and publication barriers never sends as the wrong account, leaks an event, or discards an old owner's outcome. Requests already sent remain recoverable. No identity lock spans a network wait.
- Restart during sending, lost success response, failed or divergent readback after HTTP success, 400/401/403/404/409, 429, and 5xx fixtures produce the intended state. An ambiguous request never causes a second transition automatically, even when a later read shows the old status.
- Missing/stale offline capabilities, required transition fields, partial candidate searches, inactive/unassignable targets, and deferred unassignment show honest limitations. Revalidation happens before every dispatch.
- Continue performs exactly one initial sync; cached reopen renders immediately and refreshes in the background; reconnect/focus/timer coalesce; failed refresh retains usable cache. Event updates preserve selection and keep board/list/detail/raw fields consistent.
- Run existing Rust/frontend tests and builds plus the new behavioral suites. Verify keyboard focus and pending/recovery UI with fixtures. Report native platform coverage honestly; fixture success is not live Jira write verification. Live mutation testing remains unrun until Yi names and authorizes a test issue.

## 09 — Sources and review decisions

- [Existing approved direction](../2026-09-26-jira-desktop/plan.md) — personal pilot, offline scope, and later live-write authorization boundary.
- [Jira issues reference](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/) and [official OpenAPI](https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json) — inspected transition and assignment request/response contracts. The browser could not render the large issues page; its official OpenAPI supplied the details.
- [Assignable user search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-user-search/) — issue-scoped candidates and search limitations.
- [Enhanced issue search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/) — recent changes may lag; reconcileIssues strengthens read-after-write search behavior.

Review tradeoffs: first-slice transitions cannot require additional field input; offline options need prior issue-specific discovery; remote work is serialized for correctness; uncertain writes need visible recovery instead of blind retry. These are explicit limits of this narrow slice, not abandonment of the full client's later editing requirements.
