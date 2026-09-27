# Durable status and assignee edits

Slice 2a implements the [approved plan](../../.codex/plans/2026-09-27-jira-durable-writes/plan.md). The structured Plannotator decision in the same directory is `approved`.

## Scope

- Selecting a project and Scrum board starts its first sync. Cached work opens immediately and refreshes in the background.
- Status transitions and assignment to a Jira account are saved durably before the UI reports a local save. Unassignment, transition forms, issue creation, comments, and other field editors are deferred.
- One issue has one set of pending field edits across its cached boards. Confirmed remote data and pending local intent remain separate.
- Issue-specific actions and assignable-user searches are cached when requested online. Offline editing is limited to previously discovered options and revalidated before dispatch.
- Pending changes remain reachable even if an issue leaves the downloaded board scope.
- A lost response does not authorize replaying a workflow transition. Unknown outcomes are read and reconciled, with explicit recovery when the result cannot be established.

## Ownership and recovery

Rust owns SQLite, the queue, mutation transport, validation, replay, and owner-scoped events. React uses typed IPC and TanStack Query. `src/lib/edits.ts` describes the shared editor/recovery contract.

The schema upgrade is additive and transactional. It preserves the existing cache and rejects unknown newer schemas. The prior binary already rejects schema versions above 1; downgrading the binary does not downgrade or delete pending changes. There is no automatic destructive downmigration.

Remote reads and writes are serialized for this personal pilot. Local edits remain responsive during a refresh, though their upload may wait for it. Credentials remain in the operating system vault. Account changes stop new dispatches; requests already sent may still finish and need reconciliation under their original account.

Jira's documented endpoints do not provide a general atomic compare-and-swap guarantee here. Field comparison and readback detect observed conflicts, but cannot guarantee that every race with another Jira client is detected.

## Verification boundary

Automated mutation verification uses synthetic REST fixtures and temporary databases. No production issue is selected for mutation testing. A live write smoke test requires Yi to identify and authorize a specific test issue.

## Validation

- Native fixture suite: 44 tests passed (`cargo test --manifest-path src-tauri/Cargo.toml --lib --locked --offline`). Includes migration/preservation, queue CAS, restart recovery, owner revocation, accepted/unknown response handling, per-issue ordering, and raw Jira capability shapes.
- Native specification review passed after fixing the request-start identity barrier, stable-ID readback comparison, and accepted-write recovery through permission and transient failures.
- Independent bounded quality review passed after correcting stale pending/error messages in the issue drawer. CodeRabbit cloud analysis was not run (CLI unauthenticated); independent source review was used.
- Frontend suite passed 41 tests; `pnpm build` passed. Synthetic T3 browser checks at 960px and 1280px found no horizontal overflow and verified drawer/search/view-switch hit targets, synthetic status enqueue, and the Sync changes before/requested values and cancel control. Snapshot capture was unavailable due to a host automation failure; these checks used DOM and hit-testing evidence.
- React Doctor full scan: 46/100, 1 error and 20 warnings. The subscription-cleanup error points to asynchronous Tauri subscription setup that explicitly cleans up both normal and late resolution; focused tests cover each case. Remaining warnings include component complexity/size, state effects, existing ADF positional keys, pnpm policy, and a noncomponent export. No warnings were suppressed.
- Local macOS ARM64 debug app bundle builds successfully. Windows and Linux runtime behavior is not verified in this environment.
- No live Jira mutation was performed. Polling is used; this does not provide immediate server push or an atomic Jira compare-and-swap guarantee.
