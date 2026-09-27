import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { IssueSummary, WorkspaceKey } from "./workspace";

export type ChangeField = "status" | "assignee";
export type ChangeState = "queued" | "sending" | "confirming" | "blocked" | "conflict" | "unknown";
export type FieldValue = { id: string | null; label: string };
export type PendingChange = WorkspaceKey & {
  id: number;
  issueId: string;
  issueKey: string;
  summary: string;
  field: ChangeField;
  state: ChangeState;
  base: FieldValue;
  requested: FieldValue;
  remote: FieldValue | null;
  error: string | null;
  attempted: boolean;
  canRetry: boolean;
  createdAt: string;
};
export type IssueCapabilities = {
  sourceStatusId: string;
  transitionsCapturedAt: string | null;
  assigneesCapturedAt: string | null;
  transitions: {
    id: string;
    name: string;
    target: IssueSummary["status"];
    supported: boolean;
    reason: string | null;
  }[];
  assignees: NonNullable<IssueSummary["assignee"]>[];
  canAssign: boolean;
  assigneeQuery: string;
  assigneesComplete: boolean;
};
export type ChangeRequest =
  | { field: "status"; transitionId: string }
  | { field: "assignee"; accountId: string };
export type ChangeResolution = "discard" | "keepMine" | "recheck" | "retry";
export type WorkspaceChangeEvent = {
  owner: { siteUrl: string; email: string };
  revision: number;
  issueId: string | null;
};

export const edits = {
  list: (): Promise<PendingChange[]> => invoke("list_changes"),
  capabilities: (key: WorkspaceKey, issueId: string, refresh = false, query = ""): Promise<IssueCapabilities> =>
    invoke("issue_capabilities", { ...key, issueId, refresh, query }),
  enqueue: (key: WorkspaceKey, issueId: string, change: ChangeRequest, ownerKey: string): Promise<PendingChange | null> =>
    invoke("enqueue_change", { ...key, issueId, change, expectedOwner: ownerKey.trim().toLowerCase() }),
  resolve: (id: number, action: ChangeResolution): Promise<void> => invoke("resolve_change", { id, action }),
  sync: (): Promise<void> => invoke("sync_changes"),
  subscribe: (onChange: (event: WorkspaceChangeEvent) => void) =>
    listen<WorkspaceChangeEvent>("workspace-changed", (event) => onChange(event.payload)),
};
