# Offline read slice

Implementation of Slice 1 from the reviewed Jira desktop plan. Yi confirmed direct authentication and metadata inspection working, then explicitly requested the offline read layer and closing the app. The app was quit and confirmed absent before implementation.

## Accepted behavior

- SQLite caches current active sprints (including completed issues), backlog, future sprints, and off-board unfinished issues in the selected project.
- Board/list views share filters and selected issue. Search reads downloaded data; pagination reports the full matching count.
- Details preserve descriptions, raw custom fields, comments, and attachment metadata. Attachments remain online-only.
- Cached work is available after process restart without a Jira request. Initial download and later refresh states remain explicit.
- A new snapshot replaces the previous snapshot only after every required page and comment collection has succeeded. Failure preserves the previous complete snapshot.
- Account/site/project/board identity partitions every cached read and write. Cache reads do not retrieve the token or contact Jira. No custom hashing.
- Refresh is serialized; the account is rechecked before publishing results. No stale result may publish into a newly selected account.
- No Jira mutations or offline outbox are introduced in this slice. Write compatibility remains a separate checkpoint.

## Boundaries

Rust owns SQLite, paging, Jira transport, and cache publication. React reads typed IPC through TanStack Query. `src/lib/workspace.ts` is the shared frontend command contract. TanStack DB is not added because SQLite already owns persistence and this slice does not need a second collection system.

Jira response contracts must use official REST shapes, not the connector's normalized objects. Current enhanced Software issue endpoints use cursor pagination; sprint metadata and comments use their documented offset pagination. A missing pagination total must not silently truncate a collection.

The initial download may fetch full issue details and comments. Warm refresh should reuse complete unchanged details to avoid repeatedly downloading every comment. The UI uses a conservative foreground refresh interval and explicit retry, with server rate-limit cooldown respected.

## UI references and reuse

The approved plan contains the Mobbin Linear references. This slice uses compact navigation, issue rows/status columns, and a detail pane. shadcn primitives remain the shared controls. ReUI's [compact Radix Alert](https://reui.io/r/radix-mira/alert.json) is the source for composed freshness/error callouts, adapted to the repository's existing CSS and class utility.

## Required evidence before completion

- SQLite close/reopen and cross-account isolation tests.
- Correct current/backlog/future/off-board membership, including completed current-sprint work.
- Multi-page issues and comments with raw REST fixtures, missing totals, malformed/non-progress responses.
- Failed refresh leaves old complete data unchanged; first incomplete download is not marked offline-ready.
- Mocked UI tests for cache-first startup with network failures, selection across views, search/paging, and safe rich-text rendering.
- Frontend build, native tests/check, local macOS bundle. Windows/Linux execution is reported separately if unavailable.
- Keep Jira Client closed unless Yi later asks to open it. Browser UI verification may use synthetic test data clearly isolated from production data.

## Verification on 2026-09-27

- Frontend build and all 19 Vitest tests pass. Tests cover cache-first startup, account reset, initial download, failure retention, foreground refresh/reconnect, project/board selection, shared layout state, paging, and safe rich text.
- All 19 Rust tests pass with `--locked --offline`; `cargo check` and formatting pass. Evidence includes reopening SQLite, every identity partition, rollback, concurrent first migration, current-sprint Done/off-board membership, multi-page comments, warm reuse, and a 120-second Retry-After.
- Session bootstrap now reads saved configuration only. Keyring access is needed by online commands, not by cached reads. Account generation is checked before publishing a download, including disconnect/reconnect to the same identity.
- Local debug macOS app bundling succeeds without launching the app. Native Windows/Linux execution, signing, and a live complete Jira download have not been tested in this slice. Yi previously confirmed authentication and create-metadata inspection working.
- The isolated `tests/preview.html` harness mounts the actual app with a clearly labeled synthetic session/cache. Production output contains none of its fixture markers. T3 browser navigation, DOM measurements, and interactions work; screenshot capture repeatedly fails at the host tool, so a screenshot-based visual review is not claimed.
- Browser checks at 960×640 and 1280×800 exposed and verified the fix for a detail-pane overlap: board/list controls remain hit-testable and clickable while preserving the selected issue, with no document-width overflow. The native `jira-client` process was confirmed absent after building.
- Read-only spec and quality review found and prompted fixes for keyring-dependent startup and project/board picker mismatch. CodeRabbit could not run because its installed CLI is signed out.
- React Doctor finishes at 53/100 with 11 warnings, not a clean scan. Hook dependency warnings were fixed. Remaining warnings are component size/complexity, the project-picker default-selection effect, positional keys in immutable ADF rendering, the shadcn variant export, and pnpm policy suggestions. No rule suppressions or unrelated dependency policy changes were added.

ReUI Alert provenance is the official registry URL above; the MIT notice is retained in `src/components/reui/LICENSE.reui.md`, copied from the [upstream license](https://github.com/keenthemes/reui/blob/main/LICENSE.md).

### Sync field-selection repair

Yi reported `Jira returned metadata in an unexpected format` during Download / Sync. The enhanced `/rest/api/3/search/jql` request omitted `fields`, so Jira's documented ID-only default could not satisfy the parser's project/key/update inputs. It now explicitly requests `project,updated`. A regression fixture returns IDs only for the old request and complete field data for the corrected request: it failed with `Metadata` before the fix and passes afterward. All 20 native tests pass. This establishes the request-contract defect; a successful live sync still requires confirmation.
