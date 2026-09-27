import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const ipc = vi.hoisted(() => ({
  session: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  projects: vi.fn(),
  boards: vi.fn(),
  boardConfig: vi.fn(),
  createMetadata: vi.fn(),
}));
const cache = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  issues: vi.fn(),
  issue: vi.fn(),
  sync: vi.fn(),
}));
const editApi = vi.hoisted(() => ({
  list: vi.fn(),
  capabilities: vi.fn(),
  enqueue: vi.fn(),
  resolve: vi.fn(),
  sync: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("./lib/bridge", () => ({ bridge: ipc }));
vi.mock("./lib/workspace", () => ({ workspace: cache }));
vi.mock("./lib/edits", () => ({ edits: editApi }));

const savedSession = {
  siteUrl: "https://example.atlassian.net",
  email: "yi@example.com",
  accountName: "Yi",
};
const sampleField = {
  id: "fixVersions",
  name: "Fix versions",
  required: false,
  schemaType: "array",
  operations: ["set"],
  allowedValueCount: 152,
  allowedValues: Array.from({ length: 10 }, (_, index) => ({
    id: String(index),
    value: `Version ${index}`,
    keys: ["id", "value"],
  })),
  unrecognizedValueCount: 1,
  unrecognizedSamples: ["id, providerCode"],
};

function renderApp() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  Object.values(ipc).forEach((mock) => mock.mockReset());
  ipc.session.mockResolvedValue(null);
  ipc.connect.mockResolvedValue(savedSession);
  ipc.disconnect.mockResolvedValue(undefined);
  ipc.projects.mockResolvedValue([
    { id: "1001", key: "CK", name: "CargoKing" },
  ]);
  ipc.boards.mockResolvedValue([{ id: 42, name: "Main board", type: "scrum" }]);
  ipc.boardConfig.mockResolvedValue({
    columns: [{ name: "In progress", statuses: ["In Progress"] }],
  });
  ipc.createMetadata.mockResolvedValue([
    { id: "10001", name: "Task", fields: [sampleField] },
  ]);
  cache.list.mockResolvedValue([]);
  cache.read.mockResolvedValue(null);
  cache.issues.mockResolvedValue({ issues: [], total: 0 });
  cache.issue.mockResolvedValue(null);
  cache.sync.mockImplementation(async (key) => cache.read(key));
  editApi.list.mockResolvedValue([]);
  editApi.capabilities.mockResolvedValue({
    sourceStatusId: "3",
    transitionsCapturedAt: null,
    assigneesCapturedAt: null,
    transitions: [],
    assignees: [],
    canAssign: false,
    assigneeQuery: "",
    assigneesComplete: false,
  });
  editApi.enqueue.mockResolvedValue(null);
  editApi.resolve.mockResolvedValue(undefined);
  editApi.sync.mockResolvedValue(undefined);
  editApi.subscribe.mockResolvedValue(() => undefined);
});
afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

function useNativeWindow() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
}

function fillConnection(siteUrl = "https://example.atlassian.net") {
  fireEvent.change(screen.getByLabelText("Jira site URL"), {
    target: { value: siteUrl },
  });
  fireEvent.change(screen.getByLabelText("Account email"), {
    target: { value: "yi@example.com" },
  });
  fireEvent.change(screen.getByLabelText("API token"), {
    target: { value: "secret-token" },
  });
}

describe("personal desktop pilot", () => {
  it("keeps credential inputs out of the browser preview", async () => {
    renderApp();
    expect(
      await screen.findByText("Open the desktop app to connect"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("API token")).not.toBeInTheDocument();
  });

  it("connects through native IPC and never stores the token in query data", async () => {
    useNativeWindow();
    ipc.session
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(savedSession);
    const client = renderApp();
    await screen.findByLabelText("API token");
    fillConnection();
    fireEvent.click(screen.getByRole("button", { name: /connect to jira/i }));
    await screen.findByText("Choose a board to download");
    expect(ipc.connect).toHaveBeenCalledWith(
      "https://example.atlassian.net",
      "yi@example.com",
      "secret-token",
    );
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain("secret-token");
    expect(screen.queryByLabelText("API token")).not.toBeInTheDocument();
  });

  it("clears a rejected token and shows the native error", async () => {
    useNativeWindow();
    ipc.connect.mockRejectedValue("Jira rejected the credentials.");
    renderApp();
    await screen.findByLabelText("API token");
    fillConnection();
    fireEvent.click(screen.getByRole("button", { name: /connect to jira/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Jira rejected the credentials.",
    );
    expect(screen.getByLabelText("API token")).toHaveValue("");
  });

  it("accepts a site hostname without blocking native HTTPS normalization", async () => {
    useNativeWindow();
    renderApp();
    const site = (await screen.findByLabelText(
      "Jira site URL",
    )) as HTMLInputElement;
    fillConnection("cargoking.atlassian.net");
    expect(site.checkValidity()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /connect to jira/i }));
    await waitFor(() =>
      expect(ipc.connect).toHaveBeenCalledWith(
        "cargoking.atlassian.net",
        "yi@example.com",
        "secret-token",
      ),
    );
  });

  it("shows a vault failure and lets the user retry session restoration", async () => {
    ipc.session
      .mockReset()
      .mockRejectedValueOnce("The system credential vault is unavailable.")
      .mockResolvedValue(null);
    renderApp();
    expect(
      await screen.findByText("Unable to open saved connection"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The system credential vault is unavailable."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText("Open the desktop app to connect"),
    ).toBeInTheDocument();
    expect(ipc.session).toHaveBeenCalledTimes(2);
  });

  it("shows a disconnect failure without dropping the current workspace", async () => {
    ipc.session.mockResolvedValue(savedSession);
    ipc.disconnect.mockRejectedValue(
      "The system credential vault is unavailable.",
    );
    renderApp();
    await screen.findByText("Choose a board to download");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The system credential vault is unavailable.",
    );
    expect(screen.getByText("Choose a board to download")).toBeInTheDocument();
  });

  it("shows cached issues even when live project discovery fails", async () => {
    ipc.session.mockResolvedValue(savedSession);
    ipc.projects.mockRejectedValue("Project discovery unavailable");
    cache.list.mockResolvedValue([
      {
        projectKey: "CK",
        boardId: 42,
        projectName: "CargoKing",
        boardName: "Main board",
        lastSyncedAt: "2026-09-26T16:00:00Z",
      },
    ]);
    cache.read.mockResolvedValue({
      projectKey: "CK",
      boardId: 42,
      projectName: "CargoKing",
      boardName: "Main board",
      lastSyncedAt: "2026-09-26T16:00:00Z",
      columns: [{ name: "In progress", statusIds: ["3"] }],
      sprints: [],
      issueCount: 1,
      commentCount: 0,
    });
    cache.issues.mockResolvedValue({
      issues: [
        {
          id: "100",
          key: "CK-100",
          summary: "Cached issue stays visible",
          status: { id: "3", name: "In progress", category: "inprogress" },
          assignee: null,
          issueType: "Task",
          priority: null,
          storyPoints: null,
          versions: [],
          sprintIds: [],
          epic: null,
          updated: "2026-09-26T15:00:00Z",
          offBoard: false,
        },
      ],
      total: 1,
    });
    renderApp();
    expect(
      await screen.findByText("Cached issue stays visible"),
    ).toBeInTheDocument();
    expect(ipc.projects).not.toHaveBeenCalled();
  });

  it("keeps workspace search state while visiting Settings and returning to another scope", async () => {
    ipc.session.mockResolvedValue(savedSession);
    const key = { projectKey: "CK", boardId: 42 };
    cache.list.mockResolvedValue([
      {
        ...key,
        projectName: "CargoKing",
        boardName: "Main board",
        lastSyncedAt: "2026-09-26T16:00:00Z",
      },
    ]);
    cache.read.mockResolvedValue({
      ...key,
      projectName: "CargoKing",
      boardName: "Main board",
      lastSyncedAt: "2026-09-26T16:00:00Z",
      columns: [{ name: "In progress", statusIds: ["3"] }],
      sprints: [],
      issueCount: 0,
      commentCount: 0,
    });
    renderApp();

    const search = await screen.findByRole("searchbox", {
      name: "Search downloaded issues",
    });
    fireEvent.change(search, { target: { value: "release notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    fireEvent.click(screen.getByRole("button", { name: "Downloaded issues" }));

    expect(
      screen.getByRole("searchbox", { name: "Search downloaded issues" }),
    ).toHaveValue("release notes");
  });

  it("opens the mobile sidebar and closes it on Escape", async () => {
    ipc.session.mockResolvedValue(savedSession);
    renderApp();
    await screen.findByRole("button", { name: "Settings" });
    const toggle = screen.getAllByRole("button", { name: "Current sprint" })[0];
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("primary-sidebar")).toHaveClass(
      "mobile-open",
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("primary-sidebar")).not.toHaveClass(
      "mobile-open",
    );
  });

  it("loads Scrum boards for the project selected in the offline download picker", async () => {
    ipc.session.mockResolvedValue(savedSession);
    ipc.projects.mockResolvedValue([
      { id: "1001", key: "CK", name: "CargoKing" },
      { id: "1002", key: "API", name: "Backend" },
    ]);
    ipc.boards.mockImplementation(async (key: string) =>
      key === "API"
        ? [{ id: 84, name: "API board", type: "scrum" }]
        : [{ id: 42, name: "Main board", type: "scrum" }],
    );
    renderApp();
    await screen.findByRole("button", { name: "Continue" });
    fireEvent.change(screen.getByLabelText("Project"), {
      target: { value: "API" },
    });
    await waitFor(() => expect(ipc.boards).toHaveBeenCalledWith("API"));
    await waitFor(() =>
      expect(screen.getAllByLabelText("Board").at(-1)).toHaveValue("84"),
    );
  });

  it("keeps the project and board pair aligned when returning from project setup", async () => {
    ipc.session.mockResolvedValue(savedSession);
    ipc.projects.mockResolvedValue([
      { id: "1001", key: "CK", name: "CargoKing" },
      { id: "1002", key: "API", name: "Backend" },
    ]);
    ipc.boards.mockImplementation(async (key: string) =>
      key === "API"
        ? [{ id: 84, name: "API board", type: "scrum" }]
        : [{ id: 42, name: "Main board", type: "scrum" }],
    );
    renderApp();
    await screen.findByRole("button", { name: "Continue" });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("tab", { name: "Setup" }));
    await waitFor(() =>
      expect(screen.getAllByLabelText("Project").at(-1)).toHaveValue("CK"),
    );
    fireEvent.change(screen.getAllByLabelText("Project").at(-1)!, {
      target: { value: "API" },
    });
    await waitFor(() =>
      expect(screen.getAllByLabelText("Board").at(-1)).toHaveValue("84"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Current sprint" }));
    await waitFor(() =>
      expect(screen.getAllByLabelText("Project")[0]).toHaveValue("API"),
    );
    expect(screen.getAllByLabelText("Board")[0]).toHaveValue("84");
  });

  it("retries failed create metadata and distinguishes option totals from samples", async () => {
    ipc.session.mockResolvedValue(savedSession);
    ipc.createMetadata
      .mockReset()
      .mockRejectedValueOnce("Metadata unavailable")
      .mockResolvedValue([
        { id: "10001", name: "Task", fields: [sampleField] },
      ]);
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("tab", { name: "Field metadata" }));
    await screen.findByText("Metadata available for CK.");
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect Jira metadata" }),
    );
    expect(
      await screen.findByText("Metadata inspection failed"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh Jira metadata" }),
    );
    await waitFor(() => expect(ipc.createMetadata).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByText("Task"));
    expect(screen.getByText("152 options · 10 sampled")).toBeInTheDocument();
    fireEvent.click(screen.getByText("152 options · 10 sampled"));
    expect(
      screen.getByText(/1 unrecognized option; sample keys: id, providerCode/),
    ).toBeInTheDocument();
  });
});
