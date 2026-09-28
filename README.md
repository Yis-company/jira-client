# Jira Client

A Tauri 2 desktop pilot for one person and one Jira Cloud site, with a local SQLite workspace and durable offline issue edits.

## Run it

Install dependencies with `pnpm install`, then start the native desktop app with `pnpm tauri dev`. `pnpm dev` starts a browser preview; it cannot accept Jira credentials or connect to Jira.

The Rust app uses the operating system credential vault (macOS Keychain, Windows Credential Manager, and Linux Secret Service). If the vault is unavailable, the app reports an error and does not save the token. Nonsecret site and account display metadata is stored in the app configuration directory. Disconnect removes this app's token and clears the saved connection.

## Connect

Enter `<site>.atlassian.net` (with or without `https://`), Jira account email, and a standard API token without scopes. The app checks `/myself` before saving the token. Scoped tokens require Atlassian's gateway/cloud ID flow and are not supported by this direct connection. Requests use bounded timeouts, do not follow redirects, and return sanitized errors.

Choose a project and Scrum board; the initial sync starts automatically. The workspace includes current sprints (including completed issues), backlog, future sprints, and unfinished project issues outside the board. Current sprint and Downloaded issues offer list and board layouts with shared search and selection. Backlog combines future sprint sections and unscheduled work on one page, with independent pagination. Issue details include descriptions, comments, raw fields, and attachment metadata; attachment files are not downloaded.

Saved work opens immediately, with an automatic refresh when online. A refresh replaces the saved snapshot only after the complete download succeeds; a failed refresh keeps the previous snapshot. Online refresh uses polling, not push notifications. SQLite stores issue content locally, partitioned by account, site, project, and board. Disconnect removes credentials and the saved connection; downloaded data remains on the device and is accessible again only through the same account identity.

Status, assignee, title, description, and next-sprint moves save locally and upload when connected. Online issue inspection caches available transitions, assignable users, and editable fields; offline editors use these previously discovered capabilities. Unassignment is available when Jira permits it. Transitions needing additional form fields remain unavailable. Descriptions use Tiptap with an explicit Jira ADF adapter; unsupported content stays read-only rather than losing formatting or embedded content. Sync changes shows pending edits, rejected requests, conflicts, and uncertain outcomes. A request whose outcome is unknown is never automatically resent.

Daily shows one active sprint's goal, weekdays left, assigned workload, and observed burndown. It reads the entire saved sprint, independently of list filters and pagination. Standard issues are counted once; subtasks and epic rollups are excluded, and missing estimates/type metadata are disclosed. History begins with successful syncs after this feature is installed, with no reconstructed past data. The finish projection requires at least three comparable working-day intervals of confirmed net completion; removing scope does not count as completing work. Days use the displayed local timezone and Monday–Friday, without holiday or leave assumptions. Select work to simulate moving it, then confirm each move to a named future sprint.

Project setup and Create fields retain the metadata inspector. General create-field compatibility is explicitly unverified. Issue creation, comment editing, other field editors, sprint creation/lifecycle, release assignment, and team distribution are later slices.

## Desktop workspace

Open issues in a focused detail window; Escape returns to the selected row. `/` or Cmd/Ctrl+F focuses local issue search, Cmd/Ctrl+B switches list/board outside Backlog, and J/K moves between visible issues when you are not typing.

Use drag handles to move an issue between status groups in either list or Kanban view. Keyboard dragging and the Move status menu use the same Jira transition checks. Empty status groups remain available as destinations. These moves change status, not issue rank. Click the current assignee for a single searchable picker; Escape closes the picker before the issue dialog. Title and description drafts have explicit Save/Cancel and warn before discarding unsaved changes.

Settings contains project setup, field metadata, account connection, and Light/Dark/System appearance. Sync changes remains available from the sidebar, including issues that leave the current board results.

## Checks

`pnpm exec tsc -b` checks TypeScript. `pnpm test` checks connection safety and offline workspace behavior. `node --test scripts/*.test.mjs` checks release helpers against fixtures. `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` checks native validation, REST pagination, complete downloads, and SQLite persistence/isolation, schema migration, durable writes, conflicts, and recovery. These checks do not access Jira or write to the operating system credential vault.

## Changes and releases

Feature pull requests run one `Validation` job on Linux x64 (`ubuntu-22.04`): lint if configured, TypeScript checks, frontend tests, release-helper tests, Rust library tests, and a check for a changeset in the PR. There is currently no lint script. Rust tests compile test binaries; PRs do not build or package the desktop application. A releasable pull request includes a Changeset for `jira-client`; use `pnpm exec changeset` to describe the change and select its patch, minor, or major bump. For a change that should not alter the app release, use `pnpm exec changeset --empty`.

After changesets merge to `main`, the Changesets workflow creates or updates one `changeset-release/main` pull request. Review its generated `CHANGELOG.md` and version updates in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the root `jira-client` entry in `src-tauri/Cargo.lock`. The generated PR must pass the same `Validation` job; its consumed changesets are replaced by validation of the generated versions and changelog. GitHub may require a maintainer to approve the bot-created workflow run; approve it and wait for checks to finish before merging. If another feature updates the PR, approve and wait for the latest run again. Do not manually bump versions in feature PRs.

Merging the Changesets PR starts a release from that exact merge commit. The workflow creates or resumes a draft release, builds Linux x64, Linux ARM64, and macOS ARM64, then attaches two Linux installers per architecture (`.deb` and `.AppImage`) and the Apple Silicon `.dmg`. It publishes automatically only after all five installers pass validation and upload. A failed build leaves the release as a draft; rerun the failed jobs for that same workflow run and source commit.

The Linux packages use an Ubuntu 22.04 baseline, and compatibility varies across distributions. Linux requires a graphical session and Secret Service for credential storage. The macOS DMG is ad-hoc signed and not notarized; macOS may require a manual Gatekeeper exception before opening it. Developer ID signing and notarization are not configured.

The required PR check should be `Validation`. Checks remain advisory until branch protection requires pull requests, `Validation` to pass, and PR branches to be up to date with `main`; those repository settings have not been activated.
