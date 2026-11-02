# Retro: jira-client, 2026-10-26 to 2026-11-01

- **Window:** 2026-10-26T00:00:00Z (inclusive) to 2026-11-02T00:00:00Z (exclusive), UTC
- **Device:** MacBook Pro (Yi), environment `17d3cb3b-7d63-4119-8d4f-ab0f49e7b15d`
- **Project:** jira-client (`41649481-7c81-4d99-b872-a4479f63d566`), workspace `/Users/yitam/Documents/code/ybtam/jira-client`
- **Repository:** `Yis-company/jira-client`, confirmed from `git remote -v` (origin)
- **Method:** read-only. Matt Pocock's `retro` and `writing-for-agents` skills were fetched from GitHub because no local copy is installed.

## Coverage

| Source | In window | Read |
|---|---|---|
| T3 root threads | 2 | 2. Messages were read in full. Activity was read for all 111 pre-push items, and messages for all 133 setup items. |
| T3 child or subagent threads | 0 | Listing with `includeSubagents` returned none. |
| Local Codex rollouts (cwd = repo) | 3 | 2 match the T3 threads. The third is a Codex "guardian" approval subagent for the setup thread: 12 assessments, all `allow` (10 low risk, 2 medium). |
| Claude sessions for this repo | 0 | Only this retro session exists. |
| PRs with activity in the window | 2 (#6, #7) | Both read in full: body and files, commits, reviews (0), inline comments (0), discussion (only changeset-bot), and check runs. Every collection was paged. |
| Other repo issues and PRs updated since 2026-10-26 | 0 | Search returned only #6 and #7. PR #5 was last updated 2026-10-24, which is outside the window. |

All in-window work happened on 2026-11-01. The other days had no sessions or PRs.

**Gaps:** I did not open the full log text of CI runs; I used check-run conclusions and timestamps. The two other T3 threads in this project (from September) are outside the window.

## Findings, ranked by severity

### 1. High: `main` has no required checks, and PR #6 merged before CI finished (open)

- **What happened:**
  - [PR #6](https://github.com/Yis-company/jira-client/pull/6) merged at 09:31:32Z. Its `Validation` check ran from 09:31:05Z to 09:34:14Z, so the PR merged about 2.7 minutes before CI finished. CI passed afterwards.
  - Neither #6 nor [#7](https://github.com/Yis-company/jira-client/pull/7) received any review.
- **Current state:**
  - `gh api …/branches/main/protection` returns 404 "Branch not protected", and there are 0 rulesets.
  - The new pre-push hook (`scripts/pre-push.sh`) can be skipped with `--no-verify`.
  - The hook leaves out `cargo test` and `check-changeset.mjs` (`.github/workflows/pr.yml:46-49`). The approved plan and the session's final message both say "CI remains authoritative", but nothing enforces that.
- **Root cause:** the CI guardrail exists but is not wired in as a merge gate.
- **Smallest durable change:** add a ruleset or branch protection on `main` that requires the `Validation` status check.
- **How to verify:** `gh api repos/Yis-company/jira-client/rulesets` lists the rule, and the merge button on a PR with a running check shows "Required statuses must pass".

### 2. Medium: the pre-push hook installed dependencies on its first real push (fixed in the hook, partly open elsewhere)

- **What happened:**
  - In [pre-push hooks](t3-thread://v2/17d3cb3b-7d63-4119-8d4f-ab0f49e7b15d/mcp:launch:d9aa5e52f4ff6ae67312005743c308ead67741e72a9ca4872432b5860e09b1aa), item 85 (15:54:52Z): `git push` ran the hook, and pnpm 12.15.0 (the `packageManager` pin) ran an install step automatically. The approved plan said a push must never install dependencies.
  - The earlier fixture tests (items 50, 59-64) did not cover this case.
  - The agent noticed it (item 89), traced it to `verifyDepsBeforeRun` (items 90-99), and fixed it in commit `6cb0de7` by adding `export PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=error` to `scripts/pre-push.sh:5`. A missing-dependencies fixture then confirmed that nothing gets installed.
- **What is still open:** the setting lives only in the hook. When an agent runs `pnpm test` or `pnpm exec tsc -b` directly (as the session did, item 48), pnpm can still install silently.
- **Smallest durable change (optional, needs your decision):** set `verifyDepsBeforeRun: error` in `pnpm-workspace.yaml`. The hook line would then be redundant and could be removed.
- **How to verify:** with an outdated `node_modules`, `pnpm test` fails with the verify-deps error instead of installing.

### 3. Low to medium: CI and the hook each keep their own copy of the check list, and the lint step does nothing (open)

- **Current state:**
  - `pr.yml:42-45` and `scripts/pre-push.sh:6-8` each list the same commands (`tsc -b`, `pnpm test`, `node --test scripts/*.test.mjs`), and can drift apart.
  - `package.json` has no `check` script. It also has no `lint` script, so `pnpm run --if-present lint` (`pr.yml:42`) silently does nothing. The repo has no linter or formatter.
- **Session evidence:**
  - Both agents found the check commands by reading CI and the README (pre-push items 10, 16, 17, 20).
  - Both found the empty-changeset requirement only when creating the PR (setup thread item 110; pre-push item 80).
  - No session shows a mistake a linter would have caught. The lint gap is a standing gap, not an observed failure.
- **Smallest durable change:** add one `check` script to `package.json`, and call it from both the hook and CI. Whether to add a linter is a separate decision for you.
- **How to verify:** `grep -c 'tsc -b' scripts/pre-push.sh .github/workflows/pr.yml` returns 0 and 0, and both files call `pnpm check`.

### 4. Low: plan artifacts are handled inconsistently (open)

- **What happened:**
  - All seven earlier plan folders under `.codex/plans/`, plus PR #6's plan, `review.json` and plan HTML, are committed.
  - PR #7 left `.codex/plans/2026-11-01-pre-push-hooks/` untracked (git status still shows `?? .codex/plans/2026-11-01-pre-push-hooks/`).
- **Root cause:** no written convention says whether plans should be committed.
- **Smallest durable change:** you decide whether plans ship with their PR, then record that in one line wherever the PR skill or plan workflow is defined (not in this repo's AGENTS.md).
- **How to verify:** the next plan-gated PR either includes its plan folder or follows the stated rule.

## Not findings (observed and already working)

- **Tracker confusion was fixed during the week.** The setup agent recommended GitHub Issues, and you corrected it to Linear (setup thread item 69, 08:25:57Z). `AGENTS.md:7` and `docs/agents/issue-tracker.md` now record Linear `JIR` with its team ID.
- **Plan gates worked.** Both plans went through Plannotator approval before any implementation (setup thread item 94; pre-push item 35).
- **Branch hygiene recovered on its own.** The pre-push work was first done on the already-merged `docs/matt-impeccable-setup` branch (item 69). The agent rebased it onto a fresh `origin/main` before opening the PR (items 77-79). Nothing went wrong, so no change is proposed.
- **Tool use looked proportionate:** 37 commands in about 6 minutes of active work in the pre-push thread. The Matt setup skill was read from another project's checkout (`abrian/Zhongxin/...`) because it is not installed globally. That was a one-off setup cost, so no action is proposed.
- `AGENTS.md` is 15 lines of pointers, with no sprawl and no lines that do nothing.

## Highest-value proposed actions (not implemented)

1. Require the `Validation` check on `main` through a ruleset (finding 1).
2. Add a single `check` script and call it from both `pre-push.sh` and `pr.yml` (finding 3).
3. Optionally, move `verifyDepsBeforeRun: error` into `pnpm-workspace.yaml` (finding 2).
