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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "./Workspace";
import { edits } from "../lib/edits";
import {
  type CachedWorkspace,
  type IssueFilter,
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

const api = vi.mocked(workspace);
const accountKey = "https://jira.test:yi@example.com";
const key = { projectKey: "CK", boardId: 42 };
const ref: WorkspaceRef = {
  ...key,
  projectName: "CargoKing",
  boardName: "Development",
  lastSyncedAt: "2026-09-26T16:00:00Z",
};
const cached: CachedWorkspace = {
  ...ref,
  columns: [
    { name: "In progress", statusIds: ["3"] },
    { name: "Done", statusIds: ["10001"] },
  ],
  sprints: [
    { id: 1, name: "Current sprint", state: "active" },
    { id: 2, name: "Future sprint 2", state: "future" },
    { id: 3, name: "Future sprint 3", state: "future" },
    { id: 4, name: "Future sprint 4", state: "future" },
  ],
  issueCount: 4,
  commentCount: 0,
};

function issue(id: string): IssueSummary {
  return {
    id,
    key: `CK-${id}`,
    summary: `Issue ${id}`,
    status: { id: "1", name: "To Do", category: "todo" },
    assignee: null,
    issueType: "Task",
    priority: null,
    storyPoints: null,
    versions: [],
    sprintIds: [],
    epic: null,
    updated: "2026-09-27T08:00:00Z",
    offBoard: false,
  };
}

function renderWorkspace(scope: "current" | "backlog" | "all") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const element = (nextScope: "current" | "backlog" | "all") => (
    <QueryClientProvider client={client}>
      <Workspace accountKey={accountKey} scope={nextScope} />
    </QueryClientProvider>
  );
  return { ...render(element(scope)), element };
}

function section(id: string) {
  return document.getElementById(`section-${id}`)!;
}

function calledWith(filter: Partial<IssueFilter>) {
  return api.issues.mock.calls.some(([actual]) =>
    Object.entries(filter).every(
      ([field, value]) => actual[field as keyof IssueFilter] === value,
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: false,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  api.list.mockResolvedValue([ref]);
  api.read.mockResolvedValue(cached);
  api.issues.mockImplementation(async (filter) => {
    if (filter.view === "future" && filter.sprintId === 3)
      return { issues: [], total: 0 };
    if (filter.offset > 0) return { issues: [], total: 201 };
    return {
      issues: [
        issue(filter.sprintId ? `future-${filter.sprintId}` : "backlog"),
      ],
      total: 201,
    };
  });
  api.issue.mockResolvedValue(null);
  api.sync.mockResolvedValue(cached);
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

describe("combined backlog planning", () => {
  it("loads first future and unscheduled pages, keeps later sections collapsed, and paginates independently", async () => {
    renderWorkspace("backlog");

    await waitFor(() => {
      expect(
        calledWith({
          view: "future",
          sprintId: 2,
          offset: 0,
          limit: 100,
          search: "",
        }),
      ).toBe(true);
      expect(
        calledWith({
          view: "backlog",
          sprintId: null,
          offset: 0,
          limit: 100,
          search: "",
        }),
      ).toBe(true);
    });
    expect(calledWith({ view: "future", sprintId: 3, offset: 0 })).toBe(false);
    expect(
      screen.getByRole("button", { name: /Future sprint 3/ }),
    ).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(
      within(section("future:2")).getByRole("button", { name: "Next" }),
    );
    await waitFor(() =>
      expect(calledWith({ view: "future", sprintId: 2, offset: 100 })).toBe(
        true,
      ),
    );
    expect(calledWith({ view: "backlog", sprintId: null, offset: 100 })).toBe(
      false,
    );

    fireEvent.click(screen.getByRole("button", { name: /Future sprint 3/ }));
    await waitFor(() =>
      expect(calledWith({ view: "future", sprintId: 3, offset: 0 })).toBe(true),
    );
    expect(
      screen.getByRole("button", { name: /Future sprint 3/ }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      within(section("future:3")).getByText("No saved issues in this section."),
    ).toBeInTheDocument();
  });

  it("resets each section to offset zero when the shared search changes", async () => {
    renderWorkspace("backlog");
    await waitFor(() =>
      expect(calledWith({ view: "future", sprintId: 2, offset: 0 })).toBe(true),
    );
    fireEvent.click(
      within(section("future:2")).getByRole("button", { name: "Next" }),
    );
    await waitFor(() =>
      expect(calledWith({ view: "future", sprintId: 2, offset: 100 })).toBe(
        true,
      ),
    );

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search downloaded issues" }),
      {
        target: { value: "release notes" },
      },
    );

    await waitFor(() => {
      expect(
        calledWith({
          view: "future",
          sprintId: 2,
          search: "release notes",
          offset: 0,
        }),
      ).toBe(true);
      expect(
        calledWith({
          view: "backlog",
          sprintId: null,
          search: "release notes",
          offset: 0,
        }),
      ).toBe(true);
    });
    expect(
      calledWith({
        view: "future",
        sprintId: 2,
        search: "release notes",
        offset: 100,
      }),
    ).toBe(false);
  });

  it("limits simultaneous section reads to two and starts a waiting section after a slot opens", async () => {
    const pending: {
      filter: IssueFilter;
      finish: (page: { issues: IssueSummary[]; total: number }) => void;
    }[] = [];
    api.issues.mockImplementation(
      (filter) =>
        new Promise((resolve) => {
          pending.push({ filter, finish: resolve });
        }),
    );
    renderWorkspace("backlog");
    await waitFor(() => expect(api.issues).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: /Future sprint 3/ }));
    fireEvent.click(screen.getByRole("button", { name: /Future sprint 4/ }));
    expect(api.issues).toHaveBeenCalledTimes(2);

    await act(async () => {
      pending[0].finish({ issues: [], total: 0 });
    });
    await waitFor(() => expect(api.issues).toHaveBeenCalledTimes(3));
    expect(pending.map(({ filter }) => filter.sprintId)).toContain(3);

    await act(async () => {
      for (let index = 1; index < pending.length; index += 1) {
        pending[index].finish({ issues: [], total: 0 });
        await Promise.resolve();
      }
    });
  });

  it("keeps the selected list or board presentation when switching to and from backlog", async () => {
    const view = renderWorkspace("current");
    await screen.findByRole("button", { name: /CK-backlog/ });

    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    expect(screen.getByRole("button", { name: "Board" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    view.rerender(view.element("backlog"));
    expect(screen.queryByLabelText("Issue view")).not.toBeInTheDocument();

    view.rerender(view.element("current"));
    expect(screen.getByRole("button", { name: "Board" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
