import type { IssueSummary } from "../lib/workspace";
import type { PendingChange } from "../lib/edits";

export type StatusColumn = {
  name: string;
  statusIds: string[];
  issues: IssueSummary[];
};

type IssueViewProps = {
  issues: IssueSummary[];
  columns: StatusColumn[];
  selectedId: string | null;
  changesByIssue: Map<string, PendingChange[]>;
  onOpen: (issue: IssueSummary, button: HTMLButtonElement) => void;
};

export function WorkspaceList({
  issues,
  columns,
  selectedId,
  changesByIssue,
  onOpen,
}: IssueViewProps) {
  const grouped = columns
    .map((column) => ({
      title: column.name,
      category: column.issues[0]?.status.category ?? "indeterminate",
      issues: column.issues,
    }))
    .filter((group) => group.issues.length > 0);
  const mappedIds = new Set(
    columns.flatMap((column) => column.issues.map((item) => item.id)),
  );
  const other = issues.filter((issue) => !mappedIds.has(issue.id));
  if (other.length)
    grouped.push({
      title: "Other statuses",
      category: "indeterminate",
      issues: other,
    });

  return (
    <div className="workspace-list">
      {grouped.map((group) => (
        <section className="workspace-group" key={group.title}>
          <h2 className="workspace-group-heading">
            <span
              className={`workspace-status-dot ${group.category}`}
              aria-hidden="true"
            />
            <span>{group.title}</span>
            <span
              className="workspace-page-count"
              aria-label={`${group.issues.length} issues on this page`}
            >
              {group.issues.length} on this page
            </span>
          </h2>
          <ul className="workspace-issue-list">
            {group.issues.map((issue) => (
              <li key={issue.id}>
                <IssueRow
                  issue={issue}
                  selected={selectedId === issue.id}
                  pending={changesByIssue.get(issue.id) ?? []}
                  onOpen={onOpen}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function WorkspaceBoard({
  issues,
  columns,
  selectedId,
  changesByIssue,
  onOpen,
}: IssueViewProps) {
  const grouped = columns.map((column) => ({
    title: column.name,
    category: column.issues[0]?.status.category ?? "indeterminate",
    issues: column.issues,
  }));
  const mappedIds = new Set(
    columns.flatMap((column) => column.issues.map((item) => item.id)),
  );
  const other = issues.filter((issue) => !mappedIds.has(issue.id));
  if (other.length)
    grouped.push({
      title: "Other statuses",
      category: "indeterminate",
      issues: other,
    });

  return (
    <div className="workspace-board-scroll">
      <div className="workspace-board" aria-label="Issues grouped by status">
        {grouped.map((group) => (
          <section className="workspace-column" key={group.title}>
            <h2 className="workspace-column-heading">
              <span
                className={`workspace-status-dot ${group.category}`}
                aria-hidden="true"
              />
              <span>{group.title}</span>
              <span
                className="workspace-page-count"
                aria-label={`${group.issues.length} issues on this page`}
              >
                {group.issues.length}
              </span>
            </h2>
            <ul className="workspace-issue-list">
              {group.issues.map((issue) => (
                <li key={issue.id}>
                  <IssueRow
                    issue={issue}
                    selected={selectedId === issue.id}
                    pending={changesByIssue.get(issue.id) ?? []}
                    onOpen={onOpen}
                    board
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

export function FlatIssueList({
  issues,
  selectedId,
  changesByIssue,
  onOpen,
}: {
  issues: IssueSummary[];
  selectedId: string | null;
  changesByIssue: Map<string, PendingChange[]>;
  onOpen: (issue: IssueSummary, button: HTMLButtonElement) => void;
}) {
  return (
    <ul
      className="workspace-list workspace-issue-list"
      aria-label="Issues in this section"
    >
      {issues.map((issue) => (
        <li key={issue.id}>
          <IssueRow
            issue={issue}
            selected={selectedId === issue.id}
            pending={changesByIssue.get(issue.id) ?? []}
            onOpen={onOpen}
          />
        </li>
      ))}
    </ul>
  );
}

function IssueRow({
  issue,
  selected,
  pending,
  onOpen,
  board = false,
}: {
  issue: IssueSummary;
  selected: boolean;
  pending: PendingChange[];
  onOpen: (issue: IssueSummary, button: HTMLButtonElement) => void;
  board?: boolean;
}) {
  return (
    <button
      type="button"
      className={
        board
          ? `workspace-row workspace-board-card${selected ? " selected" : ""}`
          : `workspace-row${selected ? " selected" : ""}`
      }
      data-issue-id={issue.id}
      aria-pressed={selected}
      onClick={(event) => onOpen(issue, event.currentTarget)}
    >
      <span className="workspace-row-status-cell">
        <span
          className={`workspace-row-status ${issue.status.category}`}
          aria-label={`Status: ${issue.status.name}`}
        />
        <span className="workspace-row-status-label">{issue.status.name}</span>
      </span>
      <span className="workspace-row-key">{issue.key}</span>
      <span className="workspace-row-title">{issue.summary}</span>
      <span className="workspace-row-assignee">
        {issue.assignee?.displayName ?? "Unassigned"}
      </span>
      {issue.storyPoints !== null && (
        <span className="workspace-row-points">{issue.storyPoints} pts</span>
      )}
      {pending.length > 0 && (
        <span
          className="workspace-row-pending"
          aria-label={`Pending: ${pending.map((change) => `${change.field} ${change.state}`).join(", ")}`}
        >
          {pending.some((change) =>
            ["blocked", "conflict", "unknown"].includes(change.state),
          )
            ? "Needs attention"
            : "Saved locally"}
        </span>
      )}
    </button>
  );
}

export function WorkspacePagination({
  total,
  offset,
  loaded,
  onOffsetChange,
}: {
  total: number;
  offset: number;
  loaded: number;
  onOffsetChange: (offset: number) => void;
}) {
  const first = total === 0 ? 0 : Math.min(offset + 1, total);
  const last = Math.min(offset + loaded, total);
  return (
    <nav className="workspace-pagination" aria-label="Issue pages">
      <span>
        {loaded > 0
          ? `Showing ${first}–${last} of ${total}`
          : `No issues on this page · ${total} total`}
      </span>
      {(offset > 0 || offset + loaded < total) && (
        <div>
          {offset > 0 && (
            <button
              type="button"
              onClick={() => onOffsetChange(Math.max(0, offset - 100))}
            >
              Previous
            </button>
          )}
          {offset + loaded < total && (
            <button type="button" onClick={() => onOffsetChange(offset + 100)}>
              Next
            </button>
          )}
        </div>
      )}
    </nav>
  );
}
