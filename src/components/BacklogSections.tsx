import type { IssuePage, IssueSummary, Sprint } from "../lib/workspace";
import type { PendingChange } from "../lib/edits";
import { FlatIssueList, WorkspacePagination } from "./WorkspaceIssueViews";

export type BacklogSectionData = {
  id: string;
  title: string;
  sprint?: Sprint;
  expanded: boolean;
  loading: boolean;
  error?: string;
  page?: IssuePage;
  offset: number;
  onToggle: () => void;
  onRetry: () => void;
  onOffsetChange: (offset: number) => void;
};

export function BacklogSections({
  sections,
  selectedId,
  changesByIssue,
  onOpen,
}: {
  sections: BacklogSectionData[];
  selectedId: string | null;
  changesByIssue: Map<string, PendingChange[]>;
  onOpen: (issue: IssueSummary, button: HTMLButtonElement) => void;
}) {
  return (
    <div className="backlog-sections" aria-label="Backlog and future sprints">
      {sections.map((section) => (
        <section className="backlog-section" key={section.id}>
          <h2 className="backlog-section-heading">
            <button
              type="button"
              aria-expanded={section.expanded}
              aria-controls={`section-${section.id}`}
              onClick={section.onToggle}
            >
              <span className="backlog-section-title">{section.title}</span>
              {section.sprint && (
                <span className="backlog-section-date">
                  {dateRange(section.sprint)}
                </span>
              )}
              <span className="backlog-section-count">
                {section.page
                  ? `${section.page.total} issues`
                  : section.expanded && section.loading
                    ? "Loading saved issues…"
                    : "Expand to load saved issues"}
              </span>
              <span aria-hidden="true">{section.expanded ? "−" : "+"}</span>
            </button>
          </h2>
          {section.expanded && (
            <div
              id={`section-${section.id}`}
              className="backlog-section-content"
            >
              {section.error && (
                <div className="workspace-inline-error" role="alert">
                  <span>{section.error}</span>
                  <button type="button" onClick={section.onRetry}>
                    Retry
                  </button>
                </div>
              )}
              {section.loading && !section.page ? (
                <p className="workspace-empty">Loading saved issues…</p>
              ) : section.page && section.page.issues.length === 0 ? (
                <>
                  <p className="workspace-empty">
                    {section.offset > 0
                      ? "No issues on this page. Go back to the previous page."
                      : "No saved issues in this section."}
                  </p>
                  {section.offset > 0 && (
                    <WorkspacePagination
                      total={section.page.total}
                      offset={section.offset}
                      loaded={0}
                      onOffsetChange={section.onOffsetChange}
                    />
                  )}
                </>
              ) : (
                section.page && (
                  <>
                    <FlatIssueList
                      issues={section.page.issues}
                      selectedId={selectedId}
                      changesByIssue={changesByIssue}
                      onOpen={onOpen}
                    />
                    <WorkspacePagination
                      total={section.page.total}
                      offset={section.offset}
                      loaded={section.page.issues.length}
                      onOffsetChange={section.onOffsetChange}
                    />
                  </>
                )
              )}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function dateRange(sprint: Sprint) {
  const start = formatDate(sprint.startDate);
  const end = formatDate(sprint.endDate);
  if (start && end) return `${start} – ${end}`;
  return start || end || "Dates not set";
}

function formatDate(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
