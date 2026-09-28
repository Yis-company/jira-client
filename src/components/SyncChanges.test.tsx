import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SyncChanges } from "./SyncChanges";
import { edits, type PendingChange } from "../lib/edits";

const editApi = vi.hoisted(() => ({
  list: vi.fn(),
  capabilities: vi.fn(),
  enqueue: vi.fn(),
  resolve: vi.fn(),
  sync: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("../lib/edits", () => ({ edits: editApi }));

const accountKey = "https://jira.test:yi@example.com";
function change(
  state: PendingChange["state"],
  overrides: Partial<PendingChange> = {},
): PendingChange {
  return {
    projectKey: "CK",
    boardId: 42,
    id: 7,
    issueId: "100",
    issueKey: "CK-100",
    summary: "Move this issue",
    field: "status",
    state,
    base: { id: "1", label: "To Do" },
    requested: { id: "3", label: "In Progress" },
    remote: null,
    error: null,
    attempted: state !== "queued",
    createdAt: "2026-09-27T09:00:00Z",
    canRetry: state === "blocked",
    ...overrides,
  };
}
function mount(items: PendingChange[], openIssue = vi.fn()) {
  vi.mocked(edits.list).mockResolvedValue(items);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SyncChanges accountKey={accountKey} openIssue={openIssue} />
    </QueryClientProvider>,
  );
  return { openIssue, client };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(edits.list).mockResolvedValue([]);
  vi.mocked(edits.resolve).mockResolvedValue(undefined);
  vi.mocked(edits.sync).mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("persistent sync changes", () => {
  it("shows the actual description text when resolving a conflict", async () => {
    const doc = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    mount([change("conflict", {
      field: "description",
      base: { id: null, label: "Description", value: doc("Original text") },
      requested: { id: null, label: "Description", value: doc("My revision") },
      remote: { id: null, label: "Description", value: doc("Teammate revision") },
    })]);
    expect(await screen.findByText("Original text")).toBeInTheDocument();
    expect(screen.getByText("My revision")).toBeInTheDocument();
    expect(screen.getByText("Teammate revision")).toBeInTheDocument();
  });
  it("opens pinned issue context from the owner-wide queue", async () => {
    const openIssue = vi.fn();
    mount([change("queued")], openIssue);
    fireEvent.click(
      await screen.findByRole("button", { name: "CK-100 · Move this issue" }),
    );
    expect(openIssue).toHaveBeenCalledWith(
      { projectKey: "CK", boardId: 42 },
      "100",
    );
    expect(screen.getByText("Requested")).toBeInTheDocument();
  });

  it("offers read-only recovery for unknown outcomes and never calls plain retry", async () => {
    mount([
      change("unknown", {
        remote: { id: "4", label: "In Review" },
        error: "Timed out",
      }),
    ]);
    expect(await screen.findByText("Outcome unknown")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The previous request may have run. Check Jira before starting another edit.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept current Jira value" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).not
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect(edits.resolve).toHaveBeenCalledWith(7, "recheck")
    );
    await waitFor(() => expect(edits.sync).toHaveBeenCalledTimes(1));
    fireEvent.click(
      screen.getByRole("button", { name: "Accept current Jira value" }),
    );
    await waitFor(() =>
      expect(edits.resolve).toHaveBeenCalledWith(7, "discard")
    );
  });

  it("only offers retry for blocked operations", async () => {
    mount([change("blocked", { error: "Permission denied" })]);
    expect(await screen.findByRole("button", { name: "Retry after fixing" }))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry after fixing" }));
    await waitFor(() => expect(edits.resolve).toHaveBeenCalledWith(7, "retry"));
    expect(await screen.findByRole("button", { name: "Discard local change" }))
      .toBeInTheDocument();
  });

  it("does not resend a blocked change after Jira accepted it", async () => {
    mount([change("blocked", {
      canRetry: false,
      error: "Jira accepted the change but the follow-up read failed",
    })]);
    expect(await screen.findByText(/Jira accepted this change/))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry after fixing" }))
      .not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(edits.resolve).toHaveBeenCalledWith(7, "recheck"));
    vi.mocked(edits.resolve).mockClear();
    fireEvent.click(
      screen.getByRole("button", { name: "Discard local change" }),
    );
    await waitFor(() =>
      expect(edits.resolve).toHaveBeenCalledWith(7, "discard")
    );
    expect(edits.resolve).not.toHaveBeenCalledWith(7, "retry");
  });

  it("requires an explicit Keep mine choice only for a conflict", async () => {
    mount([change("conflict", { remote: { id: "4", label: "In Review" } })]);
    expect(await screen.findByRole("button", { name: "Keep mine" }))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    await waitFor(() =>
      expect(edits.resolve).toHaveBeenCalledWith(7, "keepMine")
    );
    expect(screen.getByRole("button", { name: "Use Jira" }))
      .toBeInTheDocument();
    expect(screen.getByText("“Use Jira” keeps the latest saved Jira value shown here."))
      .toBeInTheDocument();
    expect(screen.getByText(
      "The earlier change may already have run. Keep mine requests another validated edit.",
    )).toBeInTheDocument();
  });

  it("allows canceling a queued operation without a Jira retry", async () => {
    mount([change("queued", { attempted: false })]);
    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel queued change" }),
    );
    await waitFor(() =>
      expect(edits.resolve).toHaveBeenCalledWith(7, "discard")
    );
    expect(edits.sync).not.toHaveBeenCalled();
  });
});
