# Workspace and issue detail redesign

27 September 2026 · Visual review · Original sample data, no Jira connection

## 01 — Decision and boundary

Replace the current oversized pilot/diagnostic presentation with a compact desktop workspace: clear navigation, a useful default list, a matching board, and a focused issue detail. Preserve the existing offline cache and durable status/assignee behavior. This is a UI implementation slice, not another Jira feature expansion.

Yi declined live mutation testing and asked to proceed with this redesign. Approval of this plan authorizes frontend implementation and fixture-based UI verification. It does not authorize live Jira writes, app/account resets, database changes, or new backend features. The parent opens the required Plannotator review before implementation. Leave the currently running app alone during planning.

**Recommended:** a compact workspace shell with list/board switching and a modal issue detail. Cosmetic restyling alone would retain the current scattered navigation and diagnostic hierarchy. A permanent three-pane inbox would reduce issue-list width and introduce inbox behavior the client does not yet support. A docked detail also squeezes the list at common window widths, so this slice uses one consistent focused modal. The recommended shell improves the daily read/edit workflow using existing capabilities.

## 02 — Visual direction

The interactive HTML is the primary design review surface. The light design uses a pale gray sidebar, flat white content, quiet dividers, dark readable text, and restrained violet selection. Dark mode uses charcoal surfaces, not pure black or glowing gradients. No marketing hero, large metric cards, decorative backgrounds, or oversized typography.

Use the native system font. Workspace text is 13–14 px, detail body 14 px with 1.6 line height, section labels 12 px, and main headings 18–20 px. List rows are approximately 40 px high; dense does not mean tiny. Icons are 15–16 px with 28–32 px interactive targets. Sidebar is 208 px at desktop sizes and 184 px at 960 px. Keep a consistent 4/8 px spacing rhythm and one subtle radius scale.

Mobbin references informed layout and density; the HTML artwork is original, with no copied screenshots or remote assets. All names, issues, statuses, counts, and sprint dates are illustrative. The mock status/assignee pickers change sample data only. The preview follows the operating-system theme until a review preference is chosen; use Light to inspect the primary reference composition. Its theme controls persist that preference. In the product, theme defaults to the operating system, with Light, Dark, and System choices under Settings; persist only this nonsecret presentation preference. List/board switching in the preview is a review convenience, not a new product data store.

## 03 — Navigation that actually works

**Ship now:** Current sprint, Backlog, and Downloaded issues. Backlog is one planning page containing future sprint sections followed by an Unscheduled backlog section, visible together rather than split into tabs or sidebar destinations. Current sprint and Downloaded issues retain their current/all queries. Downloaded issues makes off-board work discoverable without implying complete project history. A board selector remains available for already downloaded workspaces.

**Quiet utility area:** Sync changes stays persistently reachable with the unresolved count, including out-of-scope issues. Settings contains the existing project/board setup and field-metadata inspector, plus existing connection information and Disconnect. Initial onboarding still selects project/board and Continue starts sync; technical field inspection is not a top-level daily destination.

**Do not render dead destinations:** My work, Team, Releases, and Inbox belong to the longer-term product architecture but are deferred from this slice. The session exposes account name/email, not a reliable Jira account ID for My work; never match people by display name or guess identity from email. Team/release/inbox workflows require further queries or behaviors. No new-issue button, bulk selection, sprint management, or fake filter controls appear.

## 04 — Workspace interaction

Default a newly opened workspace to List. Current sprint and Downloaded issues support List/Board and preserve that preference; Backlog is a list-only planning page and temporarily hides the mode switch without overwriting the preference. A single header shows board context and view title. A compact toolbar contains local issue search, list/board toggle, and a quiet sync status with a manual refresh action. When work needs attention, show the Sync changes count and one concise recovery message rather than multiple stacked banners. Offline, syncing, and last-successful-refresh states use text as well as color.

**Current/downloaded list:** group the currently loaded page by downloaded board columns, then Other statuses. A row contains status marker, issue key, title, assignee, and points when present. Secondary metadata never competes with the title. Clicking the title or pressing Enter on a focused row opens detail. Status/assignee remain editable only in detail in this slice; no accidental write targets on rows. Completed current-sprint work stays visible.

**Current/downloaded board:** use the same issue data, grouping, selection, and pagination. Cards show key, title, assignee, points, and concise pending indicators. No drag-and-drop or column-add controls: those would imply unimplemented writes. Unmapped and explicitly off-board issues appear in Other statuses. Columns scroll horizontally when they cannot fit; the page shell does not gain horizontal overflow.

**Combined Backlog:** show future sprints in start-date order (undated last, stable ID as tie-break), then Unscheduled backlog. Each section has its own title, date range when present, matching total, loaded range, and Previous/Next controls when needed. Keep all section headers present, including empty sections. Initially expand the first future sprint and Unscheduled backlog; remaining sprint headers are collapsed and load only when expanded. The revised preview opens on Backlog; in its small fixture both future sections are expanded to make the combined layout visible. A shared search applies to every section and resets each section page; independent pagination does not move other sections. This is browse/edit-existing-issue planning only: no dragging, sprint creation, issue moves, or lifecycle actions.

**Data honesty:** search remains key/title search within downloaded work. Keep the existing 100-item page limit and native total count per query. Say “Showing 1–100 of 248” when relevant; group/column counts describe this page, not whole-board totals. Do not fetch every page to manufacture a dashboard. Search/scope changes reset paging. For Backlog, use one existing future query with sprintId for each expanded sprint and one backlog query for Unscheduled backlog. Do not fetch the first 100 future issues and group them client-side: that would omit sections or miscount. Cap concurrent local section reads at two and fetch one page per expanded section, not every page. Section totals are authoritative for that section; do not sum them into a unique combined issue total because an issue may belong to multiple sprints. No new sorting/filter APIs or cross-project aggregation.

Opening/closing detail, changing List/Board, or refreshing data preserves scope, query, page, and selection. If the selected issue leaves the current result page, its open detail remains stable while its cache/pin exists; Sync changes can still open pinned context. Stale errors do not survive a successful refresh or operation resolution.

## 05 — Focused issue detail

Open a centered modal detail min(980 px, viewport width minus 48 px) wide. Keep the workspace visible behind a restrained scrim. The header carries the issue key and a clear Close action; there is no decorative command bar. The left content area contains title, readable description, and chronological cached comments. The right property rail contains status, assignee, type, priority, points, sprint, epic, and versions. Missing values read naturally as “Not set” or “Unassigned”.

**Editable now:** status through real available transitions, and assignee through issue-specific assignable-user results. Reuse the existing IssueEditors commands, capability cache, source-status checks, queued replacement rules, and independent field locks. Style the controls as compact property actions without changing their semantics. Unsupported transitions remain unavailable with their reason. Offline options show capture time and their validation-on-sync limitation. Unassignment stays deferred.

**Read-only now:** title, description, comments, type, priority, points, sprint, epic, and versions. Present these as plain values, not buttons or empty composers. Raw/custom-field data remains available under a collapsed “Additional fields” disclosure, preserving the existing value rendering and rich-text safety. Attachments remain online-only and this slice adds no upload/download workflow; do not invent attachment actions that the current adapter cannot perform.

Per-field pending state is visible next to the requested value. Conflicts/blocked/unknown states include a concise link to Sync changes, where existing recovery actions remain authoritative. Save acknowledgement is neutral (“Saved locally”); pending wording derives from current outbox state. Never imply that copying a value, opening a picker, or switching views sends a mutation. No new shortcut invokes a write.

## 06 — Responsive and accessible behavior

At 1440 and 1280 px, use the full sidebar, flexible list, and two-column modal detail. At 960 px, narrow the sidebar, keep title/key/assignee/points readable, and preserve the 40 px row height. Long titles ellipsize in rows and wrap in detail. Below 900 px, move the detail properties above its body and constrain its height; below 760 px, collapse navigation behind a labeled menu and use a full-width detail dialog. At 200% zoom, controls reflow without being clipped.

Use a true modal dialog with accessible name, focus trap, background inertness, scroll containment, and focus restoration to the originating issue. Open focus goes to the detail header/close control; closing restores the issue row or a sensible list fallback if it vanished. Esc first closes an active picker/disclosure overlay, then the detail. Selecting a property must not close the issue. Sync recovery links navigate deliberately and restore context on return.

Use Cmd/Ctrl+F for current-view search and / as a clearly labeled local-search shortcut, an intentional divergence from Linear global search. Defer Cmd/Ctrl+K until a real command menu exists. Cmd/Ctrl+B switches List/Board on Current sprint and Downloaded issues without changing scope or selection; it does nothing on the list-only Backlog page. Enter opens a focused issue, Esc clears search only when search owns focus, and otherwise closes the active overlay. Add J/K only for moving focus among the current page's issue rows/cards, never while typing or in a modal; do not cross pages automatically. Use semantic buttons/links and a table/list structure, not a fake ARIA grid. All actions remain reachable by Tab and visible menus.

Meet WCAG AA text contrast, visible focus, reduced motion, non-color status cues, screen-reader dialog labels, and polite announcements for save/error state. Use existing shadcn/ui and ReUI primitives where suitable. A missing focus-trap primitive may be added as one scoped UI dependency; do not build a custom dialog system.

## 07 — Code and state boundaries

App.tsx owns shell navigation, Settings placement, identity-reset behavior, and opening Sync changes. Workspace.tsx remains the query/lifecycle owner; extract focused navigation/toolbar/list/board/detail components only where that reduces its current rendering complexity. IssueEditors and SyncChanges retain their contracts and recovery logic. app styles receive a scoped token/layout pass; avoid unrelated formatting or backend refactors.

Keep existing workspace.list/read/issues/issue/sync and edits.list/capabilities/enqueue/resolve/sync/subscribe calls. Do not change SQLite schemas, ownership keys, query page semantics, request coordination, or the native dispatch barrier. Owner-scoped TanStack Query keys and event filtering remain intact. Local view preferences contain presentation only, never credentials or issue data; keep scope/query/mode in memory for this slice, with only the theme preference persisted.

No extra background polling or per-row capability request. Fetch detail/capabilities only through the existing selected-issue path. Render a bounded page per active section; do not add virtualization unless profiling demonstrates a problem. Current/downloaded board and list reuse one fetched page. Backlog reuses cached sprint metadata plus independently keyed future(sprintId)/backlog queries, with section-specific offset/limit and the shared search. Collapsed sections do not fetch issue rows; expansion never triggers an unbounded download. Missing/error/loading data gets purposeful inline states that preserve cached content rather than blanking the workspace.

## 08 — Implementation and acceptance

First implement shell/navigation and tokens, then list/board, then the detail presentation, then Settings and sync-state polish. Use representative fixture data throughout. Preserve the working app's state and do not perform live mutations for visual verification.

- Match the reviewed visual hierarchy at 960, 1280, and 1440 px in light/dark themes: readable typography, compact rows, no oversized banners/cards, no clipped controls or shell overflow.
- One-step setup and cached reopen still work; background refresh stays deduplicated. Search, scopes, per-section sprint/backlog queries and pagination totals, off-board placement, and completed-current-sprint visibility remain correct. Backlog shows future sprints and unscheduled work together; verify independent section paging, collapsed lazy reads, empty sections, duplicate membership, and preserved mode when leaving the planning page.
- List/board share selection and query state. Open detail remains stable through refresh; pinned recovery issues open even outside board results. Keyboard focus restores correctly, with no unintended writes from row navigation.
- Status and assignee continue using real cached capabilities and native acknowledgement. Test field locking, queued-base replacement, unknown read-only recovery, accepted-blocked behavior, account isolation, and owner event invalidation without changing their logic.
- Points/sprint/epic/version/comment displays are visibly read-only. Deferred navigation/actions are absent. Incomplete pages and local search never claim whole-project coverage.
- Verify dialog focus/inertness, Esc layering, long content, empty/missing values, 200% zoom, offline/no-capability states, sync failures, and reduced motion. Use fixture preview screenshots plus targeted interaction tests; run the existing frontend suite and build. No redundant native test expansion is needed for a frontend-only change.
- Report visual/browser evidence separately from native macOS/Linux/Windows checks. Building or viewing one platform does not establish three-platform runtime parity. No live Jira write testing is authorized by this design approval.

## 09 — References and review focus

- [Linear list · Mobbin](https://mobbin.com/screens/671d22cf-69d7-4289-886c-f4e2f288f058) — narrow gray sidebar and compact flat rows.
- [Linear grouped list · Mobbin](https://mobbin.com/screens/ef923b0e-9a40-4fdd-80f2-f3aafb4f36ce) — status grouping and restrained density.
- [Linear issue detail · Mobbin](https://mobbin.com/screens/953e88d0-de6c-4eaf-9921-cd0c55bb8412) — readable main content with a right property rail.
- [Linear properties · Mobbin](https://mobbin.com/screens/212fda35-366e-4dc0-a1d1-3b679659d6ab) and [dark board](https://mobbin.com/screens/720724d3-f686-457f-8c00-fa7efa409b12) — metadata hierarchy and calm dark surfaces.

- [Linear search shortcuts](https://linear.app/docs/search), [selection and focus](https://linear.app/docs/select-issues), and [board layout](https://linear.app/docs/board-layout) inform the scoped shortcut subset; this client does not claim exact parity.

Review the actual list, board, issue detail, theme, and narrow-width composition in the HTML. The proposed default is List; Backlog combines future sprints and unscheduled work in one list-only planning page; detail is modal rather than a permanent third pane. No additional product decision is required to proceed once this visual plan is approved.
