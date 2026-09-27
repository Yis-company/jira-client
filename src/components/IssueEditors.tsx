import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Search } from "lucide-react";
import {
  type ChangeRequest,
  edits,
  type IssueCapabilities,
  type PendingChange,
} from "../lib/edits";
import type { IssueDetail, WorkspaceKey } from "../lib/workspace";
import { requestEditSync } from "../lib/editSync";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Alert, AlertDescription, AlertTitle } from "./reui/alert";

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
  const [capabilityError, setCapabilityError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState<"status" | "assignee" | null>(null);
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
  const capabilitySourceId =
    statusChange?.state === "queued"
      ? statusChange.base.id
      : issue.issue.status.id;
  const sourceMatches =
    !!capabilities.data &&
    capabilities.data.sourceStatusId === capabilitySourceId;

  useEffect(() => {
    if (!stateUnavailable && issueChanges.length === 0) setSyncError("");
  }, [issueChanges.length, stateUnavailable]);

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

  async function save(change: ChangeRequest) {
    const field = change.field;
    setSaving(field);
    setSaveError("");
    setSyncError("");
    setNotice("");
    try {
      const queued = await edits.enqueue(
        workspaceKey,
        issue.issue.id,
        change,
        accountKey,
      );
      setNotice(queued ? "Saved locally" : "Queued change cancelled");
      await Promise.all([
        client.invalidateQueries({ queryKey: ["cached-issues", accountKey] }),
        client.invalidateQueries({ queryKey: ["cached-issue", accountKey] }),
        client.invalidateQueries({ queryKey: ["changes", accountKey] }),
      ]);
      void requestEditSync(accountKey).catch((cause) =>
        setSyncError(errorMessage(cause)),
      );
    } catch (cause) {
      setSaveError(errorMessage(cause));
    } finally {
      setSaving(null);
    }
  }

  async function cancelQueued(change: PendingChange) {
    setSaving(change.field);
    setSaveError("");
    try {
      await edits.resolve(change.id, "discard");
      setNotice("Queued change cancelled");
      await Promise.all([
        client.invalidateQueries({ queryKey: ["cached-issues", accountKey] }),
        client.invalidateQueries({ queryKey: ["cached-issue", accountKey] }),
        client.invalidateQueries({ queryKey: ["changes", accountKey] }),
      ]);
    } catch (cause) {
      setSaveError(errorMessage(cause));
    } finally {
      setSaving(null);
    }
  }

  const data = capabilities.data;
  const transitions = data?.transitions ?? [];
  const assignees = data?.assignees ?? [];
  const unsupported = transitions.filter((transition) => !transition.supported);

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
              onClick={() => void cancelQueued(statusChange)}
              disabled={saving === "status"}
            >
              Keep current Jira status
            </Button>
          )}
        </div>
      </details>

      <details className="editor-section">
        <summary className="editor-property-summary">
          <span className="editor-property-name">Assignee</span>
          <strong>{issue.issue.assignee?.displayName ?? "Unassigned"}</strong>
          {assigneeChange && (
            <span className="editor-pending-value">
              {assigneeChange.requested.label} · {assigneeChange.state}
            </span>
          )}
          <span className="editor-property-action">Change</span>
        </summary>
        <div className="editor-control-panel">
          {assigneeLocked ? (
            assigneeChange ? (
              <LockedMessage
                change={assigneeChange}
                onShowChanges={onShowChanges}
              />
            ) : (
              <p className="editor-locked">
                {changes.isError
                  ? "Pending edit state is unavailable. Try again before changing the assignee."
                  : "Checking pending edits…"}
              </p>
            )
          ) : (
            <>
              <label className="assignee-search">
                <Search size={14} />
                <Input
                  value={assigneeSearch}
                  onChange={(event) => setAssigneeSearch(event.target.value)}
                  placeholder="Search assignable teammates"
                  aria-label="Search assignable teammates"
                />
              </label>
              <label className="editor-label">
                Assign to
                <select
                  aria-label="Assign to"
                  value=""
                  disabled={
                    !data?.canAssign ||
                    (!onlineHint && !assignees.length) ||
                    saving === "assignee"
                  }
                  onChange={(event) => {
                    if (event.target.value) {
                      void save({
                        field: "assignee",
                        accountId: event.target.value,
                      });
                    }
                  }}
                >
                  <option value="">
                    {!data?.canAssign
                      ? "Connect once to load options"
                      : assignees.length
                        ? "Choose a teammate"
                        : "No cached matches"}
                  </option>
                  {assignees.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <p className="editor-hint">
                Search results may be incomplete. Unassigning is not available
                here.
              </p>
              {data?.assigneesCapturedAt && (
                <CapabilityStamp
                  capturedAt={data.assigneesCapturedAt}
                  online={onlineHint}
                />
              )}
              {!data?.canAssign && (
                <p className="editor-hint">
                  Connect once to load assignable teammates for this issue.
                </p>
              )}
              {data?.canAssign && !assignees.length && !onlineHint && (
                <p className="editor-hint">
                  No cached matches for this search. Connect to search Jira.
                </p>
              )}
            </>
          )}
          {assigneeChange?.state === "queued" && !assigneeChange.attempted && (
            <Button
              variant="secondary"
              className="secondary-button"
              onClick={() => void cancelQueued(assigneeChange)}
              disabled={saving === "assignee"}
            >
              Keep current Jira assignee
            </Button>
          )}
        </div>
      </details>

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
