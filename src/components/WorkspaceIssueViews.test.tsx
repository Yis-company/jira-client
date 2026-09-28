import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  edits,
  type IssueCapabilities,
  type PendingChange,
} from "../lib/edits";
import type { IssueSummary } from "../lib/workspace";
import {
  WorkspaceBoard,
  WorkspaceList,
  type StatusColumn,
} from "./WorkspaceIssueViews";

const editApi = vi.hoisted(() => ({
  list: vi.fn(),
  capabilities: vi.fn(),
  enqueue: vi.fn(),
  resolve: vi.fn(),
  sync: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("../lib/edits", () => ({ edits: editApi }));

Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
  configurable: true,
  value(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  },
});
Object.defineProperty(HTMLDialogElement.prototype, "close", {
  configurable: true,
  value(this: HTMLDialogElement) {
    if (!this.open) return;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  },
});

const workspaceKey = { projectKey: "CK", boardId: 42 };
const accountKey = "https://jira.test:yi@example.com";
const issue: IssueSummary = {
  id: "100",
  key: "CK-100",
  summary: "Move this issue",
  status: { id: "1", name: "To Do", category: "todo" },
  assignee: null,
  issueType: "Task",
  priority: null,
  storyPoints: 3,
  versions: [],
  sprintIds: [3],
  epic: null,
  updated: "2026-09-27T09:00:00Z",
  offBoard: false,
};
const columns: StatusColumn[] = [
  { name: "To Do", statusIds: ["1"], issues: [issue] },
  { name: "In Progress", statusIds: ["3"], issues: [] },
];
const capabilities: IssueCapabilities = {
  sourceStatusId: "1",
  transitionsCapturedAt: "2026-09-27T09:00:00Z",
  assigneesCapturedAt: null,
  transitions: [
    {
      id: "start",
      name: "Start work",
      target: { id: "3", name: "In Progress", category: "inprogress" },
      supported: true,
      reason: null,
    },
  ],
  assignees: [],
  canAssign: false,
  assigneeQuery: "",
  assigneesComplete: false,
};

function pending(
  state: PendingChange["state"],
  overrides: Partial<PendingChange> = {},
): PendingChange {
  return {
    ...workspaceKey,
    id: 8,
    issueId: issue.id,
    issueKey: issue.key,
    summary: issue.summary,
    field: "status",
    state,
    base: { id: "1", label: "To Do" },
    requested: { id: "3", label: "In Progress" },
    remote: null,
    error: null,
    attempted: false,
    canRetry: false,
    createdAt: "2026-09-27T09:00:00Z",
    ...overrides,
  };
}

function mount(
  View: typeof WorkspaceList | typeof WorkspaceBoard = WorkspaceList,
  changes = new Map<string, PendingChange[]>(),
  open = vi.fn(),
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <View
        issues={[issue]}
        columns={columns}
        selectedId={null}
        changesByIssue={changes}
        accountKey={accountKey}
        workspaceKey={workspaceKey}
        onOpen={open}
      />
    </QueryClientProvider>,
  );
  return { ...view, open, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
  vi.mocked(edits.capabilities).mockResolvedValue(capabilities);
  vi.mocked(edits.enqueue).mockResolvedValue(pending("queued"));
  vi.mocked(edits.sync).mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe("status movement in issue views", () => {
  it("keeps empty list groups, separates opening from moving, and enqueues one supported transition", async () => {
    const { open } = mount();
    expect(
      screen.getByRole("heading", {
        name: /In Progress.*0 issues on this page/,
      }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Move this issue/ }));
    expect(open).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Move status for CK-100" }),
    );
    expect(open).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "In Progress" }));

    await waitFor(() =>
      expect(edits.enqueue).toHaveBeenCalledWith(
        workspaceKey,
        issue.id,
        { field: "status", transitionId: "start" },
        accountKey,
      ),
    );
    expect(edits.capabilities).toHaveBeenCalledTimes(1);
    expect(edits.capabilities).toHaveBeenCalledWith(
      workspaceKey,
      issue.id,
      true,
    );
    await waitFor(() => expect(edits.sync).toHaveBeenCalledTimes(1));
  });

  it("requires a choice when multiple supported Jira transitions reach the target group", async () => {
    vi.mocked(edits.capabilities).mockResolvedValue({
      ...capabilities,
      transitions: [
        ...capabilities.transitions,
        {
          id: "start-alt",
          name: "Start with review",
          target: capabilities.transitions[0].target,
          supported: true,
          reason: null,
        },
      ],
    });
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Move status for CK-100" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "In Progress" }));
    expect(
      await screen.findByRole("button", { name: "Start work · In Progress" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start with review · In Progress" }),
    ).toBeInTheDocument();
    expect(edits.enqueue).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Start with review · In Progress" }),
    );
    await waitFor(() =>
      expect(edits.enqueue).toHaveBeenCalledWith(
        workspaceKey,
        issue.id,
        { field: "status", transitionId: "start-alt" },
        accountKey,
      ),
    );
  });

  it("uses issue transitions already cached for the active account and workspace", async () => {
    const { client } = mount();
    client.setQueryData(
      [
        "issue-capabilities",
        accountKey,
        workspaceKey.projectKey,
        workspaceKey.boardId,
        issue.id,
        "",
      ],
      capabilities,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Move status for CK-100" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "In Progress" }));
    await waitFor(() =>
      expect(edits.enqueue).toHaveBeenCalledWith(
        workspaceKey,
        issue.id,
        { field: "status", transitionId: "start" },
        accountKey,
      ),
    );
    expect(edits.capabilities).not.toHaveBeenCalled();
  });

  it("explains unsupported status moves and never enqueues them", async () => {
    vi.mocked(edits.capabilities).mockResolvedValue({
      ...capabilities,
      transitions: [
        {
          ...capabilities.transitions[0],
          supported: false,
          reason: "Jira requires a resolution field.",
        },
      ],
    });
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Move status for CK-100" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "In Progress" }));
    expect(
      await screen.findByText("Jira requires a resolution field."),
    ).toBeInTheDocument();
    expect(edits.enqueue).not.toHaveBeenCalled();
  });

  it("keeps an enqueue failure actionable and clears it after a successful retry", async () => {
    vi.mocked(edits.enqueue)
      .mockRejectedValueOnce(new Error("SQLite is locked"))
      .mockResolvedValueOnce(pending("queued"));
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Move status for CK-100" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "In Progress" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "SQLite is locked",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(edits.enqueue).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("retries a failed post-enqueue sync without enqueuing the status twice", async () => {
    vi.mocked(edits.sync)
      .mockRejectedValueOnce(new Error("Temporary sync failure"))
      .mockResolvedValueOnce(undefined);
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Move status for CK-100" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "In Progress" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Temporary sync failure",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(edits.sync).toHaveBeenCalledTimes(2));
    expect(edits.enqueue).toHaveBeenCalledTimes(1);
  });

  it("locks a status row while its previous move needs attention", () => {
    mount(WorkspaceList, new Map([[issue.id, [pending("blocked")]]]));
    expect(
      screen.getByRole("button", { name: "Drag CK-100 to change status" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Move status for CK-100" }),
    ).toBeDisabled();
  });

  it("retains an empty Kanban column as a status drop target", () => {
    mount(WorkspaceBoard);
    const heading = screen.getByRole("heading", {
      name: /In Progress.*0 issues on this page/,
    });
    expect(heading).toBeInTheDocument();
    expect(
      within(heading.parentElement!).getByRole("list"),
    ).toBeEmptyDOMElement();
  });
});
