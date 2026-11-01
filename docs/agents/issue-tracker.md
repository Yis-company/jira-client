# Issue tracker: Linear

Development issues and specs live in Linear, in the `jira-client` team (`JIR`) under Side Projects in the Yis Company workspace: https://linear.app/abrian.

- Team ID: `5311a7e3-5222-4b7d-811f-a55e7f5ff8d0`.
- Issue identifiers use `JIR-<number>`.
- The application's connected Jira Cloud site is product data. The GitHub remote `Yis-company/jira-client` hosts source and pull requests; development tickets belong in Linear.

## Skill operations

Use the connected Linear tools in the Yis Company workspace. Resolve and verify the workspace/team before writes; connection display names may differ from workspace names.

- Fetch a ticket: retrieve its `JIR-<number>` identifier or Linear URL and read its description, comments, and relations relevant to the task.
- Find work: list/search issues scoped to the team ID above, not all teams or the parent Side Projects team.
- Publish to the issue tracker, when requested: create an issue in this team with the requested scope and acceptance conditions. Use a project only when the task or existing issue establishes one; none is configured here.
- Updates, comments, state changes, and parent/blocking relations use Linear's corresponding operations when the task authorizes them. Verify the resulting issue and link after a write.
- Existing workflow states are Backlog, Todo, In Progress, In Review, Done, Canceled, and Duplicate. Re-read the team's current states when changing status; do not create replacements.

Pull requests remain code-review and release work, not an external request queue.

This file records the destination and conventions; it does not independently authorize external writes. Triage labels are not configured because triage is not installed. Preserve the existing team workflow and labels.
