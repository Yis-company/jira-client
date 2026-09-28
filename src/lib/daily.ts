import type {
  DailyData,
  IssueSummary,
  Sprint,
  SprintObservation,
} from "./workspace";

const DAY = 86_400_000;
export function calendarDay(
  value: string | Date,
  timeZone: string,
): number | null {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) &&
      new Date(parsed).toISOString().slice(0, 10) === value
      ? parsed / DAY
      : null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) =>
    Number(parts.find((item) => item.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / DAY;
}

export function workingDays(from: number, to: number): number {
  if (to < from) return 0;
  const total = to - from + 1;
  let count = Math.floor(total / 7) * 5;
  for (let i = 0; i < total % 7; i++) {
    const weekday = new Date((from + i) * DAY).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count++;
  }
  return count;
}

export function sprintTime(sprint: Sprint, now: Date, timeZone: string) {
  const start = sprint.startDate
    ? calendarDay(sprint.startDate, timeZone)
    : null;
  const end = sprint.endDate ? calendarDay(sprint.endDate, timeZone) : null;
  const today = calendarDay(now, timeZone)!;
  if (start === null || end === null || end < start)
    return {
      days: null,
      end: null,
      today,
      reason: "Sprint dates are missing or invalid.",
    };
  return {
    days: workingDays(Math.max(today, start), end),
    end,
    today,
    reason:
      today > end
        ? "Sprint end date has passed."
        : today < start
          ? "Sprint has not started yet."
          : null,
  };
}

export function nextSprint(sprint: Sprint, sprints: Sprint[]): number | null {
  const end = Date.parse(sprint.endDate ?? "");
  const future = sprints.filter((item) => item.state === "future");
  if (
    !Number.isFinite(end) ||
    future.some((item) => !Number.isFinite(Date.parse(item.startDate ?? "")))
  )
    return null;
  const candidates = future
    .filter((item) => Date.parse(item.startDate!) >= end)
    .sort((a, b) => Date.parse(a.startDate!) - Date.parse(b.startDate!));
  if (
    !candidates.length ||
    (candidates[1] &&
      Date.parse(candidates[0].startDate!) ===
        Date.parse(candidates[1].startDate!))
  )
    return null;
  return candidates[0].id;
}

export const validEstimate = (value: number | null): value is number =>
  value !== null && Number.isFinite(value) && value >= 0;

export function workload(data: DailyData) {
  const people = new Map<
    string,
    {
      id: string;
      name: string;
      todo: number;
      doing: number;
      done: number;
      remaining: number;
      missing: number;
      issues: IssueSummary[];
    }
  >();
  let unknownHierarchy = 0;
  for (const entry of data.issues) {
    if (entry.hierarchyLevel === null) {
      unknownHierarchy++;
      continue;
    }
    // Standard issues carry sprint estimates. Subtasks and epic rollups are not added again.
    if (entry.hierarchyLevel !== 0) continue;
    const issue = entry.issue;
    const id = issue.assignee?.id ?? "__unassigned__";
    const person = people.get(id) ?? {
      id,
      name: issue.assignee?.displayName ?? "Unassigned",
      todo: 0,
      doing: 0,
      done: 0,
      remaining: 0,
      missing: 0,
      issues: [],
    };
    if (issue.status.category === "done") person.done++;
    else {
      if (issue.status.category === "new" || issue.status.category === "todo")
        person.todo++;
      else person.doing++;
      if (validEstimate(issue.storyPoints))
        person.remaining += issue.storyPoints;
      else person.missing++;
    }
    person.issues.push(issue);
    people.set(id, person);
  }
  const rows = [...people.values()].sort((a, b) =>
    a.id === "__unassigned__"
      ? 1
      : b.id === "__unassigned__"
        ? -1
        : a.name.localeCompare(b.name),
  );
  return {
    people: rows,
    remaining: rows.reduce((n, p) => n + p.remaining, 0),
    missing: rows.reduce((n, p) => n + p.missing, 0),
    unknownHierarchy,
  };
}

export function burndown(observations: SprintObservation[], timeZone: string) {
  let previous: SprintObservation | undefined;
  return [...observations]
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    .map((observation) => {
      const issues = observation.issues.filter(
        (issue) => issue.hierarchyLevel === 0,
      );
      const prior = new Map(
        previous?.issues
          .filter((issue) => issue.hierarchyLevel === 0)
          .map((issue) => [issue.id, issue]) ?? [],
      );
      const current = new Map(issues.map((issue) => [issue.id, issue]));
      let added = 0,
        removed = 0,
        estimateChange = 0,
        completed = 0;
      for (const issue of issues) {
        const before = prior.get(issue.id);
        if (!before) {
          if (previous && validEstimate(issue.estimate))
            added += issue.estimate;
          continue;
        }
        if (!validEstimate(before.estimate) || !validEstimate(issue.estimate))
          continue;
        estimateChange += issue.estimate - before.estimate;
        if (issue.estimate !== before.estimate) continue;
        if (before.statusCategory !== "done" && issue.statusCategory === "done")
          completed += issue.estimate;
        if (before.statusCategory === "done" && issue.statusCategory !== "done")
          completed -= issue.estimate;
      }
      for (const issue of prior.values())
        if (!current.has(issue.id) && validEstimate(issue.estimate))
          removed += issue.estimate;
      const day = calendarDay(observation.capturedAt, timeZone);
      const priorDay = previous
        ? calendarDay(previous.capturedAt, timeZone)
        : null;
      const point = {
        at: observation.capturedAt,
        day,
        remaining: issues
          .filter((issue) => issue.statusCategory !== "done")
          .reduce(
            (sum, issue) =>
              sum + (validEstimate(issue.estimate) ? issue.estimate : 0),
            0,
          ),
        complete:
          !!observation.estimateFieldId &&
          observation.issues.every((issue) => issue.hierarchyLevel !== null) &&
          issues.every((issue) => validEstimate(issue.estimate)),
        comparable:
          !previous || previous.estimateFieldId === observation.estimateFieldId,
        gap:
          day === null ||
          (priorDay !== null && workingDays(priorDay + 1, day) > 1),
        added,
        removed,
        estimateChange,
        completed,
      };
      previous = observation;
      return point;
    });
}

export function finishForecast(
  data: DailyData,
  sprint: Sprint,
  now: Date,
  timeZone: string,
) {
  const history = burndown(data.observations, timeZone);
  let windowStart = 0;
  history.forEach((point, index) => {
    if (!point.complete) windowStart = index + 1;
    else if (point.gap || !point.comparable) windowStart = index;
  });
  const points = history.slice(windowStart);
  const time = sprintTime(sprint, now, timeZone);
  const first = points[0],
    last = points.at(-1);
  const unavailable = (reason: string) => ({
    reason,
    rate: null,
    date: null,
    onTrack: null,
    observedSince: null,
  });
  if (!first || !last || first.day === null || last.day === null)
    return unavailable("Collecting confirmed observations.");
  if (time.days === null || time.days === 0 || time.reason)
    return unavailable(time.reason ?? "No weekdays remain in this sprint.");
  if (data.estimateFieldId !== data.observations.at(-1)?.estimateFieldId)
    return unavailable(
      "Estimate or issue-type coverage is incomplete or changed.",
    );
  if (workingDays(last.day + 1, time.today) > 1)
    return unavailable(
      "There are gaps in the observed history. Daily syncs are needed.",
    );
  const days = workingDays(first.day + 1, last.day);
  const observedDays = new Set(
    points
      .filter((p) => p.day !== null && workingDays(p.day, p.day) === 1)
      .map((p) => p.day),
  );
  if (days < 3 || observedDays.size < 4)
    return unavailable("Need at least three observed working-day intervals.");
  const completed = points.slice(1).reduce((sum, p) => sum + p.completed, 0);
  if (completed <= 0)
    return unavailable("No positive observed completion pace yet.");
  const rate = completed / days;
  const daysNeeded = Math.ceil(last.remaining / rate);
  let projected = time.today;
  // No unbounded loop when a very small observed rate predicts a distant finish.
  if (daysNeeded > 2600)
    return unavailable(
      "Observed pace is too low for a useful finish estimate.",
    );
  if (daysNeeded > 0) {
    let remaining = daysNeeded;
    while (remaining > 0) {
      if (workingDays(projected, projected)) remaining--;
      if (remaining) projected++;
    }
  }
  return {
    reason: null,
    rate,
    date: new Date(projected * DAY).toISOString().slice(0, 10),
    onTrack: projected <= time.end!,
    observedSince: first.at,
  };
}
