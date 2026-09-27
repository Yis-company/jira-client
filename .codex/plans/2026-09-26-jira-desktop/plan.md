# Jira desktop, with work kept local

Review draft · 26 September 2026 · Product and implementation plan

## 01 — Decision and approval boundary

Build a desktop-only Jira Cloud client for macOS, Linux, and Windows. Match Linear's compact layout, keyboard interactions, and responsiveness; Jira remains the shared system of record. The first version is Yi's personal desktop-only pilot using his own Jira API token. Team onboarding is deferred until a supported distributable authentication design is approved; no server is introduced. Start with one site, one project, and a primary Scrum board. Include site identity in local keys to leave room for multi-site support later, without building it now.

**Approved scope: personal pilot and Slice 1 offline reads.** Following plan review, Yi selected the personal desktop-only pilot with his own API token and authorized Slice 0's authentication and metadata inspector. After confirming metadata works ("it works now"), Yi explicitly requested "work on it, and close the app" for Slice 1: a SQLite read cache for the current sprint, backlog, and future sprints; board/list/detail views; comments; and off-board reads. Jira access remains read-only for this slice, and the app must remain closed during this work. Store the token only in native secure storage; never request it in chat, commit it, or fall back to plaintext. All-field editing and write compatibility remain gates for later mutation features; they do not block the authorized read implementation. Team onboarding, any server, and broader scope changes require a separate decision.

**Deferred team-authentication constraint:** Atlassian's documented OAuth flow requires a client secret, and its documentation explicitly identifies standalone apps as unsupported by that flow. Public native-client PKCE support has not been established. Embedding a shared secret is not a solution. The explicitly approved personal API-token pilot does not establish an acceptable team-distribution design. No server is part of the selected scope.

At the initial planning baseline, the repository had no application implementation. Build one small application, not a platform or a generic synchronization framework.

## 02 — Agreed scope

- **Sprints:** current sprint, backlog, and future sprints; board and list views with shared filters and selection. Create sprints, edit dates/goals, rank and move work, start sprints, and complete them with explicit placement of unfinished work.
- **Issues:** quick creation inside the app, editing, comments, rich descriptions, assignees, prime-number story points, sprint, epic, versions, and all existing custom fields. Respect Jira permissions and required fields. Field creation and workflow administration remain in Jira.
- **Team:** work by teammate, point distribution, sprint-wide progress, blocked/stale work, and unassigned work. No capacity calculator, holiday tracking, Outlook integration, or individual productivity score.
- **Versions:** multiple versions per issue; additive bulk assignment preserves existing versions and never changes status. Group families such as ck-admin and ck-api; prioritize unreleased versions, with released ones available. Create and assign a missing version directly from the typed search. No release notes.
- **Shortcuts:** command menu, search, quick-create, navigation, multi-select, and action menus. Branch template defaults to feature/{jira-id}-{title}, with a branch-safe title slug and configurable template. Settings control whether copying also requests a configured transition.
- **Offline:** everything in the current sprint, including finished issues, plus backlog and future sprints, comments, and supporting metadata. Changes survive restart and synchronize later. Attachments require a connection. No full project-history download.
- **Updates:** automatic online refresh and a scoped in-app inbox derived from observed mentions, comments, and assignments. It is not guaranteed to mirror Jira's native notification service.

Verify the tentative one-project assumption on connection. Fetch boards and let the user select the primary board. Download its columns, status mappings, filters, and estimation configuration; never hard-code workflow names or IDs.

## 03 — Daily experience

**Open and work:** show cached current-sprint work immediately. A compact sidebar contains Inbox, My work, Current sprint, Backlog, Future sprints, Team, Releases, and Settings. A top bar carries filters, search, board/list switching, and sync freshness. Opening an issue preserves the underlying view and exposes properties and activity.

**Plan:** move and rank issues between backlog and future sprints, set estimates/epics/assignees in place, and show total points plus distribution by teammate. Provide keyboard alternatives to dragging. Starting or completing a sprint offline creates a pending operation; never present it as accepted by Jira until confirmed.

**Create:** C opens an overlay with title, rich description, and properties; preserve current context as defaults, reveal Jira-required fields, and support create-another. Local issues receive stable local IDs. Only Jira can assign their actual issue keys, so branch copying waits for the real key.

**Release:** select issues in board/list → Add versions → choose one or more versions → Apply. A missing name offers Create “exact typed name”. Version creation and assignment are dependent operations with separate outcomes. Releases supports names, descriptions, dates, and released state according to permissions; changing versions never silently transitions issues.

**Lead:** group current work by assignee and filter flagged/blocked, stale, or unassigned work. Use explicit Jira flags and blocking links where available; show their meaning. Proposed stale rule: no observed update for seven calendar days, adjustable and visibly defined. Sprint completion follows the board's configured done-status mapping. Historical velocity and capacity forecasting are deferred.

**Find missing work:** project-wide search discovers issues outside the primary board and labels them accordingly. Online search can fetch older issues on demand; offline search explicitly covers downloaded data only. **Proposal:** also download off-board, non-done project issues so a wrong status cannot hide work offline. This extends the sprint/backlog scope deliberately; verify query semantics and volume during discovery. Never equate board-filter exclusion with irrelevance.

**Resolve conflicts:** show the last synced value, local edit, and latest Jira value for each conflicting field. Offer Keep mine, Use Jira, or Edit merged value. Preserve unrelated queued edits. Permission errors and invalid transitions appear as actionable blocked operations, not generic conflicts.

### UI references and interaction proposals

- [Mobbin / Linear list](https://mobbin.com/screens/212fda35-366e-4dc0-a1d1-3b679659d6ab): compact navigation, dense rows, and restrained properties.
- [Mobbin / Linear detail and inbox](https://mobbin.com/screens/beb9d6b3-ec34-46d7-9332-320fcb32a338): three-pane context, properties, and activity.
- [Mobbin / Linear board](https://mobbin.com/screens/fc208a44-dbf9-4f79-b9b0-db57f9840964) and [dark board](https://mobbin.com/screens/720724d3-f686-457f-8c00-fa7efa409b12): compact status columns and cards.
- [Mobbin / Linear creation](https://mobbin.com/screens/7d2d62c7-8fb9-40d8-bd36-f1a8ff0a860c): focused overlay, property chips, and create-another.

The HTML's original mockups illustrate hierarchy, density, and sync feedback. Names, statuses, and counts are sample data. Proposed shortcut subset: C create, / search, Cmd/Ctrl+K commands, J/K navigate, Enter open, Esc dismiss, ? help. Suppress navigation shortcuts in inputs; provide platform modifiers, visible focus, reduced motion, accessible labels, and light/dark themes. This is Linear-inspired, not exact shortcut or visual parity.

## 04 — Small architecture

**React + TypeScript + Vite:** a thin UI using shadcn/ui and ReUI components where suitable, accessible interaction patterns, and virtualized lists. TanStack Query caches reads through typed IPC and invalidates affected queries on Rust domain events; components never call Jira directly. SQLite and the transactional outbox remain authoritative, while React owns view state. Evaluate TanStack DB only if its reactive collections materially simplify this UI; it is optional and must not introduce a second persistence or synchronization authority.

**Tauri 2 + Rust:** own authentication, Jira API mapping, polling, SQLite, and synchronization. Expose narrow domain commands and paginated reads through capability-scoped IPC. Sanitize rich text, restrict content policy, and never give imported Jira content arbitrary shell or native execution privileges.

**SQLite:** save each local projection change and outbox entry in one transaction before saying “Saved locally”. Retain confirmed Jira snapshots separately from pending local overlays. Store site/account context, issues/raw field values, comments, users, sprints, versions, board metadata, outbox dependencies, conflicts, checkpoints, and inbox/read state. Use site/server IDs and random local operation IDs; no hashing.

**Credentials:** use native secure storage outside SQLite, frontend storage, and logs. Prove availability on each OS, including Linux secret-service failure. Never silently fall back to plaintext. Serialize refreshes and atomically store token rotation. Redact diagnostics. Account switching must not discard pending work or replay it as another user.

Proposed boundaries: src/ for UI and local-query hooks; src-tauri/src/jira/ for API mapping; store/ for SQLite/migrations; sync/ for pull/outbox/reconciliation; commands/ for IPC. Avoid a multi-package architecture until evidence requires it.

**Write flow:** action → Rust command → SQLite transaction → UI update; then outbox → Jira → confirmed snapshot → reconciliation → UI event. **Read flow:** polling → Jira snapshot → pending-overlay reconciliation → UI event. No shared server or tunnel. Sync stops when the app is fully exited and resumes when reopened.

## 05 — Synchronization contract

**Bootstrap:** paginate the full agreed scope, comments, and metadata; show progress and only label a view available offline when its download is complete. Refresh permissions and metadata on reconnect. Pin pending local work and dependencies when board/sprint scope changes; never prune unsynchronized changes.

**Freshness:** desktop-only means polling and eventual consistency. Proposed foreground cadence: 15 seconds for active context, slower project reconciliation, refresh on focus/reconnect, jitter and adaptive backoff. Respect Retry-After and rate limits. Display last successful refresh and degraded freshness. Jira indexing, paging, and throttling prevent a guaranteed 15-second end-to-end update time. Webhooks require an externally reachable receiver; that is outside this version.

**Pull correctness:** use supported pagination and overlapping update windows, deduplicating by server ID/revision evidence. Refresh sprints, boards, versions, and metadata separately. Periodically reconcile scope for moves, deletions, permission loss, and filter changes. A denied or partial response is not proof that absent records were deleted.

**Outbox:** preserve per-entity order and explicit dependencies, such as creating a local sprint/version before assigning it. Bound concurrency across independent work. Persist queued, sending, confirmed, conflict, blocked, and outcome-unknown states. Keep failed operations and drafts recoverable across restarts.

**Conflicts:** compare base/local/fresh-remote values field by field. Merge independent fields; ask about divergent same-field edits. Treat rich descriptions and existing comment bodies as whole fields initially. Additive version assignment unions additions with the latest set; explicit removal requires reconciliation. Read before writes and verify afterward. This is not atomic compare-and-swap: another writer can race between those requests. Preserve evidence and surface detectable races; do not promise zero lost updates without endpoint guarantees.

**Unknown outcomes:** a timed-out create/comment/version/lifecycle request may have succeeded. Never blindly retry it. Reconcile through endpoint-supported correlation where available; otherwise retain an outcome-unknown operation for inspection and explicit resolution. Exactly-once delivery is not assumed. Retry only operations proven safe under current preconditions.

**Workflow actions:** at replay, refetch legal transitions, required fields, permissions, sprint/version state, and ranking context. Revalidate sprint start/complete and unfinished-work placement. Compound and bulk actions retain per-step/per-issue outcomes, expose partial failures, and retry only safe unresolved steps. A rejected action leaves local work recoverable.

## 06 — Feasibility gates and proposed decisions

**Authentication — personal pilot selected:** implement direct desktop authentication using Yi's own API token, with native secure storage and no server. Slice 0 must verify identity, required platform/Agile read access, token rejection/expiry behavior, and secure-store failure handling. Do not collect the token through chat, repository files, or plaintext fallback. Supported distributable authentication remains a separate blocker to team onboarding; the personal pilot does not resolve Atlassian's app-distribution constraints.

**All custom fields — blocking:** inventory the pilot site's field schemas, contexts, options, create/edit metadata, transitions, and app fields. Produce a read/edit/create/offline-validation matrix. Jira-managed fields follow Jira permissions. Unsupported app editors remain blockers to the all-editable-fields requirement; an Open in Jira link does not silently satisfy it. Preserve unknown field values and rich-text document nodes without destructive round trips.

**Agile API coverage:** prove permissions and scopes for board configuration, rank, backlog, future sprints, dates/goals, start/complete, estimates, and epic association. Verify board-filter and parallel-sprint behavior. Discover story-point field IDs; preserve prime values. If Jira exposes no allowed numeric choices, confirm the team's prime sequence before enforcing a picker.

**Inbox limits:** verify comments/changelog access. Derive local notifications from observed changes to downloaded issues, with local read state and no baseline-download flood. Catch up when reopened, but do not claim complete historical or native Jira notification parity. Clearly label this scope.

**Release ordering — proposal:** group recognized product prefixes and sort valid numeric semantic versions descending within each. Default to unreleased; keep released versions behind a filter. Nonconforming names remain visible in deterministic name order. Label “highest version”, not “next release”, because multiple unreleased branches may coexist. Creation preserves the typed name, trimming surrounding whitespace.

## 07 — Delivery and acceptance

### Slice 0 — Prove compatibility

Build the approved runnable personal authentication and metadata inspector: native token entry/storage, identity verification, board/project discovery, read-only endpoint probes, and field metadata inspection. Establish endpoint coverage, project/board scope, and field compatibility without mutating Jira. Any later live write verification needs a clearly identified test target and authorization. Record an evidence-backed feasibility report without secrets. The full issue application waits for site compatibility results; team onboarding remains deferred.

### Slice 1 — Local reads

Build shell, SQLite migrations, IPC, account isolation, bootstrap, board/list/detail, project search, and sync state. Verify all scope remains readable after offline restart, including paginated comments and completed current-sprint issues. Test incomplete downloads, off-board work, permission loss, scope changes, and migration recovery.

### Slice 2 — Durable writes

Implement all field adapters, issue/comment creation and editing, rich text, outbox, polling, and conflicts. Verify transactional persistence, restart while sending, expired credentials, accepted writes with lost responses, dependent creates, independent/same-field edits, and safe retries. Demonstrate no blind duplicate creates/comments. Full field compatibility is an exit criterion.

### Slice 3 — Planning and releases

Add sprint lifecycle/ranking, estimates/epics, team overview, additive bulk versions, inline version creation, and release editing. Verify offline plans after remote changes, invalid sprint preconditions, partial completion/bulk failures, and version dependencies. Prove assignment preserves existing versions and never changes status.

### Slice 4 — Daily polish and distribution

Finish shortcuts, branch settings, derived inbox, accessible states, and packaging. Clipboard and transition outcomes are separate; offline transitions remain pending. Verify template sanitization, disabled-transition behavior, local issues without keys, view-switch selection, and inbox baseline suppression. Pilot with Yi only; teammate onboarding waits for a separately approved supported authentication design.

**Three-OS acceptance:** run domain/sync tests, meaningful UI interaction checks, and native smoke tests on macOS, Windows, and Linux. Cover auth callbacks, secure storage, clipboard, keyboard modifiers/layouts, paths/migrations, offline restart, sleep/wake, rich text, and installers. Choose a supported Linux distribution/webview baseline during feasibility. Signing/notarization require release credentials; label unsigned internal builds. A web preview on one OS does not verify the other native platforms.

**Proposed performance targets, not measurements:** on 10,000 cached issues with representative comments, useful cached startup under 2 seconds; local search and durable edit feedback each under 100 ms p95; responsive virtualized navigation without network waits. Measure release builds on named hardware across all three OSes, separately from network freshness. Adjust targets only with evidence and review.

## 08 — What to approve

- Linear-inspired layout and keyboard approach, both views, and release/conflict workflows.
- Desktop-only Tauri/SQLite architecture with eventual-consistency polling.
- Approved personal API-token feasibility pilot and runnable inspector first; resolve site field/API blockers before the full application, and supported distributable authentication before team onboarding.
- Proposed off-board non-done offline inclusion, version sorting, stale threshold, shortcut subset, and performance targets.
- Scoped derived inbox instead of promising Jira notification parity.

Deferred: team onboarding, multi-site UI, shared server, full historical archive, offline attachments, global capture shortcut, capacity/holiday features, Outlook integration, release notes, and Jira administration. Plan approval does not purchase signing certificates, deploy infrastructure, or authorize broad production mutations.

## 09 — Technical sources

- [Atlassian OAuth 2.0 authorization-code grants](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/) — secret requirement, standalone-app limitation, and app distribution guidance.
- [Jira Software Cloud REST API](https://developer.atlassian.com/cloud/jira/software/rest/intro/) — board/sprint API surface.
- [Jira issue fields](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-fields/) and [issues](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/) — schema and mutation contracts.
- [Enhanced issue search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/) — paginated search and indexing consistency.
- [Project versions](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-project-versions/) — version management.
- [Rate limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/) and [webhooks](https://developer.atlassian.com/cloud/jira/platform/webhooks/) — polling constraints and receiver requirements.
- [Tauri security](https://v2.tauri.app/security/) — native/frontend trust boundary.

These sources establish documented constraints, not a live test of the pilot Jira site. The feasibility report must distinguish documented support from actual account, field, and platform evidence.
