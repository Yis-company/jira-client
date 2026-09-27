import { invoke, isTauri } from "@tauri-apps/api/core";

export type WorkspaceKey = { projectKey: string; boardId: number };
export type WorkspaceRef = WorkspaceKey & {
  projectName: string;
  boardName: string;
  lastSyncedAt: string;
};
export type Sprint = {
  id: number;
  name: string;
  state: "active" | "future";
  startDate?: string | null;
  endDate?: string | null;
  goal?: string | null;
};
export type CachedWorkspace = WorkspaceRef & {
  columns: { name: string; statusIds: string[] }[];
  sprints: Sprint[];
  issueCount: number;
  commentCount: number;
};
export type IssueSummary = {
  id: string;
  key: string;
  summary: string;
  status: { id: string; name: string; category: string };
  assignee: { id: string; displayName: string } | null;
  issueType: string;
  priority: string | null;
  storyPoints: number | null;
  versions: string[];
  sprintIds: number[];
  epic: string | null;
  updated: string;
  offBoard: boolean;
};
export type IssueFilter = WorkspaceKey & {
  view: "current" | "backlog" | "future" | "all";
  sprintId?: number | null;
  search: string;
  offset: number;
  limit: number;
};
export type IssuePage = { issues: IssueSummary[]; total: number };
export type IssueDetail = {
  issue: IssueSummary;
  description: unknown;
  fields: Record<string, unknown>;
  fieldNames: Record<string, string>;
  comments: { id: string; author: string; created: string; updated: string; body: unknown }[];
  attachments: { id: string; filename: string; mimeType: string; size: number }[];
};

export const workspace = {
  list: (): Promise<WorkspaceRef[]> => isTauri() ? invoke("cache_workspaces") : Promise.resolve([]),
  read: (key: WorkspaceKey): Promise<CachedWorkspace | null> => invoke("cache_workspace", key),
  issues: (filter: IssueFilter): Promise<IssuePage> => invoke("cache_issues", { filter }),
  issue: (key: WorkspaceKey, issueId: string): Promise<IssueDetail | null> => invoke("cache_issue", { ...key, issueId }),
  sync: (key: WorkspaceKey): Promise<CachedWorkspace> => invoke("sync_workspace", key),
};
