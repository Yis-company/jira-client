# Workspace UI redesign

Implements the [approved visual plan](../../.codex/plans/2026-09-27-jira-workspace-ui/plan.md). Review 1 combined Backlog and Future sprints; the revised `review.json` is approved.

## Scope

- Compact navigation for Current sprint, combined Backlog, and Downloaded issues; Settings contains setup, field metadata, appearance, and account actions.
- Future sprint sections and unscheduled backlog share one planning page. Each expanded section uses an independently paged existing query, with at most two concurrent local section reads. No sprint mutations or backend changes.
- Default list and matching board use readable system typography and light/dark themes. Only the theme preference persists in frontend storage.
- A native modal issue view separates content from properties. Status and assignee retain their existing durable edit contracts; other fields and comments remain read-only.
- The existing workspace stays mounted while visiting Settings or Sync changes. Owner-scoped data, pinned recovery issues, and native queue semantics remain intact.

## Verification

Synthetic fixtures only; no live Jira issue mutations or credential access. Browser checks cover 1440px, 1280px, 960px, and a 640px narrow reflow view. Combined Backlog headers and rows fit the viewport; board overflow stays inside the board. Detail is bounded, rejects background focus, and restores the selected row on Escape. Search shortcuts ignore the hidden workspace while Settings is open. Theme switches through Settings.

- `pnpm test`: 58 tests passed across nine files. New tests cover lazy future-sprint queries, two-read concurrency, independent pages/search resets, mode preservation, stale data retention, empty-page Previous recovery, theme settings, and modal behavior.
- `pnpm build` and the macOS ARM64 debug app bundle build pass. Synthetic preview markers are absent from the production bundle.
- Independent specification and quality review passed after correcting stale-data error presentation, empty later-page recovery, selection consistency, and dialog names during loading/error.
- The synthetic status edit flow was exercised through the collapsed editor, local save acknowledgement, Sync changes navigation, and cancellation. The modal closed before recovery navigation.
- React Doctor final scan: 47/100 (prior slice 46), one error and 17 warnings. The existing async subscription cleanup error is a false positive covered by normal and delayed-unsubscribe tests. Remaining warnings concern complexity/component size, state effects, existing ADF positional keys, pnpm policy, and a noncomponent export. No diagnostics were suppressed. CodeRabbit cloud analysis was not run; independent source review was used.
- Screenshot capture succeeded for the redesigned list, combined Backlog, and detail. The 640px check verifies narrow reflow; native 200% OS zoom and Windows/Linux execution are not claimed. macOS packaging does not establish three-platform runtime parity.
