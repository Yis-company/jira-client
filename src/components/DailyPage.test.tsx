import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DailyPage } from "./DailyPage";
import { edits } from "../lib/edits";
import {
  workspace,
  type CachedWorkspace,
  type DailyData,
} from "../lib/workspace";

vi.mock("../lib/editSync", () => ({
  requestEditSync: vi.fn().mockResolvedValue(undefined),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const current: CachedWorkspace = {
  projectKey: "CK",
  projectName: "Test",
  boardId: 1,
  boardName: "Board",
  lastSyncedAt: "2026-09-28T09:00:00Z",
  columns: [],
  sprints: [
    {
      id: 1,
      name: "Current",
      state: "active",
      goal: "Finish triage",
      startDate: "2026-09-21",
      endDate: "2026-10-02",
    },
    { id: 2, name: "Next", state: "future", startDate: "2026-10-05" },
  ],
  issueCount: 1,
  commentCount: 0,
};
const data: DailyData = {
  sprintId: 1,
  estimateFieldId: "points",
  estimateLabel: "Story Points",
  observations: [],
  issues: [
    {
      hierarchyLevel: 0,
      issue: {
        id: "10",
        key: "CK-10",
        summary: "Triage",
        status: { id: "1", name: "To do", category: "new" },
        assignee: null,
        storyPoints: 5,
        sprintIds: [1],
        issueType: "Task",
        priority: null,
        versions: [],
        epic: null,
        updated: "",
        offBoard: false,
      },
    },
  ],
};
function show(value = current) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DailyPage
        accountKey="owner"
        workspaceKey={{ projectKey: "CK", boardId: 1 }}
        current={value}
        pendingChanges={[]}
        onOpen={vi.fn()}
      />
    </QueryClientProvider>,
  );
}
it("keeps discussion selections read-only and names the future sprint before queueing one move", async () => {
  vi.spyOn(workspace, "daily").mockResolvedValue(data);
  const enqueue = vi.spyOn(edits, "enqueue").mockResolvedValue(null);
  show();
  await screen.findByText("Finish triage");
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Consider moving CK-10" }),
  );
  expect(screen.getByText(/Simulation only/)).toBeInTheDocument();
  expect(enqueue).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Move to Next" }));
  expect(screen.getByText("Move CK-10 to Next?")).toBeInTheDocument();
  expect(enqueue).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm move" }));
  await waitFor(() =>
    expect(enqueue).toHaveBeenCalledWith(
      { projectKey: "CK", boardId: 1 },
      "10",
      { field: "sprint", sourceSprintId: 1, targetSprintId: 2 },
      "owner",
    ),
  );
});
it("does not combine active sprints or invent a destination", async () => {
  const read = vi.spyOn(workspace, "daily").mockResolvedValue(data);
  show({
    ...current,
    sprints: [
      current.sprints[0],
      { ...current.sprints[0], id: 3, name: "Parallel" },
    ],
  });
  await screen.findByRole("table");
  expect(read).toHaveBeenCalledWith({ projectKey: "CK", boardId: 1 }, 1);
  fireEvent.change(screen.getByLabelText("Active sprint"), {
    target: { value: "3" },
  });
  await waitFor(() =>
    expect(read).toHaveBeenCalledWith({ projectKey: "CK", boardId: 1 }, 3),
  );
  expect(
    await screen.findByText(/No future sprint is saved/),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Move to next sprint" }),
  ).toBeDisabled();
  expect(
    within(screen.getByRole("table")).getByText("Unassigned"),
  ).toBeInTheDocument();
});

it("does not mix different estimation units in the observed burndown", async () => {
  vi.spyOn(workspace, "daily").mockResolvedValue({
    ...data,
    observations: [
      {
        capturedAt: "2026-09-21T09:00:00Z",
        estimateFieldId: "timeestimate",
        estimateLabel: "Seconds",
        issues: [
          {
            id: "10",
            statusCategory: "new",
            estimate: 3600,
            hierarchyLevel: 0,
          },
        ],
      },
      {
        capturedAt: "2026-09-22T09:00:00Z",
        estimateFieldId: "points",
        estimateLabel: "Story Points",
        issues: [
          { id: "10", statusCategory: "new", estimate: 5, hierarchyLevel: 0 },
        ],
      },
    ],
  });
  show();
  expect(
    await screen.findByRole("img", {
      name: "Observed remaining work: 5 to 5. Scope changes are listed below.",
    }),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Earlier observations used a different estimation field/),
  ).toBeInTheDocument();
});
