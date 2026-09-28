import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { edits } from "../lib/edits";
import {
  adfToEditorDocument,
  editorDocumentToAdf,
  type JsonRecord,
} from "../lib/adfEditor";
import type { IssueDetail, Sprint, WorkspaceKey } from "../lib/workspace";
import type { PendingChange } from "../lib/edits";
import { IssueEditors } from "./IssueEditors";
import { RichDescriptionEditor } from "./RichDescriptionEditor";
import { useIssueEditMutation } from "./useIssueEditMutation";
import { Button } from "./ui/button";
import "./issue-editing.css";

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
  const [summaryEditing, setSummaryEditing] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [summaryBaseDraft, setSummaryBaseDraft] = useState("");
  const [summarySavedValue, setSummarySavedValue] = useState<string | null>(null);
  const [descriptionEditing, setDescriptionEditing] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState<JsonRecord | null>(null);
  const [descriptionBaseDraft, setDescriptionBaseDraft] = useState<JsonRecord | null>(null);
  const [descriptionAdapterError, setDescriptionAdapterError] = useState("");
  const [descriptionSavedValue, setDescriptionSavedValue] = useState<unknown>(null);
  const [descriptionHasSavedValue, setDescriptionHasSavedValue] = useState(false);
  const [closeGuardOpen, setCloseGuardOpen] = useState(false);
  const titleInput = useRef<HTMLTextAreaElement>(null);
  const capabilitiesKey = useMemo(
    () => [
      "issue-capabilities",
      accountKey,
      workspaceKey.projectKey,
      workspaceKey.boardId,
      issue?.issue.id ?? "",
      "",
    ],
    [accountKey, issue?.issue.id, workspaceKey.boardId, workspaceKey.projectKey],
  );
  const capabilities = useQuery({
    queryKey: capabilitiesKey,
    queryFn: () => edits.capabilities(workspaceKey, issue!.issue.id, false, ""),
    enabled: !!issue,
    retry: false,
  });
  const mutation = useIssueEditMutation({
    accountKey,
    workspaceKey,
    issueId: issue?.issue.id ?? "",
  });

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

  useEffect(() => {
    if (!summaryEditing && issue) {
      const current = summarySavedValue ?? issue.issue.summary;
      setSummaryDraft(current);
      setSummaryBaseDraft(current);
    }
  }, [issue?.issue.id, issue?.issue.summary, summaryEditing, summarySavedValue]);

  useEffect(() => {
    if (summarySavedValue !== null && issue?.issue.summary === summarySavedValue) {
      setSummarySavedValue(null);
    }
  }, [issue?.issue.summary, summarySavedValue]);

  useEffect(() => {
    if (
      descriptionSavedValue !== null &&
      issue &&
      sameJson(issue.description, descriptionSavedValue)
    ) {
      setDescriptionSavedValue(null);
      setDescriptionHasSavedValue(false);
    }
  }, [descriptionSavedValue, issue?.description]);

  useEffect(() => {
    if (summaryEditing) titleInput.current?.focus();
  }, [summaryEditing]);

  const descriptionValue = descriptionHasSavedValue ? descriptionSavedValue : issue?.description;
  const descriptionConversion = useMemo(
    () => adfToEditorDocument(descriptionValue),
    [descriptionValue],
  );
  const dirtyDraft =
    (summaryEditing && summaryDraft !== summaryBaseDraft) ||
    (descriptionEditing &&
      !!issue &&
      descriptionDraft !== null &&
      !sameJson(descriptionDraft, descriptionBaseDraft));

  function attemptClose() {
    if (dirtyDraft) {
      setCloseGuardOpen(true);
      return;
    }
    dialog.current?.close();
  }

  function discardDraftsAndClose() {
    setSummaryEditing(false);
    setDescriptionEditing(false);
    setSummaryDraft(issue ? summarySavedValue ?? issue.issue.summary : "");
    setSummaryBaseDraft(issue ? summarySavedValue ?? issue.issue.summary : "");
    setDescriptionDraft(null);
    setDescriptionBaseDraft(null);
    setCloseGuardOpen(false);
    dialog.current?.close();
  }

  function handleClose() {
    if (open) onClose();
  }

  async function saveSummary() {
    if (
      !issue ||
      !summaryDraft.trim() ||
      summaryLocked ||
      !capabilities.data?.canEditSummary
    ) {
      return;
    }
    const saved = await mutation.save({ field: "summary", summary: summaryDraft });
    if (saved !== undefined) {
      setSummarySavedValue(summaryDraft);
      setSummaryEditing(false);
    }
  }

  async function saveDescription() {
    if (
      !issue ||
      !descriptionDraft ||
      descriptionLocked ||
      !capabilities.data?.canEditDescription
    ) {
      return;
    }
    let value: JsonRecord;
    try {
      value = editorDocumentToAdf(descriptionDraft);
    } catch (cause) {
      setDescriptionAdapterError(errorMessage(cause));
      return;
    }
    setDescriptionAdapterError("");
    const saved = await mutation.save({ field: "description", description: value });
    if (saved !== undefined) {
      setDescriptionSavedValue(value);
      setDescriptionHasSavedValue(true);
      setDescriptionEditing(false);
    }
  }

  const statusChange = pendingChanges.find(
    (change) => change.field === "status",
  );
  const assigneeChange = pendingChanges.find(
    (change) => change.field === "assignee",
  );
  const summaryChange = pendingChanges.find((change) => change.field === "summary");
  const descriptionChange = pendingChanges.find((change) => change.field === "description");
  const summaryLocked =
    !!summaryChange &&
    (summaryChange.state !== "queued" || summaryChange.attempted);
  const descriptionLocked =
    !!descriptionChange &&
    (descriptionChange.state !== "queued" || descriptionChange.attempted);
  const showChanges = () => {
    if (dirtyDraft) {
      setCloseGuardOpen(true);
      return;
    }
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
      onCancel={(event) => {
        event.preventDefault();
        attemptClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) attemptClose();
      }}
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
          onClick={attemptClose}
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
              {summaryEditing ? (
                <div className="issue-title-editor">
                  <h2 id="workspace-issue-title" className="sr-only">
                    {summaryDraft || issue.issue.key}
                  </h2>
                  <label htmlFor="workspace-summary-draft">Title</label>
                  <textarea
                    id="workspace-summary-draft"
                    ref={titleInput}
                    value={summaryDraft}
                    maxLength={255}
                    onChange={(event) => setSummaryDraft(event.target.value)}
                  />
                  <div className="issue-edit-actions">
                    <Button
                      onClick={() => void saveSummary()}
                      disabled={
                        !summaryDraft.trim() ||
                        summaryLocked ||
                        !capabilities.data?.canEditSummary ||
                        mutation.saving === "summary"
                      }
                    >
                      {mutation.saving === "summary" ? "Saving…" : "Save title"}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        const current = summarySavedValue ?? issue.issue.summary;
                        setSummaryDraft(current);
                        setSummaryBaseDraft(current);
                        setSummaryEditing(false);
                      }}
                    >
                      Cancel
                    </Button>
                    {mutation.saveError && (
                      <p className="issue-edit-error" role="alert">
                        {mutation.saveError}
                      </p>
                    )}
                    {summaryLocked && (
                      <p className="editor-locked" role="status">
                        Title edit is {summaryChange?.state}.{" "}
                        {onShowChanges && (
                          <button type="button" onClick={showChanges}>
                            Review pending change
                          </button>
                        )}
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <h2 id="workspace-issue-title">
                    {summarySavedValue ?? issue.issue.summary}
                  </h2>
                  {capabilities.data?.canEditSummary &&
                    (summaryLocked ? (
                      <p className="editor-locked" role="status">
                        Title edit is {summaryChange?.state}.{" "}
                        {onShowChanges && (
                          <button type="button" onClick={showChanges}>
                            Review pending change
                          </button>
                        )}
                      </p>
                    ) : (
                      <button
                        type="button"
                        className="workspace-changes-link"
                        onClick={() => {
                          const current = summarySavedValue ?? issue.issue.summary;
                          setSummaryDraft(current);
                          setSummaryBaseDraft(current);
                          setSummaryEditing(true);
                        }}
                      >
                        Edit title
                      </button>
                    ))}
                </>
              )}
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
            {mutation.notice && (
              <p className="issue-edit-confirmation" role="status">
                {mutation.notice}
              </p>
            )}
            {mutation.syncError && (
              <p className="issue-edit-error" role="status">
                Saved on this device; sync could not start: {mutation.syncError}
              </p>
            )}
            <section className="workspace-detail-section">
              <header className="issue-description-heading">
                <h3>Description</h3>
                {!descriptionEditing && capabilities.data?.canEditDescription && (
                  descriptionLocked ? (
                    <span className="editor-locked" role="status">
                      Description edit is {descriptionChange?.state}.
                      {onShowChanges && (
                        <button type="button" onClick={showChanges}>
                          Review
                        </button>
                      )}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="workspace-changes-link"
                      onClick={() => {
                        if (descriptionConversion.safe) {
                          setDescriptionDraft(descriptionConversion.document);
                          setDescriptionBaseDraft(descriptionConversion.document);
                          setDescriptionAdapterError("");
                          setDescriptionEditing(true);
                        }
                      }}
                      disabled={!descriptionConversion.safe}
                    >
                      Edit description
                    </button>
                  )
                )}
              </header>
              {descriptionEditing && descriptionDraft ? (
                <>
                  <RichDescriptionEditor
                    initialDocument={descriptionDraft}
                    onChange={setDescriptionDraft}
                  />
                  <div className="issue-edit-actions">
                    <Button
                      onClick={() => void saveDescription()}
                      disabled={
                        descriptionLocked ||
                        !capabilities.data?.canEditDescription ||
                        mutation.saving === "description"
                      }
                    >
                      {mutation.saving === "description" ? "Saving…" : "Save description"}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setDescriptionDraft(null);
                        setDescriptionBaseDraft(null);
                        setDescriptionEditing(false);
                      }}
                    >
                      Cancel
                    </Button>
                    {mutation.saveError && (
                      <p className="issue-edit-error" role="alert">
                        {mutation.saveError}
                      </p>
                    )}
                    {descriptionAdapterError && (
                      <p className="issue-edit-error" role="alert">
                        {descriptionAdapterError}
                      </p>
                    )}
                    {descriptionLocked && (
                      <p className="editor-locked" role="status">
                        Description edit is {descriptionChange?.state}.{" "}
                        {onShowChanges && (
                          <button type="button" onClick={showChanges}>
                            Review pending change
                          </button>
                        )}
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <Adf value={descriptionValue} />
              )}
              {!descriptionConversion.safe && capabilities.data?.canEditDescription && (
                <p className="editor-hint">
                  {descriptionConversion.reason} The description remains readable and untouched.
                  {issueBrowseUrl(accountKey, issue.issue.key) && (
                    <>
                      {" "}
                      <a
                        href={issueBrowseUrl(accountKey, issue.issue.key)!}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open in Jira
                      </a>
                    </>
                  )}
                </p>
              )}
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
      {closeGuardOpen && (
        <div
          className="issue-edit-guard"
          role="alertdialog"
          aria-labelledby="issue-edit-guard-title"
          aria-describedby="issue-edit-guard-copy"
        >
          <div>
            <strong id="issue-edit-guard-title">Keep your unsaved edits?</strong>
            <p id="issue-edit-guard-copy">
              Your title or description draft has not been saved.
            </p>
          </div>
          <div className="issue-edit-actions">
            <Button variant="secondary" onClick={() => setCloseGuardOpen(false)}>
              Keep editing
            </Button>
            <Button variant="secondary" onClick={discardDraftsAndClose}>
              Discard and close
            </Button>
          </div>
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
    case "rule":
      return <hr />;
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

function issueBrowseUrl(accountKey: string, issueKey: string) {
  const separator = accountKey.lastIndexOf(":");
  if (separator <= 0) return null;
  try {
    const site = new URL(accountKey.slice(0, separator));
    if (site.protocol !== "https:" && site.protocol !== "http:") return null;
    site.pathname = `${site.pathname.replace(/\/$/, "")}/browse/${encodeURIComponent(issueKey)}`;
    site.search = "";
    site.hash = "";
    return site.href;
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

function sameJson(left: unknown, right: unknown) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function errorMessage(error: unknown) {
  return typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : "Could not read the saved issue.";
}
