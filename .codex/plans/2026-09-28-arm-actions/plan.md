# ARM64 PR checks and desktop releases

## Proposed decision
Add GitHub Actions for build/test PR checks and version-tag desktop releases. Target Linux ARM64 and Apple Silicon only. Create a draft GitHub Release after both platform builds succeed; Yi publishes it after inspecting the downloads.

Review assumptions: “PR reviews” means build/test checks, not an AI reviewer. macOS uses ad-hoc signing initially. These are proposed defaults for approval, not previously confirmed preferences.

## Evidence
The clean checkout has no .github workflows. package.json uses pnpm@12.4.2 and supplies build (TypeScript plus Vite) and test (Vitest). Rust library tests are documented in README.md. package.json, src-tauri/Cargo.toml, and src-tauri/tauri.conf.json each declare version 0.1.0. Tauri bundling is enabled with targets=all and an empty icon list. A .changeset note exists, but there is no Changesets configuration or dependency; it is not an operating release system. The local origin/HEAD points to main. GitHub API access failed in the sandbox; remote settings and runner availability for this repository remain unverified.

## Approach and alternatives
Recommended: two workflows with a small native ARM matrix and explicit commands. This provides platform coverage without cross-compilation or another release framework.
Alternative: build only on tag pushes; cheaper PR checks, but packaging failures surface at release time. Alternative: Changesets release PR automation; useful later for frequent coordinated versioning, but adds tooling for this single desktop package. Keep manual version bumps and tags initially.

## PR workflow
Create .github/workflows/pr.yml, triggered by pull_request and pushes to main. Use read-only contents permission, no secrets, and cancel superseded runs for the same PR/ref. Never use pull_request_target to execute contributed code.

Run ubuntu-22.04-arm with target aarch64-unknown-linux-gnu and macos-15 with target aarch64-apple-darwin. Install Node 24, the packageManager-pinned pnpm, stable Rust, and Linux Tauri prerequisites (WebKitGTK 4.1, GTK, OpenSSL, AppIndicator, librsvg, patchelf, FUSE tooling and build tools). Use frozen pnpm and locked Cargo installs/builds. Cache pnpm and Rust through standard actions; introduce no application hashing.

On each platform run pnpm test, pnpm build, and cargo test --locked --manifest-path src-tauri/Cargo.toml --lib. Then run a locked Tauri release build with explicit target and bundles: dmg on macOS; deb,appimage on Linux. Tauri invokes pnpm build through beforeBuildCommand, so avoid an extra standalone frontend build when the packaging step already provides that check. Set APPLE_SIGNING_IDENTITY=- for macOS ad-hoc signing. Use CI-compatible AppImage extraction settings where needed. Give jobs stable names and finite timeouts. No credential-vault integration test is added.

## Release workflow
Create .github/workflows/release.yml triggered by v* tag pushes. Validate a stable vMAJOR.MINOR.PATCH tag and require exact agreement with package.json, Tauri configuration, Cargo.toml and the root package entry in Cargo.lock. Reject malformed tags and version mismatches before building. Check the tagged commit is on main. Do not rewrite versions during release.

Build and test that tagged commit using the same two platform recipes and explicit bundle formats as PR CI. Upload each platform's installers as workflow artifacts; fail when expected files are absent. Only after both succeed, a separate contents:write job downloads the installers and creates a draft release with generated notes and attaches all three installer formats. Build jobs remain contents:read. Use the built-in GITHUB_TOKEN, with no PAT.

Serialize runs for the same tag without cancelling an active release. Reruns may refresh assets on an existing draft; refuse to overwrite a published release. A failure leaves no newly published release. Do not create tags, publish a release, configure branch protection, or install certificates as part of this implementation.

## Compatibility and signing
Linux builds use Ubuntu 22.04 ARM to keep an older glibc baseline. Publish ARM64 DEB and AppImage only; do not promise every Linux distribution. Linux requires a graphical session and Secret Service for credentials. macOS produces Apple Silicon DMGs with ad-hoc signing; downloads are not notarized and can require a manual Gatekeeper exception. Document that limitation clearly. Developer ID signing and notarization require a separate credential setup if selected in review. No Intel, Windows, updater integration, app-store publishing, RPM, or release-version automation in this slice.

## Files and implementation order
1. Add the two workflow files with current supported action versions, explicit target matrices, permissions, concurrency and timeouts.
2. Add a small release-version validation script only if it materially improves clarity over an inline workflow command. If added, cover matching versions, malformed tags and mismatched versions with focused behavior tests.
3. Update README.md with supported platforms, CI checks, version bump locations including Cargo.lock, tag-to-draft procedure, output formats and signing limits.
4. Check the current empty icon configuration during packaging. Fix only a demonstrated packaging blocker; do not introduce unrelated branding or app behavior changes.

## Acceptance and verification
Validate workflow syntax and expressions with actionlint. Run existing frontend tests/build and Rust library tests locally where dependencies are available. Verify tag validation accepts matching versions and rejects malformed/mismatched values without mutating files. Inspect the matrix to ensure it has only two ARM targets and no universal/Intel output. Perform a local macOS bundle build if supported by the host, keeping generated outputs ignored.

Hosted checks must confirm both native targets and the actual Linux package builds. Downloaded package launch and credential access are manual release smoke checks, not proven by unit tests. Report local results, hosted results and any unrun checks separately. Do not claim hosted success or publish a test tag merely to exercise the workflow without authorization.

## Sources
- GitHub runner labels: https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- Private repository ARM support: https://github.blog/changelog/2026-01-29-arm64-standard-runners-are-now-available-in-private-repositories/
- Tauri GitHub build pipeline: https://v2.tauri.app/distribute/pipelines/github/
- Linux compatibility baseline: https://v2.tauri.app/distribute/appimage/
- macOS signing: https://v2.tauri.app/distribute/sign/macos/

## Approval boundary
Approve this plan in Plannotator to begin implementation. Change PR review type, signing requirements, draft publication policy or package formats through annotations before approval.
