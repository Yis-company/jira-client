import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Search } from "lucide-react";
import { edits, type IssueCapabilities, type PendingChange } from "../lib/edits";
import type { IssueDetail, WorkspaceKey } from "../lib/workspace";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Alert, AlertDescription, AlertTitle } from "./reui/alert";
import { useIssueEditMutation } from "./useIssueEditMutation";

const capabilityRefreshes = new Map<string, Promise<IssueCapabilities>>();

function refreshCapabilities(
  key: WorkspaceKey,
  accountKey: string,
  issueId: string,
  query: string,
) {
  const refreshKey = JSON.stringify([
    accountKey,
    key.projectKey,
    key.boardId,
    issueId,
    query,
  ]);
  const active = capabilityRefreshes.get(refreshKey);
  if (active) return active;
  const request = edits.capabilities(key, issueId, true, query).finally(() => {
    if (capabilityRefreshes.get(refreshKey) === request) {
      capabilityRefreshes.delete(refreshKey);
    }
  });
  capabilityRefreshes.set(refreshKey, request);
  return request;
}

export function IssueEditors({
  accountKey,
  workspaceKey,
  issue,
  onShowChanges,
}: {
  accountKey: string;
  workspaceKey: WorkspaceKey;
  issue: IssueDetail;
  onShowChanges?: () => void;
}) {
  const client = useQueryClient();
  const [onlineHint, setOnlineHint] = useState(navigator.onLine);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [activeAssigneeIndex, setActiveAssigneeIndex] = useState(0);
  const assigneeSearchRef = useRef<HTMLInputElement>(null);
  const assigneeTriggerRef = useRef<HTMLButtonElement>(null);
  const [capabilityError, setCapabilityError] = useState("");
  const {
    save,
    cancel,
    saving,
    saveError,
    syncError,
    notice,
    clearNotice,
    clearSyncError,
  } = useIssueEditMutation({
    accountKey,
    workspaceKey,
    issueId: issue.issue.id,
  });
  const capabilitiesKey = useMemo(
    () => [
      "issue-capabilities",
      accountKey,
      workspaceKey.projectKey,
      workspaceKey.boardId,
      issue.issue.id,
      assigneeSearch.trim(),
    ],
    [
      accountKey,
      assigneeSearch,
      issue.issue.id,
      workspaceKey.boardId,
      workspaceKey.projectKey,
    ],
  );
  const capabilities = useQuery({
    queryKey: capabilitiesKey,
    queryFn: () =>
      edits.capabilities(
        workspaceKey,
        issue.issue.id,
        false,
        assigneeSearch.trim(),
      ),
    retry: false,
  });
  const changes = useQuery({
    queryKey: ["changes", accountKey],
    queryFn: edits.list,
    retry: false,
  });
  const issueChanges = useMemo(
    () =>
      changes.data?.filter((change) => change.issueId === issue.issue.id) ?? [],
    [changes.data, issue.issue.id],
  );
  const statusChange = issueChanges.find((change) => change.field === "status");
  const assigneeChange = issueChanges.find(
    (change) => change.field === "assignee",
  );
  const stateUnavailable = changes.isPending || changes.isError;
  const statusLocked =
    stateUnavailable ||
    (statusChange &&
      (statusChange.state !== "queued" || statusChange.attempted));
  const assigneeLocked =
    stateUnavailable ||
    (assigneeChange &&
      (assigneeChange.state !== "queued" || assigneeChange.attempted));
  useEffect(() => {
    setAssigneeOpen(false);
    setAssigneeSearch("");
    setActiveAssigneeIndex(0);
  }, [accountKey, issue.issue.id, workspaceKey.boardId, workspaceKey.projectKey]);

  useEffect(() => {
    if (assigneeOpen) assigneeSearchRef.current?.focus();
  }, [assigneeOpen]);
  const capabilitySourceId =
    statusChange?.state === "queued"
      ? statusChange.base.id
      : issue.issue.status.id;
  const sourceMatches =
    !!capabilities.data &&
    capabilities.data.sourceStatusId === capabilitySourceId;

  useEffect(() => {
    if (!stateUnavailable && issueChanges.length === 0) clearSyncError();
  }, [clearSyncError, issueChanges.length, stateUnavailable]);

  useEffect(() => {
    const online = () => setOnlineHint(true);
    const offline = () => setOnlineHint(false);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);

  useEffect(() => {
    if (!onlineHint) return;
    const search = assigneeSearch.trim();
    const timer = window.setTimeout(
      () => {
        setCapabilityError("");
        void refreshCapabilities(
          workspaceKey,
          accountKey,
          issue.issue.id,
          search,
        )
          .then((result) => client.setQueryData(capabilitiesKey, result))
          .catch((cause) => setCapabilityError(errorMessage(cause)));
      },
      search ? 350 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [
    accountKey,
    assigneeSearch,
    capabilitiesKey,
    capabilitySourceId,
    client,
    issue.issue.id,
    onlineHint,
    workspaceKey,
  ]);

  const data = capabilities.data;
  const transitions = data?.transitions ?? [];
  const assignees = data?.assignees ?? [];
  const unsupported = transitions.filter((transition) => !transition.supported);
  const assigneeChoices = [
    ...(data?.canUnassign ? [{ id: "", displayName: "Unassigned" }] : []),
    ...assignees,
  ];

  function chooseAssignee(accountId: string | null) {
    setAssigneeOpen(false);
    setAssigneeSearch("");
    setActiveAssigneeIndex(0);
    clearNotice();
    void save({ field: "assignee", accountId });
  }

  function handleAssigneeKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setAssigneeOpen(false);
      setAssigneeSearch("");
      assigneeTriggerRef.current?.focus();
    } else if (event.key === "ArrowDown" && assigneeChoices.length) {
      event.preventDefault();
      setActiveAssigneeIndex((index) =>
        Math.min(index + 1, assigneeChoices.length - 1),
      );
    } else if (event.key === "ArrowUp" && assigneeChoices.length) {
      event.preventDefault();
      setActiveAssigneeIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && assigneeChoices[activeAssigneeIndex]) {
      event.preventDefault();
      chooseAssignee(assigneeChoices[activeAssigneeIndex].id || null);
    }
  }

  return (
    <section className="issue-editors" aria-label="Issue actions">
      <details className="editor-section">
        <summary className="editor-property-summary">
          <span className="editor-property-name">Status</span>
          <strong>{issue.issue.status.name || "Not set"}</strong>
          {statusChange && (
            <span className="editor-pending-value">
              {statusChange.requested.label} · {statusChange.state}
            </span>
          )}
          <span className="editor-property-action">Change</span>
        </summary>
        <div className="editor-control-panel">
          {statusLocked ? (
            statusChange ? (
              <LockedMessage
                change={statusChange}
                onShowChanges={onShowChanges}
              />
            ) : (
              <p className="editor-locked">
                {changes.isError
                  ? "Pending edit state is unavailable. Try again before changing status."
                  : "Checking pending edits…"}
              </p>
            )
          ) : (
            <>
              <label className="editor-label">
                Available Jira transitions
                <select
                  aria-label="Available Jira transitions"
                  value=""
                  disabled={
                    !data ||
                    !sourceMatches ||
                    transitions.every((transition) => !transition.supported) ||
                    saving === "status"
                  }
                  onChange={(event) => {
                    if (event.target.value) {
                      void save({
                        field: "status",
                        transitionId: event.target.value,
                      });
                    }
                  }}
                >
                  <option value="">
                    {!data
                      ? "Connect once to load options"
                      : !sourceMatches
                        ? "Refresh options for this status"
                        : transitions.length === 0
                          ? "No Jira transitions available"
                          : "Choose a transition"}
                  </option>
                  {transitions.map((transition) => (
                    <option
                      key={transition.id}
                      value={transition.id}
                      disabled={!transition.supported}
                    >
                      {transition.name} · {transition.target.name}
                      {transition.supported ? "" : " · unavailable"}
                    </option>
                  ))}
                </select>
              </label>
              {unsupported.length > 0 && (
                <ul className="unsupported-options">
                  {unsupported.map((transition) => (
                    <li key={transition.id}>
                      <strong>{transition.name} unavailable:</strong>{" "}
                      {transition.reason ?? "Jira requires additional fields."}
                    </li>
                  ))}
                </ul>
              )}
              {!data && (
                <p className="editor-hint">
                  Connect once to load issue-specific transitions.
                </p>
              )}
              {data && !sourceMatches && (
                <p className="editor-hint">
                  These cached transitions start from a different status.
                  Refresh while connected before editing.
                </p>
              )}
              {data?.transitionsCapturedAt && (
                <CapabilityStamp
                  capturedAt={data.transitionsCapturedAt}
                  online={onlineHint}
                />
              )}
            </>
          )}
          {statusChange?.state === "queued" && !statusChange.attempted && (
            <Button
              variant="secondary"
              className="secondary-button"
              onClick={() => void cancel(statusChange)}
              disabled={saving === "status"}
            >
              Keep current Jira status
            </Button>
          )}
        </div>
      </details>

      <section className="issue-property-editor" aria-label="Assignee">
        <span className="editor-property-name">Assignee</span>
        <div className="issue-assignee-anchor">
          <button
            ref={assigneeTriggerRef}
            type="button"
            className="issue-assignee-value"
            aria-haspopup="listbox"
            aria-expanded={assigneeOpen}
            aria-controls={`assignee-options-${issue.issue.id}`}
            disabled={assigneeLocked || saving === "assignee"}
            onClick={() => {
              setAssigneeOpen((open) => !open);
              setAssigneeSearch("");
              setActiveAssigneeIndex(0);
            }}
          >
            <span>{issue.issue.assignee?.displayName ?? "Unassigned"}</span>
            <span aria-hidden="true">⌄</span>
          </button>
          {assigneeChange && (
            <span className="editor-pending-value">
              {assigneeChange.requested.label} · {assigneeChange.state}
            </span>
          )}
          {assigneeLocked && (
            assigneeChange ? (
              <LockedMessage change={assigneeChange} onShowChanges={onShowChanges} />
            ) : (
              <p className="editor-locked">
                {changes.isError
                  ? "Pending edit state is unavailable. Try again before changing the assignee."
                  : "Checking pending edits…"}
              </p>
            )
          )}
          {assigneeOpen && !assigneeLocked && (
            <div className="issue-assignee-picker">
              <label className="assignee-search">
                <Search size={14} aria-hidden="true" />
                <Input
                  ref={assigneeSearchRef}
                  role="combobox"
                  aria-expanded="true"
                  aria-controls={`assignee-options-${issue.issue.id}`}
                  aria-autocomplete="list"
              aria-activedescendant={
                assigneeChoices[activeAssigneeIndex]
                  ? `assignee-option-${issue.issue.id}-${activeAssigneeIndex}`
                  : undefined
              }
                  value={assigneeSearch}
                  onChange={(event) => {
                    setAssigneeSearch(event.target.value);
                    setActiveAssigneeIndex(0);
                  }}
                  onKeyDown={handleAssigneeKeyDown}
                  placeholder="Search teammates"
                  aria-label="Search assignable teammates"
                />
              </label>
              <p className="issue-assignee-status" role="status">
                {capabilities.isPending || capabilities.isFetching
                  ? "Searching Jira…"
                  : !onlineHint
                    ? assignees.length || data?.canUnassign
                      ? "Offline · showing saved options"
                      : "Offline · connect to search Jira"
                  : capabilityError || capabilities.isError
                    ? "Could not check Jira assignment permission"
                    : data?.canAssign || data?.canUnassign
                      ? assignees.length || (data.canUnassign && !assigneeSearch)
                        ? "Choose a teammate"
                        : assigneeSearch
                          ? "No matches"
                          : "No assignable teammates"
                      : "Jira does not allow assignment for this issue"}
              </p>
              <div
                id={`assignee-options-${issue.issue.id}`}
                role="listbox"
                aria-label="Assignable teammates"
              >
                {assigneeChoices.map((person, index) => (
                  <button
                    key={person.id || "unassigned"}
                    id={`assignee-option-${issue.issue.id}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeAssigneeIndex}
                    className="issue-assignee-option"
                    onMouseEnter={() => setActiveAssigneeIndex(index)}
                    onClick={() => chooseAssignee(person.id || null)}
                  >
                    {person.displayName}
                  </button>
                ))}
              </div>
              {data?.assigneesCapturedAt && (
                <CapabilityStamp capturedAt={data.assigneesCapturedAt} online={onlineHint} />
              )}
              {assigneeChange?.state === "queued" && !assigneeChange.attempted && (
                <Button
                  variant="secondary"
                  className="secondary-button"
                  onClick={() => void cancel(assigneeChange)}
                  disabled={saving === "assignee"}
                >
                  Keep current Jira assignee
                </Button>
              )}
            </div>
          )}
        </div>
      </section>

      {capabilityError && (
        <Alert variant="warning">
          <AlertCircle size={14} />
          <div>
            <AlertTitle>Could not refresh options</AlertTitle>
            <AlertDescription>
              {capabilityError} Cached options remain available.
            </AlertDescription>
          </div>
        </Alert>
      )}
      {stateUnavailable && (
        <Alert variant={changes.isError ? "destructive" : "info"}>
          <AlertCircle size={14} />
          <div>
            <AlertTitle>
              {changes.isError
                ? "Could not check pending edits"
                : "Checking pending edits…"}
            </AlertTitle>
            <AlertDescription>
              {changes.isError
                ? errorMessage(changes.error)
                : "Wait for the local change list before editing this issue."}
            </AlertDescription>
          </div>
        </Alert>
      )}
      {syncError && (
        <Alert variant="warning">
          <AlertCircle size={14} />
          <div>
            <AlertTitle>Saved locally · sync did not start</AlertTitle>
            <AlertDescription>{syncError}</AlertDescription>
          </div>
        </Alert>
      )}
      {saveError && (
        <Alert variant="destructive">
          <AlertCircle size={14} />
          <div>
            <AlertTitle>Change was not saved locally</AlertTitle>
            <AlertDescription>{saveError}</AlertDescription>
          </div>
        </Alert>
      )}
      {notice && (
        <p className="edit-saved" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}

function LockedMessage({
  change,
  onShowChanges,
}: {
  change: PendingChange;
  onShowChanges?: () => void;
}) {
  return (
    <div className="editor-locked">
      <p>
        This field is{" "}
        {change.state === "unknown" ? "outcome unknown" : change.state}.
        {` Requested: ${change.requested.label}.`}
      </p>
      {onShowChanges && (
        <button type="button" onClick={onShowChanges}>
          Review in Sync changes
        </button>
      )}
    </div>
  );
}

function CapabilityStamp({
  capturedAt,
  online,
}: {
  capturedAt: string;
  online: boolean;
}) {
  return (
    <p className="editor-hint">
      Cached options · captured {formatDate(capturedAt)} ·{" "}
      {online ? "checked again when saving" : "checked when syncing"}
    </p>
  );
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

function errorMessage(cause: unknown) {
  return typeof cause === "string"
    ? cause
    : cause instanceof Error
      ? cause.message
      : "Could not complete that action.";
}
