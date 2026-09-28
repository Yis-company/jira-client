import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DragDropProvider,
  DragOverlay,
  useDraggable,
  useDroppable,
} from "@dnd-kit/react";
import {
  KeyboardSensor,
  PointerActivationConstraints,
  PointerSensor,
} from "@dnd-kit/dom";
import { useQueryClient } from "@tanstack/react-query";
import { GripVertical, MoreHorizontal } from "lucide-react";
import {
  edits,
  type IssueCapabilities,
  type PendingChange,
} from "../lib/edits";
import type { IssueSummary, WorkspaceKey } from "../lib/workspace";
import { requestEditSync } from "../lib/editSync";
import type { StatusColumn } from "./WorkspaceIssueViews";
import "./status-drag-drop.css";

type StatusMoveContext = {
  openTargets: (issue: IssueSummary, pending?: PendingChange) => void;
};

const StatusMoveContext = createContext<StatusMoveContext | null>(null);

type StatusDragDropProps = {
  accountKey: string;
  workspaceKey: WorkspaceKey;
  columns: StatusColumn[];
  children: ReactNode;
};

type MoveDialogState =
  | { kind: "targets"; issue: IssueSummary; pending?: PendingChange }
  | {
      kind: "transitions";
      issue: IssueSummary;
      column: StatusColumn;
      transitions: IssueCapabilities["transitions"];
    }
  | {
      kind: "message";
      title: string;
      message: string;
      issue?: IssueSummary;
      column?: StatusColumn;
      transitionId?: string;
      retry?: "target" | "enqueue" | "sync";
      error?: boolean;
    }
  | null;

function capabilityKey(accountKey: string, key: WorkspaceKey, issueId: string) {
  return [
    "issue-capabilities",
    accountKey,
    key.projectKey,
    key.boardId,
    issueId,
    "",
  ] as const;
}

export function StatusDragDrop({
  accountKey,
  workspaceKey,
  columns,
  children,
}: StatusDragDropProps) {
  const client = useQueryClient();
  const [dialog, setDialog] = useState<MoveDialogState>(null);
  const [busy, setBusy] = useState(false);

  const moveTo = useCallback(
    async (
      issue: IssueSummary,
      column: StatusColumn,
      pending?: PendingChange,
    ) => {
      if (column.statusIds.includes(issue.status.id)) return;
      if (
        pending &&
        (pending.field !== "status" ||
          pending.state !== "queued" ||
          pending.attempted)
      ) {
        setDialog({
          kind: "message",
          title: "Status change needs attention",
          message:
            "Resolve the existing status change before moving this issue again.",
        });
        return;
      }
      setBusy(true);
      setDialog(null);
      try {
        const expectedSource = pending?.base.id ?? issue.status.id;
        const queryKey = capabilityKey(accountKey, workspaceKey, issue.id);
        const cached = client.getQueryData<IssueCapabilities>(queryKey);
        const capabilities =
          cached?.sourceStatusId === expectedSource &&
          cached.transitionsCapturedAt
            ? cached
            : await edits.capabilities(
                workspaceKey,
                issue.id,
                navigator.onLine,
              );
        client.setQueryData(queryKey, capabilities);
        if (capabilities.sourceStatusId !== expectedSource) {
          setDialog({
            kind: "message",
            title: "Status changed",
            message:
              "The available Jira transitions do not match the issue's confirmed base status. Refresh the issue and try again.",
          });
          return;
        }
        const matches = capabilities.transitions.filter(
          (transition) =>
            transition.supported &&
            column.statusIds.includes(transition.target.id),
        );
        if (matches.length === 0) {
          const unsupported = capabilities.transitions.find((transition) =>
            column.statusIds.includes(transition.target.id),
          );
          setDialog({
            kind: "message",
            title: "Status cannot be moved",
            message:
              unsupported?.reason ??
              `Jira has no supported transition from ${issue.status.name} to ${column.name}.`,
          });
          return;
        }
        if (matches.length > 1) {
          setDialog({
            kind: "transitions",
            issue,
            column,
            transitions: matches,
          });
          return;
        }
        await enqueue(issue, matches[0].id, column);
      } catch (cause) {
        setDialog({
          kind: "message",
          title: "Status was not saved",
          message: errorMessage(cause),
          issue,
          column,
          retry: "target",
          error: true,
        });
      } finally {
        setBusy(false);
      }
    },
    [accountKey, client, workspaceKey],
  );

  const enqueue = useCallback(
    async (issue: IssueSummary, transitionId: string, column: StatusColumn) => {
      setBusy(true);
      setDialog(null);
      try {
        const queued = await edits.enqueue(
          workspaceKey,
          issue.id,
          { field: "status", transitionId },
          accountKey,
        );
        if (!queued) {
          setDialog({
            kind: "message",
            title: "Queued status change canceled",
            message: "The existing local status change was canceled.",
          });
          return;
        }
        await Promise.all([
          client.invalidateQueries({ queryKey: ["cached-issues", accountKey] }),
          client.invalidateQueries({ queryKey: ["cached-issue", accountKey] }),
          client.invalidateQueries({ queryKey: ["cached-daily", accountKey] }),
          client.invalidateQueries({ queryKey: ["changes", accountKey] }),
        ]);
        void requestEditSync(accountKey).catch((cause) => {
          setDialog({
            kind: "message",
            title: "Saved locally; sync needs attention",
            message: errorMessage(cause),
            issue,
            column,
            transitionId,
            retry: "sync",
            error: true,
          });
        });
      } catch (cause) {
        setDialog({
          kind: "message",
          title: "Status was not saved",
          message: errorMessage(cause),
          issue,
          column,
          transitionId,
          retry: "enqueue",
          error: true,
        });
      } finally {
        setBusy(false);
      }
    },
    [accountKey, client, workspaceKey],
  );

  const openTargets = useCallback(
    (issue: IssueSummary, pending?: PendingChange) => {
      if (
        pending &&
        (pending.field !== "status" ||
          pending.state !== "queued" ||
          pending.attempted)
      ) {
        setDialog({
          kind: "message",
          title: "Status change needs attention",
          message:
            "Resolve the existing status change before moving this issue again.",
        });
        return;
      }
      setDialog({ kind: "targets", issue, pending });
    },
    [],
  );

  const retrySync = useCallback(
    async (issue: IssueSummary, column: StatusColumn, transitionId: string) => {
      setBusy(true);
      setDialog(null);
      try {
        await requestEditSync(accountKey);
      } catch (cause) {
        setDialog({
          kind: "message",
          title: "Saved locally; sync needs attention",
          message: errorMessage(cause),
          issue,
          column,
          transitionId,
          retry: "sync",
          error: true,
        });
      } finally {
        setBusy(false);
      }
    },
    [accountKey],
  );
  const context = useMemo(() => ({ openTargets }), [openTargets]);
  function onDragEnd(event: {
    canceled: boolean;
    operation: {
      source: { data: Record<string, unknown> } | null;
      target: { data: Record<string, unknown> } | null;
    };
  }) {
    if (event.canceled || !event.operation.source || !event.operation.target)
      return;
    const issue = event.operation.source.data.issue as IssueSummary | undefined;
    const pending = event.operation.source.data.pending as
      | PendingChange
      | undefined;
    const column = event.operation.target.data.column as
      | StatusColumn
      | undefined;
    if (issue && column) void moveTo(issue, column, pending);
  }

  return (
    <StatusMoveContext.Provider value={context}>
      <DragDropProvider
        sensors={(defaults) => [
          ...defaults.filter(
            (sensor) => sensor !== PointerSensor && sensor !== KeyboardSensor,
          ),
          PointerSensor.configure({
            activationConstraints: [
              new PointerActivationConstraints.Distance({ value: 6 }),
              new PointerActivationConstraints.Delay({
                value: 250,
                tolerance: 6,
              }),
            ],
          }),
          KeyboardSensor.configure({ offset: { x: 300, y: 40 } }),
        ]}
        onDragEnd={onDragEnd}
      >
        {children}
        <DragOverlay className="workspace-drag-overlay" dropAnimation={null}>
          {(source) => {
            const issue = source.data.issue as IssueSummary | undefined;
            return issue ? (
              <span>
                {issue.key} · {issue.summary}
              </span>
            ) : null;
          }}
        </DragOverlay>
      </DragDropProvider>
      <MoveStatusDialog
        dialog={dialog}
        columns={columns}
        busy={busy}
        onClose={() => setDialog(null)}
        onChooseTarget={(issue, column, pending) =>
          void moveTo(issue, column, pending)
        }
        onChooseTransition={(issue, column, transitionId) =>
          void enqueue(issue, transitionId, column)
        }
        onRetrySync={(issue, column, transitionId) =>
          void retrySync(issue, column, transitionId)
        }
      />
    </StatusMoveContext.Provider>
  );
}

export function StatusDropTarget({
  column,
  children,
}: {
  column: StatusColumn;
  children: ReactNode;
}) {
  const id = `status-target-${column.statusIds.join("-")}`;
  const { ref, isDropTarget } = useDroppable({
    id,
    data: { column },
    disabled: column.statusIds.length === 0,
  });
  return (
    <section
      ref={ref}
      className={`workspace-status-drop-target${isDropTarget ? " is-drop-target" : ""}`}
    >
      {children}
    </section>
  );
}

export function StatusDragRow({
  issue,
  pending,
  className = "",
  children,
}: {
  issue: IssueSummary;
  pending: PendingChange[];
  className?: string;
  children: ReactNode;
}) {
  const context = useContext(StatusMoveContext);
  if (!context)
    return <div className={`workspace-row ${className}`}>{children}</div>;
  return (
    <DraggableIssueRow
      issue={issue}
      pending={pending}
      className={className}
      onOpenTargets={context.openTargets}
    >
      {children}
    </DraggableIssueRow>
  );
}

function DraggableIssueRow({
  issue,
  pending,
  className,
  children,
  onOpenTargets,
}: {
  issue: IssueSummary;
  pending: PendingChange[];
  className: string;
  children: ReactNode;
  onOpenTargets: (issue: IssueSummary, pending?: PendingChange) => void;
}) {
  const statusPending = pending.find((change) => change.field === "status");
  const locked =
    !!statusPending &&
    (statusPending.state !== "queued" || statusPending.attempted);
  const startId = `${issue.id}-${issue.status.id}`;
  const { ref, handleRef, isDragging } = useDraggable({
    id: `issue-${startId}`,
    data: { issue, pending: statusPending },
    disabled: locked,
  });
  return (
    <div
      ref={ref}
      className={`workspace-row ${className}${isDragging ? " is-dragging" : ""}`}
    >
      <button
        type="button"
        ref={handleRef}
        className="workspace-drag-handle"
        aria-label={`Drag ${issue.key} to change status`}
        title="Drag to change status; press Space to pick up"
        disabled={locked}
      >
        <GripVertical size={15} aria-hidden="true" />
      </button>
      {children}
      <button
        type="button"
        className="workspace-row-move-menu"
        aria-label={`Move status for ${issue.key}`}
        title="Move status"
        disabled={locked}
        onClick={() => onOpenTargets(issue, statusPending)}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

function MoveStatusDialog({
  dialog,
  columns,
  busy,
  onClose,
  onChooseTarget,
  onChooseTransition,
  onRetrySync,
}: {
  dialog: MoveDialogState;
  columns: StatusColumn[];
  busy: boolean;
  onClose: () => void;
  onChooseTarget: (
    issue: IssueSummary,
    column: StatusColumn,
    pending?: PendingChange,
  ) => void;
  onChooseTransition: (
    issue: IssueSummary,
    column: StatusColumn,
    transitionId: string,
  ) => void;
  onRetrySync: (
    issue: IssueSummary,
    column: StatusColumn,
    transitionId: string,
  ) => void;
}) {
  if (!dialog) return null;
  return (
    <MoveDialogContents
      dialog={dialog}
      columns={columns}
      busy={busy}
      onClose={onClose}
      onChooseTarget={onChooseTarget}
      onChooseTransition={onChooseTransition}
      onRetrySync={onRetrySync}
    />
  );
}

function MoveDialogContents({
  dialog,
  columns,
  busy,
  onClose,
  onChooseTarget,
  onChooseTransition,
  onRetrySync,
}: {
  dialog: NonNullable<MoveDialogState>;
  columns: StatusColumn[];
  busy: boolean;
  onClose: () => void;
  onChooseTarget: (
    issue: IssueSummary,
    column: StatusColumn,
    pending?: PendingChange,
  ) => void;
  onChooseTransition: (
    issue: IssueSummary,
    column: StatusColumn,
    transitionId: string,
  ) => void;
  onRetrySync: (
    issue: IssueSummary,
    column: StatusColumn,
    transitionId: string,
  ) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialogRef.current;
    if (!node || node.open) return;
    node.showModal();
    node.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => {
      if (node.open) node.close();
    };
  }, []);
  function close() {
    dialogRef.current?.close();
  }
  return (
    <dialog
      ref={dialogRef}
      className="workspace-move-dialog"
      aria-labelledby="workspace-move-title"
      onClose={onClose}
    >
      <h2 id="workspace-move-title">
        {dialog.kind === "targets"
          ? `Move ${dialog.issue.key} to status`
          : dialog.kind === "transitions"
            ? `Choose a Jira transition`
            : dialog.title}
      </h2>
      {dialog.kind === "targets" && (
        <div className="workspace-move-options">
          {columns.map((column) => (
            <button
              type="button"
              key={column.statusIds.join("-") || column.name}
              disabled={
                busy ||
                !column.statusIds.length ||
                column.statusIds.includes(dialog.issue.status.id)
              }
              onClick={() =>
                onChooseTarget(dialog.issue, column, dialog.pending)
              }
            >
              {column.name}
            </button>
          ))}
        </div>
      )}
      {dialog.kind === "transitions" && (
        <div className="workspace-move-options">
          {dialog.transitions.map((transition) => (
            <button
              type="button"
              key={transition.id}
              disabled={busy}
              onClick={() =>
                onChooseTransition(dialog.issue, dialog.column, transition.id)
              }
            >
              {transition.name} · {transition.target.name}
            </button>
          ))}
        </div>
      )}
      {dialog.kind === "message" && (
        <p role={dialog.error ? "alert" : "status"}>{dialog.message}</p>
      )}
      {dialog.kind === "message" &&
        dialog.error &&
        dialog.issue &&
        dialog.column && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              dialog.retry === "sync" && dialog.transitionId
                ? onRetrySync(
                    dialog.issue!,
                    dialog.column!,
                    dialog.transitionId,
                  )
                : dialog.retry === "enqueue" && dialog.transitionId
                  ? onChooseTransition(
                      dialog.issue!,
                      dialog.column!,
                      dialog.transitionId,
                    )
                  : onChooseTarget(dialog.issue!, dialog.column!)
            }
          >
            Try again
          </button>
        )}
      <button type="button" className="workspace-move-close" onClick={close}>
        Close
      </button>
    </dialog>
  );
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
