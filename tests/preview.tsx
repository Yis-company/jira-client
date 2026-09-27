import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../src/App";
import {
  type CachedWorkspace,
  type IssueDetail,
  type IssueFilter,
  type IssueSummary,
  workspace,
} from "../src/lib/workspace";
import { bridge } from "../src/lib/bridge";
import { edits, type PendingChange } from "../src/lib/edits";
import "../src/styles.css";
import "./preview.css";

const cache: CachedWorkspace = {
  projectKey: "CK",
  projectName: "CargoKing",
  boardId: 42,
  boardName: "Development",
  lastSyncedAt: new Date().toISOString(),
  columns: [
    { name: "To Do", statusIds: ["10000"] },
    { name: "In Progress", statusIds: ["3"] },
    { name: "In Review", statusIds: ["4"] },
    { name: "Done", statusIds: ["10001"] },
  ],
  sprints: [
    {
      id: 81,
      name: "Sprint 81",
      state: "active",
      goal: "Ship the offline workspace",
    },
    {
      id: 82,
      name: "Sprint 82",
      state: "future",
      startDate: "2026-10-05",
      endDate: "2026-10-16",
    },
    {
      id: 83,
      name: "Sprint 83",
      state: "future",
      startDate: "2026-10-19",
      endDate: "2026-10-30",
    },
    { id: 84, name: "Sprint 84", state: "future" },
  ],
  issueCount: 14,
  commentCount: 2,
};
const people = ["Yi", "Nadia", "Alex", "Sam"];
const items: IssueSummary[] = Array.from({ length: 14 }, (_, index) => ({
  id: String(index + 1),
  key: `CK-${2400 + index}`,
  summary: [
    "Add local issue cache",
    "Triage missing board issues",
    "Show active sprint points",
    "Refresh issue comments",
    "Improve the version picker",
    "Check custom field support",
    "Finish edge case coverage",
    "Preserve filters when switching views",
    "Read activity without leaving the workspace",
    "Handle long issue titles and multiple product versions without hiding useful context",
    "Review the next sprint backlog",
    "Show useful empty states",
    "Keep future sprint planning in one place",
    "Restore keyboard focus after closing an issue",
  ][index],
  status: [
    { id: "10000", name: "To Do", category: "todo" },
    { id: "3", name: "In Progress", category: "inprogress" },
    { id: "4", name: "In Review", category: "indeterminate" },
    { id: "10001", name: "Done", category: "done" },
  ][index % 4],
  assignee: {
    id: `user-${index % people.length}`,
    displayName: people[index % people.length],
  },
  issueType: index === 5 ? "Bug" : "Task",
  priority: index % 2 ? "High" : "Medium",
  storyPoints: [2, 3, 5, 7, 11, 3, 5][index % 7],
  versions: index === 4 ? ["ck-admin-4.44.0", "ck-admin-4.45.0"] : [],
  sprintIds:
    index < 5 || index === 7 || index === 8
      ? [81]
      : index === 6 || index === 10
        ? [82]
        : index === 12 || index === 13
          ? [83]
          : [],
  epic: index < 3 ? "CK-EPIC-42" : null,
  updated: new Date(Date.now() - index * 3600_000).toISOString(),
  offBoard: index === 5,
}));
const textDoc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
const details = new Map<string, IssueDetail>(
  items.map((issue) => [
    issue.id,
    {
      issue,
      description: textDoc(
        "This is synthetic preview content. No Jira request was made.",
      ),
      fields: {
        customfield_10001: "Review required",
        customfield_10002: { example: true, mode: "cached" },
      },
      fieldNames: {
        customfield_10001: "Acceptance notes",
        customfield_10002: "Example custom field",
      },
      comments: [
        {
          id: `comment-${issue.id}`,
          author: "Nadia",
          created: issue.updated,
          updated: issue.updated,
          body: textDoc("Checked against the offline cache fixture."),
        },
      ],
      attachments: [
        {
          id: `attachment-${issue.id}`,
          filename: "sprint-board.png",
          mimeType: "image/png",
          size: 242_000,
        },
      ],
    },
  ]),
);

workspace.list = async () => [
  {
    projectKey: cache.projectKey,
    projectName: cache.projectName,
    boardId: cache.boardId,
    boardName: cache.boardName,
    lastSyncedAt: cache.lastSyncedAt,
  },
];
workspace.read = async () => cache;
workspace.issues = async (filter: IssueFilter) => {
  let result = items;
  if (filter.view === "current") {
    result = result.filter((item) => item.sprintIds.includes(81));
  }
  if (filter.view === "backlog") {
    result = result.filter((item) => item.sprintIds.length === 0);
  }
  if (filter.view === "future") {
    result = result.filter((item) =>
      item.sprintIds.includes(filter.sprintId ?? 82),
    );
  }
  if (filter.search) {
    result = result.filter((item) =>
      `${item.key} ${item.summary}`
        .toLowerCase()
        .includes(filter.search.toLowerCase()),
    );
  }
  return {
    issues: result.slice(filter.offset, filter.offset + filter.limit),
    total: result.length,
  };
};
workspace.issue = async (_key, issueId) => details.get(issueId) ?? null;
workspace.sync = async () => ({
  ...cache,
  lastSyncedAt: new Date().toISOString(),
});

let changeSequence = 1;
let pendingChanges: PendingChange[] = [];
edits.list = async () => pendingChanges;
edits.capabilities = async (_key, issueId, _refresh, query) => {
  const issue = items.find((item) => item.id === issueId) ?? items[0];
  const nextStatus =
    issue.status.id === "10000"
      ? { id: "3", name: "In Progress", category: "inprogress" }
      : issue.status.id === "3"
        ? { id: "4", name: "In Review", category: "indeterminate" }
        : { id: "10001", name: "Done", category: "done" };
  return {
    sourceStatusId: issue.status.id,
    transitionsCapturedAt: cache.lastSyncedAt,
    assigneesCapturedAt: cache.lastSyncedAt,
    transitions: [
      {
        id: `transition-${issueId}`,
        name: `Move to ${nextStatus.name}`,
        target: nextStatus,
        supported: true,
        reason: null,
      },
    ],
    assignees: people
      .map((name, index) => ({ id: `preview-${index}`, displayName: name }))
      .filter(
        (person) =>
          !query ||
          person.displayName.toLowerCase().includes(query.toLowerCase()),
      ),
    canAssign: true,
    assigneeQuery: query,
    assigneesComplete: false,
  };
};
edits.enqueue = async (key, issueId, change) => {
  const item = items.find((issue) => issue.id === issueId)!;
  const base =
    change.field === "status"
      ? { id: item.status.id, label: item.status.name }
      : {
          id: item.assignee?.id ?? null,
          label: item.assignee?.displayName ?? "Unassigned",
        };
  const requested =
    change.field === "status"
      ? { id: "3", label: "In Progress" }
      : {
          id: change.accountId,
          label:
            people.find(
              (name, index) => `preview-${index}` === change.accountId,
            ) ?? "Preview teammate",
        };
  const pending: PendingChange = {
    ...key,
    id: changeSequence++,
    issueId,
    issueKey: item.key,
    summary: item.summary,
    field: change.field,
    state: "queued",
    base,
    requested,
    remote: null,
    error: null,
    attempted: false,
    createdAt: new Date().toISOString(),
    canRetry: false,
  };
  pendingChanges = [pending, ...pendingChanges];
  return pending;
};
edits.resolve = async (id, action) => {
  pendingChanges = pendingChanges.filter(
    (change) => change.id !== id || action === "keepMine",
  );
};
edits.sync = async () => undefined;
edits.subscribe = async () => () => undefined;

bridge.session = async () => ({
  siteUrl: "https://synthetic.invalid",
  email: "preview@example.invalid",
  accountName: "Preview User",
});
bridge.connect = async () => {
  throw new Error("Synthetic preview does not connect to Jira.");
};
bridge.disconnect = async () => undefined;
bridge.projects = async () => [
  { id: "preview-project", key: "CK", name: cache.projectName },
];
bridge.boards = async () => [
  { id: cache.boardId, name: cache.boardName, type: "scrum" },
];
bridge.boardConfig = async () => ({
  columns: cache.columns.map((column) => ({
    name: column.name,
    statuses: column.statusIds,
  })),
});
bridge.createMetadata = async () => [];

const client = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <>
        <div className="synthetic-banner">
          SYNTHETIC PREVIEW · Sample issues only · No Jira connection or
          credentials
        </div>
        <App />
      </>
    </QueryClientProvider>
  </StrictMode>,
);
