import { describe, expect, it } from "vitest";
import {
  burndown,
  calendarDay,
  finishForecast,
  nextSprint,
  sprintTime,
  workload,
  workingDays,
} from "./daily";
import type {
  DailyData,
  IssueSummary,
  Sprint,
  SprintObservation,
} from "./workspace";

const sprint: Sprint = {
  id: 1,
  name: "Sprint",
  state: "active",
  startDate: "2026-09-21",
  endDate: "2026-10-02",
};
const item = (
  id: string,
  statusCategory = "new",
  estimate: number | null = 2,
) => ({ id, statusCategory, estimate, hierarchyLevel: 0 });
const observation = (
  date: string,
  issues: SprintObservation["issues"],
): SprintObservation => ({
  capturedAt: `${date}T09:00:00Z`,
  estimateFieldId: "points",
  estimateLabel: "Story Points",
  issues,
});
const data = (observations: SprintObservation[] = []): DailyData => ({
  sprintId: 1,
  estimateFieldId: "points",
  estimateLabel: "Story Points",
  issues: [],
  observations,
});

describe("Daily evidence", () => {
  it("counts weekdays in the displayed timezone and handles missing/ended dates", () => {
    expect(
      sprintTime(sprint, new Date("2026-09-28T01:00:00Z"), "UTC").days,
    ).toBe(5);
    expect(calendarDay("2026-09-28T01:00:00Z", "America/Los_Angeles")).toBe(
      calendarDay("2026-09-27", "UTC"),
    );
    expect(
      workingDays(
        calendarDay("2026-09-25", "UTC")!,
        calendarDay("2026-09-28", "UTC")!,
      ),
    ).toBe(2);
    expect(
      sprintTime({ ...sprint, endDate: null }, new Date(), "UTC").days,
    ).toBeNull();
    expect(sprintTime(sprint, new Date("2026-10-05"), "UTC").days).toBe(0);
    expect(calendarDay("2026-02-30", "UTC")).toBeNull();
  });
  it("never turns removed scope or reduced estimates into completed work", () => {
    const result = burndown(
      [
        observation("2026-09-21", [
          item("removed"),
          item("done"),
          item("reestimated", "new", 5),
        ]),
        observation("2026-09-22", [
          item("done", "done"),
          item("reestimated", "new", 3),
        ]),
        observation("2026-09-23", [
          item("done", "new"),
          item("reestimated", "new", 3),
        ]),
      ],
      "UTC",
    );
    expect(result[1]).toMatchObject({
      removed: 2,
      completed: 2,
      estimateChange: -2,
      remaining: 3,
    });
    expect(result[2].completed).toBe(-2);
  });
  it("requires distinct complete daily observations and suppresses gaps and missing estimates", () => {
    const observations = [21, 22, 23, 24].map((day, index) =>
      observation(
        `2026-09-${day}`,
        [0, 1, 2, 3, 4].map((n) => item(String(n), n < index ? "done" : "new")),
      ),
    );
    expect(
      finishForecast(
        data(observations),
        sprint,
        new Date("2026-09-24T10:00:00Z"),
        "UTC",
      ),
    ).toMatchObject({ rate: 2, date: "2026-09-25", onTrack: true });
    expect(
      finishForecast(
        data([observations[0], observations[3]]),
        sprint,
        new Date("2026-09-24"),
        "UTC",
      ).rate,
    ).toBeNull();
    const missing = structuredClone(observations);
    missing[2].issues[0].estimate = null;
    expect(
      finishForecast(data(missing), sprint, new Date("2026-09-24"), "UTC").rate,
    ).toBeNull();
    expect(
      finishForecast(
        data(Array(4).fill(observations[0])),
        sprint,
        new Date("2026-09-21"),
        "UTC",
      ).rate,
    ).toBeNull();
    expect(
      finishForecast(data(observations), sprint, new Date("2026-09-29"), "UTC")
        .rate,
    ).toBeNull();
  });
  it("aggregates all supplied standard issues, separates unknown hierarchy, and keeps missing estimates unknown", () => {
    const full = data();
    full.issues = Array.from({ length: 150 }, (_, n) => ({
      hierarchyLevel: 0,
      issue: {
        id: String(n),
        key: `CK-${n}`,
        summary: "Work",
        status: { id: "1", name: "To do", category: "new" },
        assignee: null,
        storyPoints: n === 0 ? null : 2,
        sprintIds: [1],
        issueType: "Task",
        priority: null,
        versions: [],
        epic: null,
        updated: "",
        offBoard: false,
      } satisfies IssueSummary,
    }));
    full.issues.push(
      { ...full.issues[0], hierarchyLevel: 1 },
      { ...full.issues[0], hierarchyLevel: -1 },
    );
    full.issues.push({
      ...full.issues[0],
      hierarchyLevel: null,
    } as DailyData["issues"][number]);
    expect(workload(full)).toMatchObject({
      remaining: 298,
      missing: 1,
      unknownHierarchy: 1,
    });
    expect(workload(full).people[0]).toMatchObject({
      name: "Unassigned",
      todo: 150,
    });
  });
  it("recovers a forecast after an old gap once a complete observation window exists", () => {
    const recent = [25, 28, 29, 30].map((day, index) =>
      observation(
        `2026-09-${day}`,
        [0, 1, 2, 3, 4].map((n) => item(String(n), n < index ? "done" : "new")),
      ),
    );
    const old = observation("2026-09-21", [item("unknown", "new", null)]);
    expect(
      finishForecast(
        data([old, ...recent]),
        sprint,
        new Date("2026-09-30"),
        "UTC",
      ),
    ).toMatchObject({
      rate: 2,
      date: "2026-10-01",
      observedSince: "2026-09-25T09:00:00Z",
    });
  });
  it("does not guess among undated or tied next sprints", () => {
    const future: Sprint = {
      id: 2,
      name: "Next",
      state: "future",
      startDate: "2026-10-05",
    };
    expect(nextSprint(sprint, [future])).toBe(2);
    expect(nextSprint(sprint, [future, { ...future, id: 3 }])).toBeNull();
    expect(
      nextSprint(sprint, [
        future,
        { ...future, id: 3, startDate: "2026-10-05T02:00:00+02:00" },
      ]),
    ).toBeNull();
    expect(
      nextSprint(sprint, [future, { ...future, id: 3, startDate: null }]),
    ).toBeNull();
  });
});
