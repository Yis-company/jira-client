# Changesets review and desktop release flow

## Decision to approve
Feature PR → checks → maintainer merge → Changesets release PR → review changelog and run the same checks → maintainer merge → create draft release → build installers → attach and publish.

Linux targets remain x64 and ARM64. macOS remains ARM64 with ad-hoc signing. Only the release workflow builds distributable applications. Confirmed publication choice: publish automatically after every installer succeeds; the release-PR merge is the maintainer's release authorization. A failed build leaves a draft for retry.

This plan replaces the earlier manual-version/tag release design. It is a planning artifact; no workflow implementation or repository setting has been changed for this revision.

## Verified starting point
The repository is a single private npm package named jira-client, currently 0.1.0, with Tauri/Cargo versions also at 0.1.0. One pending minor changeset exists. There is no Changesets CLI or config. Existing PR CI unnecessarily runs Tauri release packaging; release.yml currently starts from manual v* tags and creates a draft only after packaging.

Live repository read: public repository, default branch main, Actions token defaults to read-only, Actions may create/approve PRs, auto-merge disabled. Main has no protection and no required checks. Thus CI exists, but “checks must pass before merging” is not currently enforced.

Current GitHub documentation says token-created/updated PRs trigger opened/synchronize/reopened checks in an approval-required state. A maintainer selects “Approve workflows to run.” Token-created tag/release events still do not automatically start another workflow. Use explicit job dependencies for release creation → packaging; no PAT or GitHub App credential is needed for the requested approval-based flow.

## 1. Normal PR checks: .github/workflows/pr.yml
Keep the normal pull_request opened/synchronize/reopened events, restricted to main, and checks on main pushes. Do not exclude the Changesets branch from normal tests, use skip-CI commit messages, or run privileged pull_request_target code.

Preserve the existing three job names and native matrix: Linux x64 on ubuntu-22.04, Linux ARM64 on ubuntu-22.04-arm, macOS ARM64 on macos-15. Each job installs locked dependencies and runs TypeScript checking (pnpm exec tsc -b), frontend tests, release-helper behavior tests, version consistency validation, and cargo test --locked --manifest-path src-tauri/Cargo.toml --lib. Keep this small matrix rather than introduce a new reusable CI framework.

Remove pnpm tauri build, release-mode compilation, Vite bundling, installer uploads, and signing from PR checks. Rust tests still compile their native test binary; this is required test work, not an application distribution build. Source inspection confirms current Tauri development/test context does not need dist when devUrl exists and custom-protocol is disabled. Verify that behavior in a clean temporary checkout during implementation. Linux jobs retain native test/link prerequisites, but bundle-only tooling belongs in the release workflow.

For ordinary PRs, validate Changesets metadata against the fetched base SHA. A releasable change needs a changeset; non-release maintenance may use the standard empty changeset. Exempt only the same-repository changeset-release/main PR from the requirement for a new note, because versioning consumes the notes. That PR still runs every test and validates the resulting versions and changelog.

## 2. Manage the release PR: .github/workflows/changesets.yml
Add supported Changesets CLI v3 and a matching action v2 release; lock the CLI dependency and use published stable action releases. The action v2 version sub-action is sufficient with mode selection; do not use its npm publishing path.

Add .changeset/config.json with baseBranch main, normal changelog generation, commit false (no skip-CI message), and privatePackages { version: true, tag: false }. Keep package.json private:true. This versions the desktop app without publishing an npm package. Preserve the existing pending minor note.

On pushes to main, run Changesets mode selection; when mode is version, create/update the single changeset-release/main PR using the version action and GITHUB_TOKEN. Serialize updates to that release branch. No pending release notes means no release PR update and no packaging. New feature merges accumulate into the existing release PR instead of creating one release PR per feature.

Use a custom version command that runs changeset version, then copies package.json's resulting version into tauri.conf.json, Cargo.toml and only the root jira-client entry in Cargo.lock. Preserve dependency versions and unrelated content; fail on missing/ambiguous fields. Include all four versions and CHANGELOG.md in the release PR. Do not manually bump them in ordinary PRs or infer a release from an arbitrary ordinary merge.

The maintainer reviews the changelog and generated version diff, approves GitHub's workflow-run prompt if present, waits for the normal checks, then merges. Further bot updates invalidate the prior check result and can require another workflow approval. Keep auto-merge disabled. Explain this sequence in README.md and the release PR instructions. Do not post separate bot messages or install another credential.

## 3. Release: .github/workflows/release.yml
Replace the v* push trigger with pull_request closed targeting main. Start release jobs only when merged is true, the head branch is exactly changeset-release/main, and its head repository is this repository. Normal feature merges and closing an unmerged release PR do not release anything. The maintainer merge supplies the event; do not depend on a token-generated release event to run packaging.

Prepare release: check out the event's merged commit SHA, not the moving main tip. Validate the four versions and corresponding changelog section; confirm that commit belongs to main. Create vVERSION at that exact commit and a draft GitHub Release using the reviewed changelog section as its notes. Reject a pre-existing tag pointing elsewhere. Existing drafts may resume; an already completed published release at the same tag is a no-op, and published assets are never overwritten. The repository's initial 0.1.0 without a merged release PR must not trigger an accidental release.

Build: depends on successful preparation. Read-only build jobs check out the exact same commit and run the established locked production packaging recipes for Linux x64, Linux ARM64, and macOS ARM64. pnpm build runs here through Tauri's beforeBuildCommand. Require one DEB and one AppImage per Linux target, plus one Apple Silicon DMG. Keep ad-hoc macOS signing. No release-version or application changes are made during these builds.

Finalize: depends on all three builds. Download and validate all five expected files, upload them to that draft, then publish it automatically as confirmed by Yi. Draft preparation and finalization alone get contents:write. Build jobs get contents:read. Check release/tag identity again before changing assets. Do not overwrite an already published release.

Serialize attempts for the same release PR/version without cancelling an active packaging run. Failed builds leave the draft unpublished; use GitHub's re-run failed jobs or re-run all jobs to retry that exact source revision. A later feature merge cannot change the source of an existing release run. Do not rebuild a published version or use latest-main as a retry shortcut.

## Merge enforcement and activation
The workflow design and merge enforcement are separate. To make the requested gate mandatory, main must require PRs and passing Linux x64, Linux ARM64, and macOS ARM64 checks, with the PR up to date with main. Keep stable check names. No additional human-review count or separate release approval is introduced.

Prepare those exact repository settings as part of the handoff. Apply them only once these check contexts exist on GitHub and Yi authorizes activating the settings; do not silently change live branch protection during local implementation. Until activation, clearly report that checks are advisory and a maintainer can merge a failing PR. Actions' existing permission to create PRs is already enabled; no token secret setup is required.

The setup change itself does not produce a release. Once its workflows reach main, the existing pending minor changeset should open a release PR proposing 0.2.0. It remains subject to changelog review, CI approval/run, and maintainer merge.

## Why this approach
Recommended: GITHUB_TOKEN, approval-required release-PR checks, and one release job chain. It matches the requested maintainer involvement and avoids event-suppression bugs and extra credentials.

Alternative: a GitHub App token would let bot-created PR checks run without the approval prompt, but adds credential installation and maintenance. It is unnecessary because Yi explicitly accepts being asked to start checks.

Alternative: package on every PR or publish empty public releases before downloads exist. The first conflicts with the requested build timing; the second exposes incomplete releases. Creating a draft first meets release-before-build ordering while publishing only complete downloads.

## Files and scoped work
Modify package.json and pnpm-lock.yaml for Changesets and commands; add .changeset/config.json and contributor instructions; preserve pending notes. Change pr.yml and release.yml; add changesets.yml. Add small scripts for version synchronization and reviewed changelog extraction/release validation, reusing the existing release validator where practical. Add focused fixture-based tests. Update README.md with the lifecycle, workflow approval, support matrix, retry steps and activation prerequisite. No app behavior, UI, credential storage, updater, signing account, or Intel macOS changes.

## Verification before completion
- actionlint on every workflow; frozen pnpm install; existing frontend and Rust tests; TypeScript check.
- In an isolated disposable fixture, run actual Changesets versioning for the private root package: the pending minor note yields 0.2.0, a changelog and synchronized native versions. Do not consume this checkout's pending note during verification.
- Prove version synchronization changes only the root package versions, preserves dependency entries, and rejects malformed/missing fields. Verify ordinary-PR changeset validation and the generated-release-PR exemption.
- Prove source/event filtering rejects ordinary merges, fork branches, and unmerged closures. Test existing-draft retry, wrong-target tag refusal, published-release no-op, missing installer failure, and reviewed changelog selection with mocked GitHub operations.
- Verify the release job chain creates a draft before packaging and cannot publish after a failed matrix job. All five architectures/formats must be accounted for; no bundling command remains in PR CI.
- Hosted acceptance after deployment: feature PR checks → main merge → generated release PR and approval banner → same checks → maintainer merge → draft at correct SHA → three platform builds → five downloads → automatic publication. Local verification does not prove this hosted chain.
- No real tag, release, merge or branch-protection mutation is performed merely to test the design without authorization.

## Sources
GitHub workflow triggering: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow
Merged PR events: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#running-your-pull_request-workflow-when-a-pull-request-merges
Changesets for private apps: https://changesets.dev/guide/beyond-npm
Changesets configuration: https://changesets.dev/guide/config
Changesets automation: https://changesets.dev/guide/automating
Action releases and major compatibility: https://github.com/changesets/action/releases
Version sub-action: https://github.com/changesets/action/blob/main/version/README.md

## Approval
Approve this revised plan before implementation. Yi confirmed automatic publication after all builds succeed. The earlier ARM workflow approval does not replace review of this new release process.
