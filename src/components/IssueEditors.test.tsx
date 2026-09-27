import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IssueEditors } from "./IssueEditors";
import {
  edits,
  type IssueCapabilities,
  type PendingChange,
} from "../lib/edits";
import type { IssueDetail } from "../lib/workspace";

const editApi = vi.hoisted(() => ({
  list: vi.fn(),
  capabilities: vi.fn(),
  enqueue: vi.fn(),
  resolve: vi.fn(),
  sync: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("../lib/edits", () => ({ edits: editApi }));

const key = { projectKey: "CK", boardId: 42 };
const accountKey = "https://jira.test:yi@example.com";
const issue: IssueDetail = {
  issue: {
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
  },
  description: null,
  fields: { status: { id: "1", name: "To Do" }, assignee: null },
  fieldNames: { status: "Status", assignee: "Assignee" },
  comments: [],
  attachments: [],
};
const capabilities: IssueCapabilities = {
  sourceStatusId: "1",
  transitionsCapturedAt: "2026-09-27T09:00:00Z",
  assigneesCapturedAt: "2026-09-27T09:00:00Z",
  transitions: [
    {
      id: "start",
      name: "Start work",
      target: { id: "3", name: "In Progress", category: "inprogress" },
      supported: true,
      reason: null,
    },
  ],
  assignees: [{ id: "user-1", displayName: "Nadia" }],
  canAssign: true,
  assigneeQuery: "",
  assigneesComplete: false,
};

function pending(
  field: PendingChange["field"],
  state: PendingChange["state"],
  overrides: Partial<PendingChange> = {},
): PendingChange {
  return {
    ...key,
    id: 7,
    issueId: "100",
    issueKey: "CK-100",
    summary: issue.issue.summary,
    field,
    state,
    base: { id: "1", label: "To Do" },
    requested: { id: "3", label: "In Progress" },
    remote: null,
    error: null,
    attempted: false,
    createdAt: "2026-09-27T09:00:00Z",
    canRetry: state === "blocked",
    ...overrides,
  };
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <IssueEditors accountKey={accountKey} workspaceKey={key} issue={issue} />
    </QueryClientProvider>,
  );
  return { view, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
  vi.mocked(edits.list).mockResolvedValue([]);
  vi.mocked(edits.capabilities).mockResolvedValue(capabilities);
  vi.mocked(edits.enqueue).mockResolvedValue(pending("status", "queued"));
  vi.mocked(edits.resolve).mockResolvedValue(undefined);
  vi.mocked(edits.sync).mockResolvedValue(undefined);
  vi.mocked(edits.subscribe).mockResolvedValue(() => undefined);
});
afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
});

describe("issue status and assignee editors", () => {
  it("reads cached capabilities first, then refreshes the open issue online", async () => {
    mount();
    expect(
      await screen.findByRole("combobox", {
        name: "Available Jira transitions",
      }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(edits.capabilities).toHaveBeenCalledWith(key, "100", true, ""),
    );
    expect(edits.capabilities).toHaveBeenCalledWith(key, "100", false, "");
    expect(screen.getAllByText(/Cached options/).length).toBeGreaterThan(0);
  });

  it("refreshes transitions when the confirmed Jira status changes in the open drawer", async () => {
    const nextCapabilities: IssueCapabilities = {
      ...capabilities,
      sourceStatusId: "3",
      transitions: [
        {
          id: "finish",
          name: "Finish work",
          target: { id: "10001", name: "Done", category: "done" },
          supported: true,
          reason: null,
        },
      ],
    };
    let refreshCount = 0;
    vi.mocked(edits.capabilities).mockImplementation(
      async (_key, _id, refresh) => {
        if (!refresh) return capabilities;
        refreshCount += 1;
        return refreshCount === 1 ? capabilities : nextCapabilities;
      },
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <IssueEditors
          accountKey={accountKey}
          workspaceKey={key}
          issue={issue}
        />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole("option", { name: /Start work/ }),
    ).toBeInTheDocument();
    await waitFor(() => expect(refreshCount).toBe(1));

    view.rerender(
      <QueryClientProvider client={client}>
        <IssueEditors
          accountKey={accountKey}
          workspaceKey={key}
          issue={{
            ...issue,
            issue: {
              ...issue.issue,
              status: { id: "3", name: "In Progress", category: "inprogress" },
            },
          }}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(refreshCount).toBe(2));
    expect(
      await screen.findByRole("option", { name: /Finish work/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Available Jira transitions" }),
    ).toBeEnabled();
  });

  it("keeps offline controls disabled until this issue has saved options", async () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    vi.mocked(edits.capabilities).mockResolvedValue({
      ...capabilities,
      transitions: [],
      assignees: [],
      canAssign: false,
      transitionsCapturedAt: null,
      assigneesCapturedAt: null,
    });
    mount();
    expect(
      await screen.findByText("Connect once to load options"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Available Jira transitions" }),
    ).toBeDisabled();
    expect(edits.capabilities).toHaveBeenCalledWith(key, "100", false, "");
    expect(edits.capabilities).not.toHaveBeenCalledWith(key, "100", true, "");
  });

  it("does not show a local success until enqueue confirms the SQLite write", async () => {
    let acknowledge!: (value: PendingChange) => void;
    vi.mocked(edits.enqueue).mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    mount();
    const status = await screen.findByRole("combobox", {
      name: "Available Jira transitions",
    });
    await waitFor(() =>
      expect(edits.capabilities).toHaveBeenCalledWith(key, "100", true, ""),
    );
    fireEvent.change(status, { target: { value: "start" } });
    expect(edits.enqueue).toHaveBeenCalledWith(
      key,
      "100",
      {
        field: "status",
        transitionId: "start",
      },
      accountKey,
    );
    expect(screen.queryByText("Saved locally")).not.toBeInTheDocument();
    await act(async () => {
      acknowledge(pending("status", "queued"));
    });
    expect(await screen.findByText("Saved locally")).toBeInTheDocument();
  });

  it("keeps the save notice neutral and clears sync failure after confirmation", async () => {
    let currentChanges: PendingChange[] = [];
    vi.mocked(edits.list).mockImplementation(async () => currentChanges);
    vi.mocked(edits.enqueue).mockImplementation(async () => {
      currentChanges = [pending("status", "queued")];
      return currentChanges[0];
    });
    vi.mocked(edits.sync).mockRejectedValue(new Error("Worker is unavailable"));
    const { client } = mount();
    const status = await screen.findByRole("combobox", {
      name: "Available Jira transitions",
    });
    fireEvent.change(status, { target: { value: "start" } });
    expect(await screen.findByText("Saved locally")).toBeInTheDocument();
    expect(
      await screen.findByText("Worker is unavailable"),
    ).toBeInTheDocument();

    currentChanges = [];
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["changes", accountKey] });
    });
    await waitFor(() =>
      expect(
        screen.queryByText("Worker is unavailable"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Saved locally");
    expect(screen.queryByText("waiting to sync")).not.toBeInTheDocument();
  });

  it("shows a local save failure without claiming the issue changed", async () => {
    vi.mocked(edits.enqueue).mockRejectedValue(new Error("SQLite is locked"));
    mount();
    fireEvent.change(
      await screen.findByRole("combobox", {
        name: "Available Jira transitions",
      }),
      { target: { value: "start" } },
    );
    expect(
      await screen.findByText("Change was not saved locally"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Saved locally")).not.toBeInTheDocument();
  });

  it("locks only the field with an immutable unresolved operation", async () => {
    vi.mocked(edits.list).mockResolvedValue([pending("status", "conflict")]);
    mount();
    expect(
      await screen.findByText(/This field is conflict/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Available Jira transitions" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Assign to" })).toBeEnabled();
  });

  it("uses a queued transition's base status for replacement, not its projection", async () => {
    vi.mocked(edits.list).mockResolvedValue([
      pending("status", "queued", {
        base: { id: "1", label: "To Do" },
        requested: { id: "3", label: "In Progress" },
      }),
    ]);
    vi.mocked(edits.capabilities).mockResolvedValue({
      ...capabilities,
      sourceStatusId: "1",
    });
    mount();
    expect(
      await screen.findByRole("combobox", {
        name: "Available Jira transitions",
      }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Keep current Jira status" }),
    ).toBeInTheDocument();
  });

  it("shows unsupported transition requirements and never offers unassign", async () => {
    vi.mocked(edits.capabilities).mockResolvedValue({
      ...capabilities,
      transitions: [
        {
          ...capabilities.transitions[0],
          supported: false,
          reason: "Resolution is required",
        },
      ],
    });
    mount();
    expect(
      await screen.findByText(
        (_, element) =>
          element?.tagName === "LI" &&
          element.textContent?.includes("Resolution is required") === true,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /unavailable/ })).toBeDisabled();
    expect(
      screen.queryByRole("option", { name: /unassign/i }),
    ).not.toBeInTheDocument();
  });
});
