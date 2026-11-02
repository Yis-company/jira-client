# Retro follow-up: checks and plan records

## Decision for review
Adopt the existing majority convention: commit approved plan records with their related change, including the Markdown, HTML and final review result. Preserve unrelated untracked files; do not retroactively add the pre-push plan without a separate decision. Record the convention in the repository's plan workflow guidance, scoped to this project.

## Implementation sequence
1. Confirm the current branch and working tree, preserving all unrelated untracked files. Do not commit, push, create a PR, or change branch protection.
2. Add a single package `check` script for the existing TypeScript, frontend test, and script-test commands, in their current order. Have both the pre-push hook and PR workflow call it. Keep the hook's no-auto-install setting and the CI-only changeset and Rust checks. Remove the misleading optional lint step; do not introduce a linter.
3. Update README check descriptions and record the plan-artifact convention in the repository workflow guidance. Include the approved records for this work in the eventual change; leave the pre-existing untracked plan alone.
4. Run the shared check and focused existing hook-related verification as applicable. Inspect the workflow and hook to confirm both use the same entry point, CI-only checks remain, failures stop execution, and no install is triggered by the hook. Report exact results and any environment blockers.

## Scope and acceptance
This addresses retrospective findings 3 and 4. It does not change app behavior, add tooling, change pnpm's global install policy, or configure GitHub protections. Yi reviews this plan in Plannotator; implementation starts only after approval. Approval notes guide the work.
