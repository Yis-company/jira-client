# Jira Client

A Tauri 2 desktop pilot for one person and one Jira Cloud site, with a local SQLite workspace and durable offline status and assignee edits.

## Run it

Install dependencies with `pnpm install`, then start the native desktop app with `pnpm tauri dev`. `pnpm dev` starts a browser preview; it cannot accept Jira credentials or connect to Jira.

The Rust app uses the operating system credential vault (macOS Keychain, Windows Credential Manager, and Linux Secret Service). If the vault is unavailable, the app reports an error and does not save the token. Nonsecret site and account display metadata is stored in the app configuration directory. Disconnect removes this app's token and clears the saved connection.

## Connect

Enter `<site>.atlassian.net` (with or without `https://`), Jira account email, and a standard API token without scopes. The app checks `/myself` before saving the token. Scoped tokens require Atlassian's gateway/cloud ID flow and are not supported by this direct connection. Requests use bounded timeouts, do not follow redirects, and return sanitized errors.

Choose a project and Scrum board; the initial sync starts automatically. The workspace includes current sprints (including completed issues), backlog, future sprints, and unfinished project issues outside the board. Current sprint and Downloaded issues offer list and board layouts with shared search and selection. Backlog combines future sprint sections and unscheduled work on one page, with independent pagination. Issue details include descriptions, comments, raw fields, and attachment metadata; attachment files are not downloaded.

Saved work opens immediately, with an automatic refresh when online. A refresh replaces the saved snapshot only after the complete download succeeds; a failed refresh keeps the previous snapshot. Online refresh uses polling, not push notifications. SQLite stores issue content locally, partitioned by account, site, project, and board. Disconnect removes credentials and the saved connection; downloaded data remains on the device and is accessible again only through the same account identity.

Status and assignee changes save locally and upload when connected. Online issue inspection caches available transitions and assignable users; offline editors use these previously discovered options. Transitions needing additional form fields and unassignment are not supported yet. Sync changes shows pending edits, rejected requests, conflicts, and uncertain outcomes. A request whose outcome is unknown is never automatically resent.

Project setup and Create fields retain the metadata inspector. General create-field compatibility is explicitly unverified. Issue creation, comments, other field editors, sprint operations, release assignment, and team distribution are later slices.

## Desktop workspace

Open issues in a focused detail window; Escape returns to the selected row. `/` or Cmd/Ctrl+F focuses local issue search, Cmd/Ctrl+B switches list/board outside Backlog, and J/K moves between visible issues when you are not typing.

Settings contains project setup, field metadata, account connection, and Light/Dark/System appearance. Sync changes remains available from the sidebar, including issues that leave the current board results.

## Checks

`pnpm build` type-checks and builds the frontend. `pnpm test` checks connection safety and offline workspace behavior. `cargo test --manifest-path src-tauri/Cargo.toml --lib` checks native validation, REST pagination, complete downloads, and SQLite persistence/isolation, schema migration, durable writes, conflicts, and recovery. These tests use fixtures and do not access Jira or write to the operating system credential vault.
