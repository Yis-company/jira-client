import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Workspace } from "./Workspace";
import { edits } from "../lib/edits";
import {
  type CachedWorkspace,
  type IssueDetail,
  type IssueSummary,
  workspace,
  type WorkspaceRef,
} from "../lib/workspace";

vi.mock("../lib/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/workspace")>();
  return {
    ...actual,
    workspace: {
      list: vi.fn(),
      read: vi.fn(),
      issues: vi.fn(),
      issue: vi.fn(),
      sync: vi.fn(),
    },
  };
});
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
const api = vi.mocked(workspace);
const key = { projectKey: "CK", boardId: 42 };
const ref: WorkspaceRef = {
  ...key,
  projectName: "CargoKing",
  boardName: "Development",
  lastSyncedAt: "2026-09-26T16:00:00Z",
};
const issue: IssueSummary = {
  id: "100",
  key: "CK-100",
  summary: "Improve the issue cache",
  status: { id: "3", name: "In Progress", category: "inprogress" },
  assignee: { id: "u1", displayName: "Yi" },
  issueType: "Task",
  priority: "High",
  storyPoints: 5,
  versions: ["ck-admin-4.44.0"],
  sprintIds: [1],
  epic: "CK-EPIC",
  updated: "2026-09-26T15:00:00Z",
  offBoard: false,
};
const cached: CachedWorkspace = {
  ...ref,
  columns: [
    { name: "In Progress", statusIds: ["3"] },
    {
      name: "Done",
      statusIds: ["10001"],
    },
  ],
  sprints: [
    { id: 1, name: "Current sprint", state: "active" },
    {
      id: 2,
      name: "Next sprint",
      state: "future",
    },
  ],
  issueCount: 1,
  commentCount: 1,
};
const detail: IssueDetail = {
  issue,
  description: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Safe text",
            marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
          },
        ],
      },
    ],
  },
  fields: { customfield_1: { label: "Example", value: 3 } },
  fieldNames: { customfield_1: "Custom field" },
  comments: [
    {
      id: "c1",
      author: "Yi",
      created: "2026-09-26T15:00:00Z",
      updated: "2026-09-26T15:00:00Z",
      body: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Looks good" }],
          },
        ],
      },
    },
  ],
  attachments: [
    {
      id: "a1",
      filename: "design.png",
      mimeType: "image/png",
      size: 1024,
    },
  ],
};

function mount(
  props: {
    projects?: { id: string; key: string; name: string }[];
    boards?: { id: number; name: string; type: string }[];
    scope?: "current" | "backlog" | "all";
    onShowChanges?: () => void;
    openIssueRequest?: {
      key: { projectKey: string; boardId: number };
      issueId: string;
    } | null;
    onIssueRequestHandled?: () => void;
  } = {},
  strict = false,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const content = (
    <Workspace accountKey="https://jira.test:yi@example.com" {...props} />
  );
  return render(
    <QueryClientProvider client={client}>
      {strict ? <StrictMode>{content}</StrictMode> : content}
    </QueryClientProvider>,
  );
}
function page(items: IssueSummary[] = [issue]) {
  return { issues: items, total: items.length };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  vi.mocked(api.list).mockResolvedValue([ref]);
  vi.mocked(api.read).mockResolvedValue(cached);
  vi.mocked(api.issues).mockResolvedValue(page());
  vi.mocked(api.issue).mockResolvedValue(detail);
  vi.mocked(api.sync).mockResolvedValue(cached);
  vi.mocked(edits.list).mockResolvedValue([]);
  vi.mocked(edits.capabilities).mockResolvedValue({
    sourceStatusId: "3",
    transitionsCapturedAt: null,
    assigneesCapturedAt: null,
    transitions: [],
    assignees: [],
    canAssign: false,
    assigneeQuery: "",
    assigneesComplete: false,
  });
  vi.mocked(edits.enqueue).mockResolvedValue(null);
  vi.mocked(edits.resolve).mockResolvedValue(undefined);
  vi.mocked(edits.sync).mockResolvedValue(undefined);
  vi.mocked(edits.subscribe).mockResolvedValue(() => undefined);
});
afterEach(cleanup);

describe("offline workspace", () => {
  it("opens cached issues before discovery and refreshes them in the background", async () => {
    mount();
    expect(
      await screen.findByText("Improve the issue cache"),
    ).toBeInTheDocument();
    expect(api.read).toHaveBeenCalledWith(key);
    await waitFor(() => expect(api.sync).toHaveBeenCalledWith(key));
  });

  it("coalesces StrictMode startup refresh to one request", async () => {
    mount({}, true);
    expect(
      await screen.findByText("Improve the issue cache"),
    ).toBeInTheDocument();
    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(1));
  });

  it("retains cached rows after an explicit sync fails", async () => {
    vi.mocked(api.sync).mockRejectedValue(new Error("Jira is unavailable"));
    mount();
    expect(
      await screen.findByText("Improve the issue cache"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/Refresh failed · showing saved data/),
    ).toBeInTheDocument();
    expect(api.sync).toHaveBeenCalledWith(key);
    expect(screen.getByText("Improve the issue cache")).toBeInTheDocument();
  });

  it("keeps the last issue page visible when a refresh read fails", async () => {
    vi.mocked(api.issues)
      .mockResolvedValueOnce(page())
      .mockRejectedValueOnce(new Error("Local cache read failed"));
    mount();
    expect(
      await screen.findByText("Improve the issue cache"),
    ).toBeInTheDocument();
    await waitFor(() => expect(api.issues).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText(/Could not refresh this page/),
    ).toBeInTheDocument();
    expect(screen.getByText("Improve the issue cache")).toBeInTheDocument();
  });

  it("keeps saved issue details visible when a refresh read fails", async () => {
    vi.mocked(api.issue)
      .mockResolvedValueOnce(detail)
      .mockRejectedValueOnce(new Error("Local cache read failed"));
    mount();
    fireEvent.click(
      await screen.findByRole("button", {
        name: /CK-100.*Improve the issue cache/,
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Improve the issue cache",
    });
    expect(await within(dialog).findByText("Safe text")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Sync$/ }));
    expect(
      await within(dialog).findByText(/Could not refresh issue details/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Safe text")).toBeInTheDocument();
  });

  it("preserves search and selected issue when switching between list and board", async () => {
    mount();
    fireEvent.change(
      await screen.findByRole("searchbox", {
        name: "Search downloaded issues",
      }),
      { target: { value: "cache" } },
    );
    await waitFor(() =>
      expect(
        api.issues.mock.calls.some(([filter]) => filter.search === "cache"),
      ).toBe(true),
    );
    const row = await screen.findByRole("button", {
      name: /CK-100.*Improve the issue cache/,
    });
    fireEvent.click(row);
    expect(
      await screen.findByRole("dialog", { name: "Improve the issue cache" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Close issue details" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    expect(screen.getByRole("button", { name: "Board" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("searchbox", { name: "Search downloaded issues" }),
    ).toHaveValue("cache");
    expect(
      screen.getByRole("button", { name: /CK-100.*Improve the issue cache/ }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", { name: /CK-100.*Improve the issue cache/ }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("opens cached detail with safe rich text and collapsed additional fields", async () => {
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: /Improve the issue cache/ }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Improve the issue cache",
    });
    expect(dialog).toBeInTheDocument();
    expect(dialog.querySelector("details[open]")).toBeNull();
    fireEvent.click(screen.getByText("Additional fields"));
    expect(screen.getByText("Custom field")).toBeInTheDocument();
    expect(screen.getByText("design.png")).toBeInTheDocument();
    expect(within(dialog).getByText("Looks good")).toBeInTheDocument();
    expect(within(dialog).queryByRole("link")).not.toBeInTheDocument();
  });

  it("uses a modal and restores focus to the originating issue row", async () => {
    mount();
    const row = await screen.findByRole("button", {
      name: /CK-100.*Improve the issue cache/,
    });
    fireEvent.click(row);
    const dialog = await screen.findByRole("dialog", {
      name: "Improve the issue cache",
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Close issue details" }),
      ).toHaveFocus(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Close issue details" }),
    );
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
    await waitFor(() => expect(row).toHaveFocus());
  });

  it("closes the detail modal before opening Sync changes", async () => {
    const onShowChanges = vi.fn();
    vi.mocked(edits.list).mockResolvedValue([
      {
        ...key,
        id: 7,
        issueId: "100",
        issueKey: "CK-100",
        summary: issue.summary,
        field: "status",
        state: "queued",
        base: { id: "3", label: "In Progress" },
        requested: { id: "4", label: "Review" },
        remote: null,
        error: null,
        attempted: false,
        createdAt: "2026-09-26T16:00:00Z",
        canRetry: false,
      },
    ]);
    mount({ onShowChanges });
    fireEvent.click(
      await screen.findByRole("button", {
        name: /CK-100.*Improve the issue cache/,
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Improve the issue cache",
    });
    fireEvent.click(
      await within(dialog).findByRole("button", {
        name: "Review pending change in Sync changes",
      }),
    );
    expect(onShowChanges).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
  });

  it("opens a pinned change issue even when it is outside the downloaded result set", async () => {
    vi.mocked(api.issues).mockResolvedValue(page([]));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const onIssueRequestHandled = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <Workspace
          accountKey="https://jira.test:yi@example.com"
          openIssueRequest={{ key, issueId: "100" }}
          onIssueRequestHandled={onIssueRequestHandled}
        />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole("dialog", { name: "Improve the issue cache" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Improve the issue cache"),
    ).toBeInTheDocument();
    expect(onIssueRequestHandled).toHaveBeenCalled();
    expect(api.issues).toHaveBeenCalledWith(
      expect.objectContaining({ view: "current" }),
    );
  });

  it("offers an initial download when no workspace is cached", async () => {
    vi.mocked(api.list).mockResolvedValue([]);
    vi.mocked(api.read).mockResolvedValue(null);
    mount({
      projects: [{ id: "1", key: "CK", name: "CargoKing" }],
      boards: [{ id: 42, name: "Development", type: "scrum" }],
    });
    expect(
      await screen.findByText("Choose a board to download"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(api.sync).toHaveBeenCalledWith(key));
    expect(
      await screen.findByText("Improve the issue cache"),
    ).toBeInTheDocument();
  });

  it("does not claim offline data exists when the first download fails", async () => {
    vi.mocked(api.list).mockResolvedValue([]);
    vi.mocked(api.read).mockResolvedValue(null);
    vi.mocked(api.sync).mockRejectedValue(new Error("Jira is unavailable"));
    mount({
      projects: [{ id: "1", key: "CK", name: "CargoKing" }],
      boards: [{ id: 42, name: "Development", type: "scrum" }],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/Download failed/)).toBeInTheDocument();
    expect(screen.queryByText(/Saved on this device/)).not.toBeInTheDocument();
  });

  it("searches downloaded issues and pages only the returned result set", async () => {
    const issues = Array.from({ length: 101 }, (_, index) => ({
      ...issue,
      id: String(index),
      key: `CK-${index + 1}`,
      summary: `Issue ${index + 1}`,
    }));
    vi.mocked(api.issues).mockImplementation(async (filter) => {
      const matching = filter.search
        ? issues.filter((item) =>
            `${item.key} ${item.summary}`
              .toLowerCase()
              .includes(filter.search.toLowerCase()),
          )
        : issues;
      return {
        issues: matching.slice(filter.offset, filter.offset + filter.limit),
        total: matching.length,
      };
    });
    mount({ scope: "all" });
    expect(await screen.findByText("Issue 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(
        api.issues.mock.calls.some(([filter]) => filter.offset === 100),
      ).toBe(true),
    );
    expect(await screen.findByText("Issue 101")).toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search downloaded issues" }),
      { target: { value: "101" } },
    );
    await waitFor(() =>
      expect(
        api.issues.mock.calls.some(
          ([filter]) => filter.search === "101" && filter.offset === 0,
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("Issue 101")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Next" }),
    ).not.toBeInTheDocument();
  });

  it("refreshes saved data when the network comes back", async () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    mount();
    expect(
      await screen.findByText("Improve the issue cache"),
    ).toBeInTheDocument();
    expect(api.sync).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(api.sync).toHaveBeenCalledWith(key));
  });

  it("keeps issues tagged off-board out of workflow columns", async () => {
    const offBoardIssue = {
      ...issue,
      id: "101",
      key: "CK-101",
      summary: "Off-board status",
      offBoard: true,
    };
    vi.mocked(api.issues).mockResolvedValue(page([issue, offBoardIssue]));
    mount();
    expect(
      await screen.findByText("Improve the issue cache"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Other statuses/ }),
    ).toBeInTheDocument();
    const inProgress = screen.getByRole("heading", {
      name: /In Progress/,
    }).parentElement!;
    expect(
      within(inProgress).queryByText("Off-board status"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Off-board status")).toBeInTheDocument();
  });

  it("skips periodic sync while the app is in the background", async () => {
    const timerSpy = vi.spyOn(window, "setInterval");
    mount();
    expect(
      await screen.findByText("Improve the issue cache"),
    ).toBeInTheDocument();
    const tick = timerSpy.mock.calls.find(([, delay]) => delay === 60_000)?.[0];
    expect(typeof tick).toBe("function");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    api.sync.mockClear();
    await act(async () => {
      (tick as () => void)();
    });
    expect(api.sync).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    timerSpy.mockRestore();
  });
});
