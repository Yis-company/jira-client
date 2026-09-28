import type { PendingChange } from "../lib/edits";
import type { IssueSummary, WorkspaceKey } from "../lib/workspace";
import {
  StatusDragDrop,
  StatusDragRow,
  StatusDropTarget,
} from "./StatusDragDrop";

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
  accountKey: string;
  workspaceKey: WorkspaceKey;
  onOpen: (issue: IssueSummary, button: HTMLButtonElement) => void;
};

export function WorkspaceList({
  issues,
  columns,
  selectedId,
  changesByIssue,
  accountKey,
  workspaceKey,
  onOpen,
}: IssueViewProps) {
  const mappedIds = new Set(
    columns.flatMap((column) => column.issues.map((issue) => issue.id)),
  );
  const other = issues.filter((issue) => !mappedIds.has(issue.id));

  return (
    <StatusDragDrop
      accountKey={accountKey}
      workspaceKey={workspaceKey}
      columns={columns}
    >
      <div className="workspace-list">
        {columns.map((column) => (
          <StatusDropTarget column={column} key={column.name}>
            <section className="workspace-group">
              <h2 className="workspace-group-heading">
                <span
                  className={`workspace-status-dot ${column.issues[0]?.status.category ?? "indeterminate"}`}
                  aria-hidden="true"
                />
                <span>{column.name}</span>
                <span
                  className="workspace-page-count"
                  aria-label={`${column.issues.length} issues on this page`}
                >
                  {column.issues.length} on this page
                </span>
              </h2>
              <ul className="workspace-issue-list">
                {column.issues.map((issue) => (
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
          </StatusDropTarget>
        ))}
        {other.length > 0 && (
          <section className="workspace-group">
            <h2 className="workspace-group-heading">
              <span
                className="workspace-status-dot indeterminate"
                aria-hidden="true"
              />
              <span>Other statuses</span>
              <span
                className="workspace-page-count"
                aria-label={`${other.length} issues on this page`}
              >
                {other.length} on this page
              </span>
            </h2>
            <ul className="workspace-issue-list">
              {other.map((issue) => (
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
        )}
      </div>
    </StatusDragDrop>
  );
}

export function WorkspaceBoard({
  issues,
  columns,
  selectedId,
  changesByIssue,
  accountKey,
  workspaceKey,
  onOpen,
}: IssueViewProps) {
  const mappedIds = new Set(
    columns.flatMap((column) => column.issues.map((issue) => issue.id)),
  );
  const other = issues.filter((issue) => !mappedIds.has(issue.id));

  return (
    <StatusDragDrop
      accountKey={accountKey}
      workspaceKey={workspaceKey}
      columns={columns}
    >
      <div className="workspace-board-scroll">
        <div className="workspace-board" aria-label="Issues grouped by status">
          {columns.map((column) => (
            <StatusDropTarget column={column} key={column.name}>
              <section className="workspace-column">
                <h2 className="workspace-column-heading">
                  <span
                    className={`workspace-status-dot ${column.issues[0]?.status.category ?? "indeterminate"}`}
                    aria-hidden="true"
                  />
                  <span>{column.name}</span>
                  <span
                    className="workspace-page-count"
                    aria-label={`${column.issues.length} issues on this page`}
                  >
                    {column.issues.length}
                  </span>
                </h2>
                <ul className="workspace-issue-list">
                  {column.issues.map((issue) => (
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
            </StatusDropTarget>
          ))}
          {other.length > 0 && (
            <section className="workspace-column">
              <h2 className="workspace-column-heading">
                <span
                  className="workspace-status-dot indeterminate"
                  aria-hidden="true"
                />
                <span>Other statuses</span>
                <span
                  className="workspace-page-count"
                  aria-label={`${other.length} issues on this page`}
                >
                  {other.length}
                </span>
              </h2>
              <ul className="workspace-issue-list">
                {other.map((issue) => (
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
          )}
        </div>
      </div>
    </StatusDragDrop>
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
    <StatusDragRow
      issue={issue}
      pending={pending}
      className={`${board ? "workspace-board-card" : ""}${selected ? " selected" : ""}`}
    >
      <button
        type="button"
        className="workspace-row-open"
        data-issue-id={issue.id}
        aria-pressed={selected}
        onClick={(event) => onOpen(issue, event.currentTarget)}
      >
        <span className="workspace-row-status-cell">
          <span
            className={`workspace-row-status ${issue.status.category}`}
            aria-label={`Status: ${issue.status.name}`}
          />
          <span className="workspace-row-status-label">
            {issue.status.name}
          </span>
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
    </StatusDragRow>
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
