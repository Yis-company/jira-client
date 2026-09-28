import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  burndown,
  finishForecast,
  nextSprint,
  sprintTime,
  validEstimate,
  workload,
} from "../lib/daily";
import { edits, type PendingChange } from "../lib/edits";
import { requestEditSync } from "../lib/editSync";
import {
  workspace,
  type CachedWorkspace,
  type DailyData,
  type IssueSummary,
  type Sprint,
  type WorkspaceKey,
} from "../lib/workspace";
import "./daily.css";

export function DailyPage({
  accountKey,
  workspaceKey,
  current,
  pendingChanges,
  onOpen,
}: {
  accountKey: string;
  workspaceKey: WorkspaceKey;
  current: CachedWorkspace;
  pendingChanges: PendingChange[];
  onOpen: (issue: IssueSummary, button: HTMLButtonElement) => void;
}) {
  const active = current.sprints.filter((sprint) => sprint.state === "active");
  const [chosen, setChosen] = useState<number | null>(null);
  const sprint = active.find((item) => item.id === chosen) ?? active[0];
  const query = useQuery({
    queryKey: [
      "cached-daily",
      accountKey,
      workspaceKey.projectKey,
      workspaceKey.boardId,
      sprint?.id,
    ],
    queryFn: () => workspace.daily(workspaceKey, sprint!.id),
    enabled: !!sprint,
    retry: false,
  });
  if (!sprint)
    return (
      <div className="workspace-empty">
        <h2>No active sprint</h2>
        <p>Start a sprint in Jira, then refresh this board to use Daily.</p>
      </div>
    );
  return (
    <section className="daily-page" aria-label="Daily sprint review">
      <div className="daily-sprint-heading">
        <div>
          <h2>{sprint.name}</h2>
          <p>{sprint.goal || "No sprint goal has been set in Jira."}</p>
        </div>
        {active.length > 1 && (
          <label>
            Active sprint
            <select
              value={sprint.id}
              onChange={(event) => setChosen(Number(event.target.value))}
            >
              {active.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {query.isError && (
        <p role="alert">
          Could not read Daily data.{" "}
          <button onClick={() => void query.refetch()}>Retry</button>
        </p>
      )}
      {query.data ? (
        <DailyContent
          key={`${accountKey}:${workspaceKey.projectKey}:${workspaceKey.boardId}:${sprint.id}`}
          data={query.data}
          sprint={sprint}
          current={current}
          accountKey={accountKey}
          workspaceKey={workspaceKey}
          pendingChanges={pendingChanges}
          onOpen={onOpen}
        />
      ) : (
        !query.isError && <p>Reading the complete saved sprint…</p>
      )}
    </section>
  );
}

function DailyContent({
  data,
  sprint,
  current,
  accountKey,
  workspaceKey,
  pendingChanges,
  onOpen,
}: {
  data: DailyData;
  sprint: Sprint;
  current: CachedWorkspace;
  accountKey: string;
  workspaceKey: WorkspaceKey;
  pendingChanges: PendingChange[];
  onOpen: (issue: IssueSummary, button: HTMLButtonElement) => void;
}) {
  const client = useQueryClient();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const totals = useMemo(() => workload(data), [data]);
  const time = sprintTime(sprint, now, timeZone);
  const forecast = finishForecast(data, sprint, now, timeZone);
  const [considered, setConsidered] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<number | null>(() =>
    nextSprint(sprint, current.sprints),
  );
  const [confirming, setConfirming] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const future = current.sprints.filter((item) => item.state === "future");
  const destination = future.find((item) => item.id === target);
  const eligible = totals.people
    .flatMap((person) => person.issues)
    .filter((issue) => issue.status.category !== "done");
  const selected = eligible.filter((issue) => considered.has(issue.id));
  const removed = selected.reduce(
    (sum, issue) =>
      sum + (validEstimate(issue.storyPoints) ? issue.storyPoints : 0),
    0,
  );
  const moves = pendingChanges.filter(
    (change) =>
      change.field === "sprint" &&
      change.projectKey === workspaceKey.projectKey &&
      change.boardId === workspaceKey.boardId,
  );
  const anyPending =
    pendingChanges.some((change) =>
      data.issues.some((entry) => entry.issue.id === change.issueId),
    ) || moves.length > 0;

  async function move(issue: IssueSummary) {
    if (!destination || saving) return;
    setSaving(issue.id);
    setError("");
    setNotice("");
    try {
      await edits.enqueue(
        workspaceKey,
        issue.id,
        {
          field: "sprint",
          sourceSprintId: sprint.id,
          targetSprintId: destination.id,
        },
        accountKey,
      );
      setNotice(`${issue.key}: move to ${destination.name} saved locally.`);
      setConfirming(null);
      setConsidered((previous) => {
        const next = new Set(previous);
        next.delete(issue.id);
        return next;
      });
      await Promise.all(
        ["cached-daily", "cached-issues", "cached-issue", "changes"].map(
          (prefix) =>
            client.invalidateQueries({ queryKey: [prefix, accountKey] }),
        ),
      );
      void requestEditSync(accountKey).catch(() =>
        setNotice(
          `${issue.key}: saved locally; sync will resume when available.`,
        ),
      );
    } catch (cause) {
      setError(
        typeof cause === "string"
          ? cause
          : cause instanceof Error
            ? cause.message
            : "Could not save sprint move.",
      );
    } finally {
      setSaving(null);
    }
  }

  return (
    <>
      <p className="daily-meta">
        {sprint.startDate
          ? displayDate(sprint.startDate, timeZone)
          : "Start date not set"}{" "}
        –{" "}
        {sprint.endDate
          ? displayDate(sprint.endDate, timeZone)
          : "End date not set"}{" "}
        · {timeZone} · Last synced{" "}
        {displayDate(current.lastSyncedAt, timeZone, true)}
      </p>
      <div className="daily-metrics">
        <div>
          <strong>{time.days ?? "—"}</strong>
          <span>Weekdays left · includes today</span>
        </div>
        <div>
          <strong>
            {data.estimateFieldId ? format(totals.remaining) : "—"}
          </strong>
          <span>Remaining · {data.estimateLabel}</span>
        </div>
        <div>
          <strong>
            {time.days && data.estimateFieldId
              ? format(totals.remaining / time.days)
              : "—"}
          </strong>
          <span>
            Required per weekday{totals.missing ? " · estimated work only" : ""}
          </span>
        </div>
      </div>
      {time.reason && <p className="daily-note">{time.reason}</p>}
      <p className="daily-meta">
        Standard issues only; subtasks and epic rollups are excluded to avoid
        double counting. Monday–Friday; holidays and leave are not modeled.
      </p>
      {(totals.missing > 0 || totals.unknownHierarchy > 0) && (
        <p className="daily-note">
          {totals.missing} unfinished issues have no estimate.{" "}
          {totals.unknownHierarchy > 0 &&
            `${totals.unknownHierarchy} issues have unknown hierarchy and are excluded from totals. Refresh to update metadata.`}
        </p>
      )}
      {anyPending && (
        <p className="daily-note">
          Workload includes pending local changes. The chart and completion
          trend use confirmed sync observations only.
        </p>
      )}
      <div className="daily-overview">
        <section>
          <h3>Observed burndown</h3>
          <Burndown data={data} sprint={sprint} timeZone={timeZone} />
          <div className="daily-forecast">
            <strong>
              {forecast.date
                ? `Projected finish: ${forecast.date}`
                : "Finish estimate unavailable"}
            </strong>
            <p>
              {forecast.reason ??
                `${forecast.onTrack ? "Within" : "After"} the sprint end at ${format(forecast.rate!)} ${data.estimateLabel.toLowerCase()} per weekday, observed since ${displayDate(forecast.observedSince!, timeZone)}. Assumes that net completion pace continues; scope changes do not count as completion.`}
            </p>
          </div>
        </section>
        <section>
          <h3>People in this sprint</h3>
          <div className="daily-table-scroll">
            <table className="daily-workload">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>To do</th>
                  <th>Doing</th>
                  <th>Done</th>
                  <th>Left</th>
                  <th>Unestimated</th>
                </tr>
              </thead>
              <tbody>
                {totals.people.map((person) => (
                  <tr key={person.id}>
                    <th scope="row">{person.name}</th>
                    <td>{person.todo}</td>
                    <td>{person.doing}</td>
                    <td>{person.done}</td>
                    <td>
                      {data.estimateFieldId ? format(person.remaining) : "—"}
                    </td>
                    <td>{person.missing}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="daily-meta">
            Assigned work, not capacity or a productivity ranking. People with
            no issues in this sprint are not listed.
          </p>
        </section>
      </div>
      <section className="daily-decisions">
        <div className="daily-sprint-heading">
          <div>
            <h3>Discuss next sprint</h3>
            <p>
              Select issues to see how moving them would affect the remaining
              workload.
            </p>
          </div>
          <label>
            Destination sprint
            <select
              aria-label="Destination sprint"
              value={destination?.id ?? ""}
              onChange={(event) => {
                setTarget(Number(event.target.value) || null);
                setConfirming(null);
              }}
            >
              <option value="">Choose a future sprint</option>
              {future.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.startDate
                    ? ` · ${displayDate(item.startDate, timeZone)}`
                    : " · dates not set"}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!future.length && (
          <p className="daily-note">
            No future sprint is saved. Create the next sprint in Jira, then
            refresh.
          </p>
        )}
        {selected.length > 0 && (
          <p className="daily-simulation" role="status">
            Simulation only: {format(totals.remaining)} →{" "}
            {format(totals.remaining - removed)} remaining{" "}
            {data.estimateLabel.toLowerCase()}
            {time.days
              ? `; ${format((totals.remaining - removed) / time.days)} per weekday`
              : ""}
            .{" "}
            {selected.some((issue) => !validEstimate(issue.storyPoints)) &&
              "Some selected work is unestimated."}{" "}
            Nothing moves until you confirm an issue below.
          </p>
        )}
        {error && (
          <p role="alert" className="daily-note">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {!eligible.length && (
          <p>No unfinished standard issues in this sprint.</p>
        )}
        {totals.people.map((person) => (
          <details className="daily-person" key={person.id} open>
            <summary>
              {person.name} ·{" "}
              {
                person.issues.filter(
                  (issue) => issue.status.category !== "done",
                ).length
              }{" "}
              unfinished
            </summary>
            <ul>
              {person.issues.map((issue) => (
                <li key={issue.id}>
                  <input
                    type="checkbox"
                    aria-label={`Consider moving ${issue.key}`}
                    disabled={
                      issue.status.category === "done" ||
                      moves.some((change) => change.issueId === issue.id)
                    }
                    checked={considered.has(issue.id)}
                    onChange={(event) =>
                      setConsidered((previous) => {
                        const next = new Set(previous);
                        if (event.target.checked) next.add(issue.id);
                        else next.delete(issue.id);
                        return next;
                      })
                    }
                  />
                  <button
                    className="daily-issue-title"
                    onClick={(event) => onOpen(issue, event.currentTarget)}
                  >
                    <span>{issue.key}</span>
                    {issue.summary}
                  </button>
                  <span className="daily-issue-meta">
                    {issue.status.name} · {issue.storyPoints ?? "Unestimated"}
                  </span>
                  {issue.status.category !== "done" &&
                    (confirming === issue.id ? (
                      <div className="daily-confirm">
                        <span>
                          Move {issue.key} to {destination?.name}?
                        </span>
                        <button
                          disabled={!destination || !!saving}
                          onClick={() => void move(issue)}
                        >
                          {saving === issue.id ? "Saving…" : "Confirm move"}
                        </button>
                        <button
                          disabled={!!saving}
                          onClick={() => setConfirming(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        disabled={
                          !destination ||
                          moves.some((change) => change.issueId === issue.id)
                        }
                        onClick={() => setConfirming(issue.id)}
                      >
                        Move to {destination?.name ?? "next sprint"}
                      </button>
                    ))}
                </li>
              ))}
            </ul>
          </details>
        ))}
        {moves.length > 0 && (
          <div className="daily-pending">
            <h4>Pending sprint moves</h4>
            {moves.map((change) => (
              <p key={change.id}>
                {change.issueKey} → {change.requested.label} · {change.state}
                {change.error ? ` · ${change.error}` : ""}. Recovery is
                available in Sync changes.
              </p>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function Burndown({
  data,
  sprint,
  timeZone,
}: {
  data: DailyData;
  sprint: Sprint;
  timeZone: string;
}) {
  // Different estimate fields can have different units; never join their values.
  let fieldChange = -1;
  data.observations.forEach((observation, index) => {
    if (observation.estimateFieldId !== data.estimateFieldId)
      fieldChange = index;
  });
  const points = burndown(data.observations.slice(fieldChange + 1), timeZone);
  if (!points.length)
    return (
      <p className="daily-note">
        History starts with the first successful sync after this update. Past
        sprint progress has not been reconstructed.
      </p>
    );
  const first = points[0],
    last = points[points.length - 1];
  const start = Date.parse(first.at),
    finish = Date.parse(sprint.endDate ?? ""),
    end =
      Number.isFinite(finish) && finish > start
        ? Math.max(finish, Date.parse(last.at))
        : Math.max(start + 86_400_000, Date.parse(last.at));
  const max = Math.max(1, ...points.map((point) => point.remaining));
  const x = (at: string) =>
    35 + ((Date.parse(at) - start) / (end - start)) * 510;
  const y = (amount: number) => 170 - (amount / max) * 140;
  const segments: string[] = [];
  let segment = "";
  for (const point of points) {
    if (point.gap && segment) {
      segments.push(segment);
      segment = "";
    }
    segment += `${x(point.at)},${y(point.remaining)} `;
  }
  if (segment) segments.push(segment);
  return (
    <>
      <p className="daily-meta">
        Observed since {displayDate(first.at, timeZone)} · {data.estimateLabel}.
        Missing dates are not backfilled.
        {fieldChange >= 0 &&
          " Earlier observations used a different estimation field."}
      </p>
      <svg
        className="daily-chart"
        viewBox="0 0 580 200"
        role="img"
        aria-label={`Observed remaining work: ${format(first.remaining)} to ${format(last.remaining)}. Scope changes are listed below.`}
      >
        {[0, 0.5, 1].map((ratio) => (
          <g key={ratio}>
            <line
              x1="35"
              x2="550"
              y1={y(max * ratio)}
              y2={y(max * ratio)}
              className="daily-chart-grid"
            />
            <text x="2" y={y(max * ratio) + 4}>
              {format(max * ratio)}
            </text>
          </g>
        ))}
        {Number.isFinite(finish) && finish > start && (
          <line
            x1="35"
            y1={y(first.remaining)}
            x2={x(sprint.endDate!)}
            y2="170"
            className="daily-chart-ideal"
          />
        )}
        {segments.map((line, index) => (
          <polyline
            key={index}
            points={line}
            className="daily-chart-remaining"
          />
        ))}
        <circle
          cx={x(last.at)}
          cy={y(last.remaining)}
          r="4"
          className="daily-chart-dot"
        />
        <text x="35" y="193">
          {displayDate(first.at, timeZone)}
        </text>
        <text x="548" y="193" textAnchor="end">
          {displayDate(new Date(end).toISOString(), timeZone)}
        </text>
      </svg>
      <p className="daily-meta">
        Solid: confirmed remaining · dashed: ideal from first observation. Gaps
        mean no observations.
      </p>
      <p>
        Scope added: {format(points.reduce((sum, p) => sum + p.added, 0))} ·
        moved out: {format(points.reduce((sum, p) => sum + p.removed, 0))} ·
        estimate changes:{" "}
        {format(points.reduce((sum, p) => sum + p.estimateChange, 0))}
      </p>
      {points.some((point) => !point.complete) && (
        <p className="daily-note">
          The chart shows known estimates only; coverage is incomplete.
        </p>
      )}
      <details>
        <summary>Observation data</summary>
        <div className="daily-table-scroll">
          <table className="daily-workload">
            <thead>
              <tr>
                <th>Observed</th>
                <th>Remaining</th>
                <th>Added</th>
                <th>Moved out</th>
                <th>Estimate change</th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.at}>
                  <td>
                    {displayDate(point.at, timeZone, true)}
                    {point.gap ? " · gap" : ""}
                  </td>
                  <td>{format(point.remaining)}</td>
                  <td>{format(point.added)}</td>
                  <td>{format(point.removed)}</td>
                  <td>{format(point.estimateChange)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
function format(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
    value,
  );
}
function displayDate(value: string, timeZone: string, withTime = false) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, {
        timeZone: /^\d{4}-\d{2}-\d{2}$/.test(value) ? "UTC" : timeZone,
        month: "short",
        day: "numeric",
        ...(withTime ? ({ hour: "2-digit", minute: "2-digit" } as const) : {}),
      }).format(date)
    : "Unknown date";
}
