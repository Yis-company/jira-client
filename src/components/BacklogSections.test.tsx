import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BacklogSections, type BacklogSectionData } from "./BacklogSections";
import type { IssueSummary } from "../lib/workspace";

afterEach(cleanup);

const issue: IssueSummary = {
  id: "200",
  key: "CK-200",
  summary: "Prepare next release",
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

function section(
  id: string,
  title: string,
  overrides: Partial<BacklogSectionData> = {},
): BacklogSectionData {
  return {
    id,
    title,
    expanded: true,
    loading: false,
    offset: 0,
    onToggle: vi.fn(),
    onRetry: vi.fn(),
    onOffsetChange: vi.fn(),
    ...overrides,
  };
}

describe("BacklogSections", () => {
  it("keeps Previous available for an empty later page and changes only that section offset", () => {
    const future = section("future-1", "Next sprint", {
      offset: 100,
      page: { issues: [], total: 2 },
    });
    const unscheduled = section("unscheduled", "Unscheduled", {
      page: { issues: [issue], total: 201 },
    });

    render(
      <BacklogSections
        sections={[future, unscheduled]}
        selectedId={null}
        changesByIssue={new Map()}
        onOpen={vi.fn()}
      />,
    );

    const futureSection = document.getElementById("section-future-1")!;
    expect(
      within(futureSection).getByText(
        "No issues on this page. Go back to the previous page.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      within(futureSection).getByRole("button", { name: "Previous" }),
    );

    expect(future.onOffsetChange).toHaveBeenCalledExactlyOnceWith(0);
    expect(unscheduled.onOffsetChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /CK-200.*Prepare next release/ }),
    ).toBeInTheDocument();
  });

  it("keeps collapsed section controls available and invokes only the selected toggle", () => {
    const collapsed = section("future-2", "Later sprint", { expanded: false });
    const expanded = section("unscheduled", "Unscheduled");

    render(
      <BacklogSections
        sections={[collapsed, expanded]}
        selectedId={null}
        changesByIssue={new Map()}
        onOpen={vi.fn()}
      />,
    );

    const collapsedButton = screen.getByRole("button", {
      name: /Later sprint/,
    });
    expect(collapsedButton).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(collapsedButton);

    expect(collapsed.onToggle).toHaveBeenCalledOnce();
    expect(expanded.onToggle).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Unscheduled/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("shows a useful empty state without pagination controls on an empty first page", () => {
    const empty = section("future-3", "Next sprint", {
      page: { issues: [], total: 0 },
    });

    render(
      <BacklogSections
        sections={[empty]}
        selectedId={null}
        changesByIssue={new Map()}
        onOpen={vi.fn()}
      />,
    );

    expect(
      screen.getByText("No saved issues in this section."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "Issue pages" }),
    ).not.toBeInTheDocument();
  });
});
