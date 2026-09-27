import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, RefreshCw, RotateCcw } from "lucide-react";
import { type ChangeResolution, edits, type PendingChange } from "../lib/edits";
import type { WorkspaceKey } from "../lib/workspace";
import { requestEditSync } from "../lib/editSync";
import { Button } from "./ui/button";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./reui/alert";

export function SyncChanges({
  accountKey,
  openIssue,
  workerError,
}: {
  accountKey: string;
  openIssue: (key: WorkspaceKey, issueId: string) => void;
  workerError?: string;
}) {
  const client = useQueryClient();
  const changes = useQuery({
    queryKey: ["changes", accountKey],
    queryFn: edits.list,
    retry: false,
  });
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function resolve(change: PendingChange, action: ChangeResolution) {
    setBusyId(change.id);
    setError("");
    try {
      await edits.resolve(change.id, action);
      await client.invalidateQueries({ queryKey: ["changes", accountKey] });
      await Promise.all([
        client.invalidateQueries({ queryKey: ["cached-issues", accountKey] }),
        client.invalidateQueries({ queryKey: ["cached-issue", accountKey] }),
      ]);
      if (action !== "discard") {
        await requestEditSync(accountKey);
        await client.invalidateQueries({ queryKey: ["changes", accountKey] });
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="changes-page" aria-label="Sync changes">
      <div className="changes-heading">
        <div>
          <div className="eyebrow">LOCAL CHANGES</div>
          <h1>Sync changes</h1>
          <p>Review edits waiting for Jira or needing your attention.</p>
        </div>
        <Button
          variant="secondary"
          className="secondary-button"
          onClick={() =>
            void client.invalidateQueries({
              queryKey: ["changes", accountKey],
            })}
          disabled={changes.isFetching}
        >
          <RefreshCw
            size={14}
            className={changes.isFetching ? "spin-icon" : ""}
          />
          Refresh list
        </Button>
      </div>
      {workerError && (
        <Alert variant="warning">
          <AlertCircle size={15} />
          <div>
            <AlertTitle>Sync is waiting</AlertTitle>
            <AlertDescription>{workerError}</AlertDescription>
          </div>
        </Alert>
      )}
      {(error || changes.isError) && (
        <Alert variant="destructive">
          <AlertCircle size={15} />
          <div>
            <AlertTitle>Could not load sync changes</AlertTitle>
            <AlertDescription>
              {error || errorMessage(changes.error)}
            </AlertDescription>
          </div>
          <AlertAction>
            <button
              onClick={() => {
                setError("");
                void changes.refetch();
              }}
            >
              Retry
            </button>
          </AlertAction>
        </Alert>
      )}
      {changes.isPending
        ? <div className="workspace-empty">Loading saved changes…</div>
        : changes.data?.length
        ? (
          <div className="change-list">
            {changes.data.map((change) => (
              <ChangeCard
                key={change.id}
                change={change}
                busy={busyId === change.id}
                onOpen={() =>
                  openIssue({
                    projectKey: change.projectKey,
                    boardId: change.boardId,
                  }, change.issueId)}
                onResolve={(action) => void resolve(change, action)}
              />
            ))}
          </div>
        )
        : !changes.isError && (
          <div className="workspace-empty">
            <strong>No pending changes</strong>
            <span>
              Local edits that need attention will stay listed here, even after
              an issue leaves the board.
            </span>
          </div>
        )}
    </section>
  );
}

function ChangeCard({
  change,
  busy,
  onOpen,
  onResolve,
}: {
  change: PendingChange;
  busy: boolean;
  onOpen: () => void;
  onResolve: (action: ChangeResolution) => void;
}) {
  return (
    <article className={`change-card state-${change.state}`}>
      <div className="change-card-main">
        <div className="change-card-title">
          <button className="change-issue-link" onClick={onOpen}>
            {change.issueKey} · {change.summary}
          </button>
          <span className={`change-state state-${change.state}`}>
            {stateName(change.state)}
          </span>
        </div>
        <p className="change-context">
          {change.projectKey} · board {change.boardId} ·{" "}
          {change.field === "status" ? "Status" : "Assignee"}
        </p>
        <div className="change-values">
          <Value label="Before" value={change.base.label} />
          <Value label="Requested" value={change.requested.label} />
          {change.remote && (
            <Value label="Jira now" value={change.remote.label} />
          )}
        </div>
        {change.state === "conflict" && (
          <>
            <p className="change-warning">
              “Use Jira” keeps the latest saved Jira value shown here.
            </p>
            {change.attempted && (
              <p className="change-warning">
                The earlier change may already have run. Keep mine requests another validated edit.
              </p>
            )}
          </>
        )}
        {change.error && (
          <p className="change-error">
            <AlertCircle size={13} />
            {change.error}
          </p>
        )}
        {change.state === "blocked" && !change.canRetry && (
          <p className="change-warning">
            Jira accepted this change, but its result could not be confirmed. Do not resend it.
          </p>
        )}
        {change.state === "unknown" && (
          <>
            <p className="change-warning">
              The previous request may have run. Check Jira before starting another edit.
            </p>
            {!change.remote && <p className="change-error">Accept current Jira value becomes available after a check returns a current value.</p>}
          </>
        )}
      </div>
      <div className="change-actions">
        {actions(change).map(({ label, action, disabled, icon }) => (
          <Button
            key={action}
            variant="secondary"
            className="secondary-button"
            disabled={busy || disabled}
            onClick={() => onResolve(action)}
          >
            {icon === "refresh"
              ? <RefreshCw size={13} />
              : icon === "retry"
              ? <RotateCcw size={13} />
              : null}
            {busy ? "Working…" : label}
          </Button>
        ))}
      </div>
    </article>
  );
}

function Value({ label, value }: { label: string; value: string }) {
  return (
    <div className="change-value">
      <small>{label}</small>
      <span>{value || "—"}</span>
    </div>
  );
}

type RecoveryAction = {
  label: string;
  action: ChangeResolution;
  icon?: "refresh" | "retry";
  disabled?: boolean;
};

function actions(change: PendingChange): RecoveryAction[] {
  switch (change.state) {
    case "queued":
      return [{ label: "Cancel queued change", action: "discard" as const }];
    case "confirming":
      return [{
        label: "Check again",
        action: "recheck" as const,
        icon: "refresh" as const,
      }];
    case "blocked":
      return [
        ...(change.canRetry
          ? [{
            label: "Retry after fixing",
            action: "retry" as const,
            icon: "retry" as const,
          }]
          : [{
            label: "Check again",
            action: "recheck" as const,
            icon: "refresh" as const,
          }]),
        { label: "Discard local change", action: "discard" as const },
      ];
    case "conflict":
      return [
        { label: "Keep mine", action: "keepMine" as const },
        { label: "Use Jira", action: "discard" as const },
      ];
    case "unknown":
      return [
        {
          label: "Check again",
          action: "recheck" as const,
          icon: "refresh" as const,
        },
        {
          label: "Accept current Jira value",
          action: "discard" as const,
          disabled: change.remote === null,
        },
      ];
    case "sending":
      return [];
  }
}

function stateName(state: PendingChange["state"]) {
  return state === "unknown"
    ? "Outcome unknown"
    : state === "confirming"
    ? "Confirming with Jira"
    : state[0].toUpperCase() + state.slice(1);
}

function errorMessage(cause: unknown) {
  return typeof cause === "string"
    ? cause
    : cause instanceof Error
    ? cause.message
    : "Could not complete that action.";
}
