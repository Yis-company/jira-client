import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IssueDetailDialog } from "./IssueDetailDialog";
import type { IssueDetail } from "../lib/workspace";
import type { IssueCapabilities, PendingChange } from "../lib/edits";

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
    summary: "Current title",
    status: { id: "1", name: "To Do", category: "todo" },
    assignee: null,
    issueType: "Task",
    priority: null,
    storyPoints: 3,
    versions: [],
    sprintIds: [],
    epic: null,
    updated: "2026-09-27T09:00:00Z",
    offBoard: false,
  },
  description: {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Existing detail" }],
      },
    ],
  },
  fields: {},
  fieldNames: {},
  comments: [],
  attachments: [],
};
const capabilities: IssueCapabilities = {
  sourceStatusId: "1",
  transitionsCapturedAt: null,
  assigneesCapturedAt: null,
  transitions: [],
  assignees: [],
  canAssign: false,
  canEditSummary: true,
  canEditDescription: true,
  assigneeQuery: "",
  assigneesComplete: false,
};

function pending(field: PendingChange["field"]): PendingChange {
  return {
    ...key,
    id: 7,
    issueId: issue.issue.id,
    issueKey: issue.issue.key,
    summary: issue.issue.summary,
    field,
    state: "queued",
    base: { id: null, label: "Current" },
    requested: { id: null, label: "Updated" },
    remote: null,
    error: null,
    attempted: false,
    canRetry: false,
    createdAt: "2026-09-27T09:00:00Z",
  };
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onClose = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <IssueDetailDialog
        open
        issue={issue}
        loading={false}
        error={null}
        sprints={[]}
        pendingChanges={[]}
        accountKey={accountKey}
        workspaceKey={key}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  return { view, onClose, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(editApi.list).mockResolvedValue([]);
  vi.mocked(editApi.capabilities).mockResolvedValue(capabilities);
  vi.mocked(editApi.enqueue).mockImplementation(async (_key, _id, change) =>
    pending(change.field),
  );
  vi.mocked(editApi.resolve).mockResolvedValue(undefined);
  vi.mocked(editApi.sync).mockResolvedValue(undefined);
  vi.mocked(editApi.subscribe).mockResolvedValue(() => undefined);
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
});

afterEach(cleanup);

describe("IssueDetailDialog editing", () => {
  it("saves a title only from its explicit Save action", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit title" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
      target: { value: "Updated title" },
    });
    expect(editApi.enqueue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));
    await waitFor(() =>
      expect(editApi.enqueue).toHaveBeenCalledWith(
        key,
        "100",
        { field: "summary", summary: "Updated title" },
        accountKey,
      ),
    );
  });

  it("round-trips an unchanged ADF document when Save is explicit", async () => {
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit description" }),
    );
    expect(
      screen.getByRole("textbox", { name: "Description editor" }),
    ).toHaveTextContent("Existing detail");
    fireEvent.click(screen.getByRole("button", { name: "Save description" }));
    await waitFor(() =>
      expect(editApi.enqueue).toHaveBeenCalledWith(
        key,
        "100",
        { field: "description", description: issue.description },
        accountKey,
      ),
    );
  });

  it("asks before Escape discards a changed title draft and keeps it on Keep editing", async () => {
    const { onClose } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit title" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
      target: { value: "Unsaved title" },
    });
    fireEvent(
      screen.getByRole("dialog"),
      new Event("cancel", { bubbles: false, cancelable: true }),
    );
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "unsaved edits",
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(
      "Unsaved title",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(editApi.enqueue).not.toHaveBeenCalled();
  });

  it("keeps a title draft when cached issue details refresh", async () => {
    const { view, client } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit title" }));
    const input = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(input, { target: { value: "My working draft" } });
    const refreshed = {
      ...issue,
      issue: { ...issue.issue, summary: "Remote title update" },
    };
    view.rerender(
      <QueryClientProvider client={client}>
        <IssueDetailDialog
          open
          issue={refreshed}
          loading={false}
          error={null}
          sprints={[]}
          pendingChanges={[]}
          accountKey={accountKey}
          workspaceKey={key}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(
      "My working draft",
    );
  });

  it("does not offer rich editing when ADF contains Jira-specific nodes", async () => {
    const unsafeIssue = {
      ...issue,
      description: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              { type: "mention", attrs: { id: "user-1", text: "@user-1" } },
            ],
          },
        ],
      },
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <IssueDetailDialog
          open
          issue={unsafeIssue}
          loading={false}
          error={null}
          sprints={[]}
          pendingChanges={[]}
          accountKey={accountKey}
          workspaceKey={key}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText(/mention element that stays read-only/),
    ).toBeInTheDocument();
    expect(screen.getByText(/@user-1/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit description" }),
    ).toBeDisabled();
  });
});
