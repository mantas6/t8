/**
 * `:snooze <when>`: parses a wake time relative to `now`, and the presets the
 * snooze picker offers. Pure; local time throughout, with calendar-day steps
 * (not 24-hour ones) so DST changes do not shift the clock time.
 *
 * Grammar (case-insensitive):
 * - durations: `30m`, `2h`, `3d`, `1w`, combined `1h30m`; units `m` `min`
 *   `h` `hr` `d` `w`, optionally spaced (`2 h`)
 * - a clock time: `18:00`, `9:30` (today, or tomorrow if it has passed)
 * - `tomorrow` (09:00), `mon`..`sun` / `monday`..`sunday` (the next such day,
 *   never today, at 09:00); either may take a time: `tomorrow 14:00`, `fri 17:30`
 * - ISO dates: `2026-11-20` (09:00), `2026-11-20T15:00`, `2026-11-20 15:00`,
 *   and with a zone `2026-11-20T15:00Z` / `+02:00`
 */

/** Morning wake time for day-only forms, like upstream's snooze presets. */
export const MORNING_HOUR = 9;
export const EVENING_HOUR = 18;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export type WhenResult =
  | { readonly ok: true; readonly date: Date }
  | { readonly ok: false; readonly error: string };

export const WHEN_USAGE = "30m 2h 3d 1w · 18:00 · tomorrow · mon..sun · 2026-11-20T15:00";

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const WEEKDAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function addDays(base: Date, days: number): Date {
  const next = new Date(base.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function atTime(base: Date, hours: number, minutes: number): Date {
  const next = new Date(base.getTime());
  next.setHours(hours, minutes, 0, 0);
  return next;
}

function weekdayIndex(word: string): number {
  const short = WEEKDAYS.indexOf(word as (typeof WEEKDAYS)[number]);
  if (short !== -1) return short;
  return WEEKDAY_NAMES.indexOf(word);
}

/** `HH:MM` as hours and minutes, or null. */
function parseClock(text: string): { hours: number; minutes: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

const UNIT_MS: Readonly<Record<string, number | "day" | "week">> = {
  m: MINUTE_MS,
  min: MINUTE_MS,
  h: HOUR_MS,
  hr: HOUR_MS,
  d: "day",
  w: "week",
};

function parseDuration(text: string, now: Date): Date | null {
  const compact = text.replace(/\s+/g, "");
  if (!/^(\d+(min|hr|m|h|d|w))+$/.test(compact)) return null;
  let date = new Date(now.getTime());
  let total = 0;
  for (const [, amountText, unit] of compact.matchAll(/(\d+)(min|hr|m|h|d|w)/g)) {
    const amount = Number(amountText);
    const step = UNIT_MS[unit ?? ""];
    total += amount;
    if (step === "day") date = addDays(date, amount);
    else if (step === "week") date = addDays(date, 7 * amount);
    else if (step !== undefined) date = new Date(date.getTime() + amount * step);
  }
  return total > 0 ? date : null;
}

/** Local ISO forms (no zone): built from parts, so a rolled-over date (Feb 30) is rejected. */
function parseIso(text: string): Date | null | "invalid" {
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (local !== null) {
    const [year, month, day] = [Number(local[1]), Number(local[2]), Number(local[3])];
    const hasTime = local[4] !== undefined;
    const hours = hasTime ? Number(local[4]) : MORNING_HOUR;
    const minutes = hasTime ? Number(local[5]) : 0;
    const seconds = local[6] === undefined ? 0 : Number(local[6]);
    const date = new Date(year, month - 1, day, hours, minutes, seconds, 0);
    const exact =
      date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day &&
      date.getHours() === hours &&
      date.getMinutes() === minutes;
    return exact ? date : "invalid";
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const parsed = Date.parse(text.replace(" ", "T").toUpperCase());
    return Number.isNaN(parsed) ? "invalid" : new Date(parsed);
  }
  return null;
}

/** Parses a wake time; it must be in the future. */
export function parseWhen(input: string, now: Date): WhenResult {
  const text = input.trim().toLowerCase();
  if (text === "") return { ok: false, error: `when? ${WHEN_USAGE}` };
  const fail = (): WhenResult => ({
    ok: false,
    error: `cannot read "${input.trim()}": try ${WHEN_USAGE}`,
  });
  const future = (date: Date): WhenResult =>
    date.getTime() > now.getTime()
      ? { ok: true, date }
      : { ok: false, error: `${formatWake(date, now)} has already passed` };

  const iso = parseIso(text);
  if (iso === "invalid") return { ok: false, error: `no such date: ${input.trim()}` };
  if (iso !== null) return future(iso);

  const duration = parseDuration(text, now);
  if (duration !== null) return future(duration);

  const clock = parseClock(text);
  if (clock !== null) {
    const today = atTime(now, clock.hours, clock.minutes);
    return future(today.getTime() > now.getTime() ? today : addDays(today, 1));
  }

  const [dayWord, timeWord, ...rest] = text.split(/\s+/);
  if (dayWord === undefined || rest.length > 0) return fail();
  const time = timeWord === undefined ? { hours: MORNING_HOUR, minutes: 0 } : parseClock(timeWord);
  if (time === null) return fail();
  if (dayWord === "tomorrow") return future(atTime(addDays(now, 1), time.hours, time.minutes));
  if (dayWord === "today") return future(atTime(now, time.hours, time.minutes));
  const weekday = weekdayIndex(dayWord);
  if (weekday === -1) return fail();
  const ahead = (weekday - now.getDay() + 7) % 7 || 7;
  return future(atTime(addDays(now, ahead), time.hours, time.minutes));
}

const pad = (value: number) => String(value).padStart(2, "0");

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * A wake time for notices: `18:00` today, `tomorrow 09:00`, `Tue 09:00`
 * within a week, else `Nov 20 09:00` (with the year when it differs).
 */
export function formatWake(date: Date, now: Date): string {
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (sameDay(date, now)) return time;
  if (sameDay(date, addDays(now, 1))) return `tomorrow ${time}`;
  const weekday = WEEKDAYS[date.getDay()] ?? "";
  const days = (atTime(date, 0, 0).getTime() - atTime(now, 0, 0).getTime()) / (24 * HOUR_MS);
  if (days > 0 && days < 6.5)
    return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${time}`;
  const year = date.getFullYear() === now.getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}${year} ${time}`;
}

export interface SnoozePreset {
  readonly id: "hour" | "three-hours" | "evening" | "tomorrow" | "next-monday";
  readonly label: string;
  readonly until: Date;
}

/**
 * The snooze picker's presets, as upstream's web app offers them: in 1 hour,
 * in 3 hours, this evening (while 18:00 is more than an hour away), tomorrow
 * morning, and next Monday morning (unless that is tomorrow).
 */
export function snoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const presets: SnoozePreset[] = [
    { id: "hour", label: "in 1 hour", until: new Date(now.getTime() + HOUR_MS) },
    { id: "three-hours", label: "in 3 hours", until: new Date(now.getTime() + 3 * HOUR_MS) },
  ];
  const evening = atTime(now, EVENING_HOUR, 0);
  if (evening.getTime() - now.getTime() > HOUR_MS) {
    presets.push({ id: "evening", label: "this evening", until: evening });
  }
  const tomorrow = atTime(addDays(now, 1), MORNING_HOUR, 0);
  presets.push({ id: "tomorrow", label: "tomorrow morning", until: tomorrow });
  const monday = atTime(addDays(now, (1 - now.getDay() + 7) % 7 || 7), MORNING_HOUR, 0);
  if (monday.getTime() !== tomorrow.getTime()) {
    presets.push({ id: "next-monday", label: "next Monday", until: monday });
  }
  return presets;
}
