import { Fragment, useEffect, useRef } from "react";
import { AlertCircle } from "lucide-react";
import type { IssueDetail, Sprint, WorkspaceKey } from "../lib/workspace";
import type { PendingChange } from "../lib/edits";
import { IssueEditors } from "./IssueEditors";

export function IssueDetailDialog({
  open,
  issue,
  loading,
  error,
  sprints,
  pendingChanges,
  accountKey,
  workspaceKey,
  onClose,
  onShowChanges,
}: {
  open: boolean;
  issue?: IssueDetail | null;
  loading: boolean;
  error: unknown;
  sprints: Sprint[];
  pendingChanges: PendingChange[];
  accountKey: string;
  workspaceKey: WorkspaceKey;
  onClose: () => void;
  onShowChanges?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      node.showModal();
      requestAnimationFrame(() => closeButton.current?.focus());
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  function handleClose() {
    if (open) onClose();
  }

  const statusChange = pendingChanges.find(
    (change) => change.field === "status",
  );
  const assigneeChange = pendingChanges.find(
    (change) => change.field === "assignee",
  );
  const showChanges = () => {
    dialog.current?.close();
    onShowChanges?.();
  };
  const sprintNames =
    issue?.issue.sprintIds.map(
      (id) =>
        sprints.find((sprint) => sprint.id === id)?.name ?? `Sprint ${id}`,
    ) ?? [];

  return (
    <dialog
      ref={dialog}
      className="workspace-dialog"
      aria-labelledby={issue ? "workspace-issue-title" : undefined}
      aria-label={issue ? undefined : "Issue details"}
      onClose={handleClose}
    >
      <header className="workspace-dialog-header">
        <div>
          <p className="workspace-dialog-kicker">
            {issue
              ? `${issue.issue.key} · ${issue.issue.issueType}`
              : "Issue details"}
          </p>
          <p className="workspace-dialog-freshness">
            {loading ? "Reading this device’s cache" : "Saved on this device"}
          </p>
        </div>
        <button
          ref={closeButton}
          type="button"
          className="workspace-dialog-close"
          aria-label="Close issue details"
          onClick={() => dialog.current?.close()}
        >
          <span aria-hidden="true">×</span>
          <span>Close</span>
        </button>
      </header>

      {loading ? (
        <p className="workspace-dialog-state">Loading saved issue…</p>
      ) : !issue && error ? (
        <div className="workspace-inline-error" role="alert">
          <AlertCircle size={15} />
          <span>{errorMessage(error)}</span>
        </div>
      ) : !issue ? (
        <p className="workspace-dialog-state">
          This issue has no saved details on this device.
        </p>
      ) : (
        <div className="workspace-dialog-layout">
          <div className="workspace-detail-main">
            <header className="workspace-detail-title">
              <h2 id="workspace-issue-title">{issue.issue.summary}</h2>
            </header>
            {Boolean(error) && (
              <div className="workspace-inline-error" role="status">
                <AlertCircle size={15} />
                <span>
                  Could not refresh issue details. Showing saved data:{" "}
                  {errorMessage(error)}
                </span>
              </div>
            )}
            <section className="workspace-detail-section">
              <h3>Description</h3>
              <Adf value={issue.description} />
            </section>
            <section className="workspace-detail-section">
              <h3>
                Comments <span>{issue.comments.length}</span>
              </h3>
              {issue.comments.length ? (
                [...issue.comments]
                  .sort((a, b) => a.created.localeCompare(b.created))
                  .map((comment) => (
                    <article className="workspace-comment" key={comment.id}>
                      <header>
                        <strong>{comment.author}</strong>
                        <time>{formatDate(comment.created)}</time>
                      </header>
                      <Adf value={comment.body} />
                    </article>
                  ))
              ) : (
                <p className="workspace-muted">No saved comments.</p>
              )}
            </section>
            <section className="workspace-detail-section">
              <h3>
                Attachments <span>Online only</span>
              </h3>
              {issue.attachments.length ? (
                <ul className="workspace-attachments">
                  {issue.attachments.map((file) => (
                    <li key={file.id}>
                      <span>{file.filename}</span>
                      <small>{formatSize(file.size)}</small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="workspace-muted">No attachment metadata saved.</p>
              )}
            </section>
          </div>

          <aside
            className="workspace-property-rail"
            aria-label="Issue properties"
          >
            <IssueEditors
              accountKey={accountKey}
              workspaceKey={workspaceKey}
              issue={issue}
              onShowChanges={showChanges}
            />
            <dl className="workspace-properties">
              <Property
                name="Issue type"
                value={issue.issue.issueType || "Not set"}
              />
              <Property
                name="Priority"
                value={issue.issue.priority ?? "Not set"}
              />
              <Property
                name="Story points"
                value={issue.issue.storyPoints?.toString() ?? "Not set"}
              />
              <Property
                name="Sprint"
                value={sprintNames.join(", ") || "Not set"}
              />
              <Property name="Epic" value={issue.issue.epic ?? "Not set"} />
              <Property
                name="Versions"
                value={issue.issue.versions.join(", ") || "Not set"}
              />
            </dl>
            {(statusChange || assigneeChange) && onShowChanges && (
              <button
                type="button"
                className="workspace-changes-link"
                onClick={showChanges}
              >
                Review pending change in Sync changes
              </button>
            )}
            {Object.keys(issue.fields).length > 0 && (
              <details className="workspace-additional-fields">
                <summary>Additional fields</summary>
                <div>
                  {Object.entries(issue.fields).map(([id, value]) => (
                    <details key={id}>
                      <summary>{issue.fieldNames[id] ?? id}</summary>
                      <pre>{safeValue(value)}</pre>
                    </details>
                  ))}
                </div>
              </details>
            )}
          </aside>
        </div>
      )}
    </dialog>
  );
}

function Property({ name, value }: { name: string; value: string }) {
  return (
    <div className="workspace-property">
      <dt>{name}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Adf({ value }: { value: unknown }) {
  const content = adfToNodes(value);
  return (
    <div className="workspace-adf">
      {content ?? <p className="workspace-muted">No description.</p>}
    </div>
  );
}

function adfToNodes(value: unknown): React.ReactNode {
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? <p>{value}</p> : null;
  }
  const node = value as {
    type?: string;
    text?: string;
    content?: unknown[];
    attrs?: Record<string, unknown>;
    marks?: { type?: string; attrs?: Record<string, unknown> }[];
  };
  if (node.type === "text") {
    let text: React.ReactNode = node.text ?? "";
    for (const mark of node.marks ?? []) {
      if (mark.type === "strong") text = <strong>{text}</strong>;
      else if (mark.type === "em") text = <em>{text}</em>;
      else if (mark.type === "code") text = <code>{text}</code>;
      else if (mark.type === "link") {
        const url = safeUrl(mark.attrs?.href);
        if (url)
          text = (
            <a href={url} target="_blank" rel="noreferrer">
              {text}
            </a>
          );
      }
    }
    return text;
  }
  const children = (node.content ?? []).map((child, index) => (
    <Fragment key={index}>{adfToNodes(child)}</Fragment>
  ));
  switch (node.type) {
    case "doc":
      return <>{children}</>;
    case "paragraph":
      return <p>{children}</p>;
    case "heading":
      return node.attrs?.level === 1 ? (
        <h3>{children}</h3>
      ) : node.attrs?.level === 2 ? (
        <h4>{children}</h4>
      ) : (
        <h5>{children}</h5>
      );
    case "bulletList":
      return (
        <ul>
          {(node.content ?? []).map((child, index) => (
            <li key={index}>{adfToNodes(child)}</li>
          ))}
        </ul>
      );
    case "orderedList":
      return (
        <ol>
          {(node.content ?? []).map((child, index) => (
            <li key={index}>{adfToNodes(child)}</li>
          ))}
        </ol>
      );
    case "listItem":
      return <>{children}</>;
    case "hardBreak":
      return <br />;
    case "blockquote":
      return <blockquote>{children}</blockquote>;
    case "codeBlock":
      return <pre>{children}</pre>;
    case "mention":
      return (
        <span>
          @{String(node.attrs?.text ?? node.attrs?.displayName ?? "user")}
        </span>
      );
    default:
      return children.length ? (
        <span>{children}</span>
      ) : (
        <code>{safeValue(value)}</code>
      );
  }
}

function safeUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function safeValue(value: unknown) {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

function formatSize(size: number) {
  return size < 1024 * 1024
    ? `${Math.round(size / 1024)} KB`
    : `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function errorMessage(error: unknown) {
  return typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : "Could not read the saved issue.";
}
