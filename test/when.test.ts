import { describe, expect, test } from "bun:test";

import { formatWake, parseWhen, snoozePresets } from "../src/tui/when.ts";

// Local time, so the tests pass in any time zone. Mon 2 Nov 2026, 10:15.
const NOW = new Date(2026, 10, 2, 10, 15, 0, 0);
const local = (month: number, day: number, hours: number, minutes = 0) =>
  new Date(2026, month - 1, day, hours, minutes, 0, 0);

function parsed(input: string, now = NOW): Date {
  const result = parseWhen(input, now);
  if (!result.ok) throw new Error(`"${input}": ${result.error}`);
  return result.date;
}

function error(input: string, now = NOW): string {
  const result = parseWhen(input, now);
  if (result.ok) throw new Error(`"${input}" parsed as ${result.date.toISOString()}`);
  return result.error;
}

describe("parseWhen", () => {
  test("durations", () => {
    expect(parsed("30m")).toEqual(local(11, 2, 10, 45));
    expect(parsed("45min")).toEqual(local(11, 2, 11, 0));
    expect(parsed("2h")).toEqual(local(11, 2, 12, 15));
    expect(parsed("2 h")).toEqual(local(11, 2, 12, 15));
    expect(parsed("1h30m")).toEqual(local(11, 2, 11, 45));
    expect(parsed("3d")).toEqual(local(11, 5, 10, 15));
    expect(parsed("1w")).toEqual(local(11, 9, 10, 15));
    expect(parsed("2W")).toEqual(local(11, 16, 10, 15));
  });

  test("clock times: today, or tomorrow once passed", () => {
    expect(parsed("18:00")).toEqual(local(11, 2, 18));
    expect(parsed("9:30")).toEqual(local(11, 3, 9, 30));
    expect(parsed("10:15")).toEqual(local(11, 3, 10, 15));
    expect(error("25:00")).toContain("cannot read");
  });

  test("tomorrow and weekdays, at 09:00 unless a time is given", () => {
    expect(parsed("tomorrow")).toEqual(local(11, 3, 9));
    expect(parsed("Tomorrow 14:30")).toEqual(local(11, 3, 14, 30));
    expect(parsed("today 18:00")).toEqual(local(11, 2, 18));
    expect(parsed("tue")).toEqual(local(11, 3, 9));
    expect(parsed("fri")).toEqual(local(11, 6, 9));
    expect(parsed("friday 17:30")).toEqual(local(11, 6, 17, 30));
    expect(parsed("sun")).toEqual(local(11, 8, 9));
    // Never today: on a Monday, "mon" is next week's.
    expect(parsed("mon")).toEqual(local(11, 9, 9));
  });

  test("ISO dates and datetimes", () => {
    expect(parsed("2026-11-20")).toEqual(local(11, 20, 9));
    expect(parsed("2026-11-20T15:00")).toEqual(local(11, 20, 15));
    expect(parsed("2026-11-20 15:00")).toEqual(local(11, 20, 15));
    expect(parsed("2026-11-20T15:00:30")).toEqual(new Date(2026, 10, 20, 15, 0, 30));
    expect(parsed("2026-11-20T15:00:00Z")).toEqual(new Date(Date.UTC(2026, 10, 20, 15)));
    expect(parsed("2026-11-20T15:00+02:00")).toEqual(new Date(Date.UTC(2026, 10, 20, 13)));
    expect(error("2026-02-30")).toContain("no such date");
  });

  test("the past and nonsense are refused", () => {
    expect(error("2026-11-01")).toContain("has already passed");
    expect(error("today 08:00")).toContain("has already passed");
    expect(error("")).toContain("when?");
    expect(error("0m")).toContain("cannot read");
    expect(error("soon")).toContain("cannot read");
    expect(error("tomorrow noon")).toContain("cannot read");
    expect(error("mon 9:00 extra")).toContain("cannot read");
  });
});

describe("formatWake", () => {
  test("today, tomorrow, this week, later", () => {
    expect(formatWake(local(11, 2, 18), NOW)).toBe("18:00");
    expect(formatWake(local(11, 3, 9), NOW)).toBe("tomorrow 09:00");
    expect(formatWake(local(11, 4, 9, 5), NOW)).toBe("Wed 09:05");
    expect(formatWake(local(11, 8, 9), NOW)).toBe("Sun 09:00");
    expect(formatWake(local(11, 9, 9), NOW)).toBe("Nov 9 09:00");
    expect(formatWake(new Date(2027, 0, 4, 9), NOW)).toBe("Jan 4 2027 09:00");
  });
});

describe("snoozePresets", () => {
  const summary = (now: Date) =>
    snoozePresets(now).map((preset) => `${preset.label}: ${formatWake(preset.until, now)}`);

  test("a Monday morning: 1h, 3h, this evening, tomorrow, next Monday", () => {
    expect(summary(NOW)).toEqual([
      "in 1 hour: 11:15",
      "in 3 hours: 13:15",
      "this evening: 18:00",
      "tomorrow morning: tomorrow 09:00",
      "next Monday: Nov 9 09:00",
    ]);
  });

  test("no evening within the hour before 18:00; no next Monday on a Sunday", () => {
    const sunday = new Date(2026, 10, 8, 17, 30);
    expect(summary(sunday)).toEqual([
      "in 1 hour: 18:30",
      "in 3 hours: 20:30",
      "tomorrow morning: tomorrow 09:00",
    ]);
  });
});
