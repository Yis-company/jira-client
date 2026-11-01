# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The owned interface is shared React UI in a Tauri desktop application. This classification describes its design language; it does not make the browser preview a supported Jira-connected product or imply iOS/Android support.

## Users

Yi is the primary user of this personal desktop pilot: review Jira work, make supported issue edits, and plan the current and future sprints from one local workspace. Team onboarding is deferred pending a separately approved authentication design.

## Product Purpose

Keep Jira Cloud work useful from the desktop when connectivity is slow or unavailable. Open downloaded work immediately, save supported edits durably, and make synchronization and recovery understandable without losing local intent. Jira remains the shared system of record.

## Operating Context

- One person and one Jira Cloud site, with project and Scrum-board selection. Cached data is partitioned by account, site, project, and board.
- Current sprint, combined future-sprint/backlog planning, downloaded issues, Daily, focused issue detail, Settings, and Sync changes are the working surfaces. List and board share search and selection; Backlog is list-only.
- Native desktop connection uses the person's standard API token in the OS credential vault. The browser preview cannot accept credentials or connect to Jira. No shared server is part of this pilot.
- React uses typed IPC and TanStack Query. Rust owns Jira access, SQLite snapshots, durable edits, and synchronization. Frontend presentation storage contains the theme preference, not credentials or issue data.

## Capabilities and Constraints

- Saved work opens before online refresh. Only a complete successful download replaces the previous snapshot. Offline search covers downloaded work, not the entire Jira history. Attachment metadata is cached; attachment files are not downloaded.
- Status, assignee, title, description, and next-sprint moves save locally and upload when connected. Editing follows discovered Jira capabilities and permission checks. Unsupported rich description content stays read-only rather than being rewritten destructively.
- "Saved locally" and Jira confirmation are different outcomes. Pending changes remain reachable beyond current board results. Rejected requests, conflicts, and unknown outcomes are visible in Sync changes; an uncertain request is never blindly resent. Readback cannot guarantee every concurrent Jira race is detected.
- Daily uses the saved sprint and observed successful-sync history. It discloses missing metadata and does not invent past burndown, capacity, holiday, or leave evidence.
- Issue creation, comment editing, general field compatibility, sprint creation/lifecycle, release assignment, and team distribution remain later slices. Do not expose them as working actions merely because an older plan describes them.
- Desktop platform intent includes macOS, Linux, and Windows. The current release workflow targets macOS ARM64 and Linux x64/ARM64; packaging and fixture checks do not establish native runtime parity. macOS signing/notarization and broader support claims remain limited as described in README.

## Evidence on Hand

- `README.md`: current workflows, supported edits, known limits, checks, and Changesets release process.
- `docs/implementation/`: historical offline-read, durable-write, and workspace-UI decisions; later README behavior supersedes earlier slice deferrals.
- `docs/feasibility/2026-09-26.md` and approved `.codex/plans/`: personal-pilot decision and scoped approval records.
- `src/`, `src-tauri/`, and `tests/preview.*`: incumbent implementation and synthetic UI fixtures. Fixtures and previous build reports are not live Jira or cross-platform runtime proof.

## Product Principles

- Keep useful cached work available without waiting for the network.
- Preserve local intent and explain its confirmation and recovery state.
- Respect account isolation, credential boundaries, and Jira's actual capabilities.
- Keep daily work focused; separate setup and recovery from routine browsing.
- Describe supported behavior and observed evidence precisely; leave future scope explicit.

## Accessibility & Inclusion

Preserve the approved accessibility requirements: keyboard access and alternatives to dragging, platform-appropriate shortcut modifiers, visible focus, modal focus restoration, labeled controls, non-color status cues, reduced motion, and WCAG AA text contrast. These are requirements, not a claim that every native platform or assistive technology has been verified.
