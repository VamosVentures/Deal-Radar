/**
 * Wall-clock scheduling for scheduled sourcing: "every Sunday at 6:00 PM
 * Central", honoring daylight saving.
 *
 * Before this (Andrew, 2026-11-19) a schedule had no day or time: the next
 * run was simply "last run + 7 days", checked hourly. So a run drifted a
 * little later every week, and a deploy or a "Run sourcing now" click moved
 * the whole schedule to whenever that happened.
 *
 * Pure functions over Intl (no timezone library), shared by the server's
 * due-check and the Settings page's "next run" display so the two can
 * never disagree.
 */

export const SCHEDULE_TIME_ZONES = [
  'America/Chicago', 'America/New_York', 'America/Denver', 'America/Los_Angeles',
] as const;
export type ScheduleTimeZone = (typeof SCHEDULE_TIME_ZONES)[number];

export const TIME_ZONE_LABELS: Record<ScheduleTimeZone, string> = {
  'America/Chicago': 'Central',
  'America/New_York': 'Eastern',
  'America/Denver': 'Mountain',
  'America/Los_Angeles': 'Pacific',
};

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** Run times are on the quarter hour — the scheduler checks every 15 minutes, on the quarter hour. */
export const RUN_TIME_PATTERN = /^([01]\d|2[0-3]):(00|15|30|45)$/;

export const DEFAULT_RUN_DAY = 0; // Sunday
export const DEFAULT_RUN_TIME = '18:00';
export const DEFAULT_TIME_ZONE: ScheduleTimeZone = 'America/Chicago';

interface WallParts { y: number; m: number; d: number; h: number; mi: number; s: number }

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall-clock date and time at `instant` in `tz`. */
function wallParts(instant: number, tz: string): WallParts {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

/** How far `tz` is ahead of UTC at `instant`, in ms (negative in the Americas). */
function offsetAt(instant: number, tz: string): number {
  const w = wallParts(instant, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `tz` reads y-m-d h:mi. Two passes
 * so the offset used is the one in force at the answer, not at the guess —
 * which is what makes a Sunday right after a daylight-saving change land on
 * the right hour.
 */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - offsetAt(guess, tz);
  return guess - offsetAt(first, tz);
}

export interface RunSlot { runDay: number; runTime: string; timeZone: string }

function slotOn(dayOffset: number, today: WallParts, slot: RunSlot): number | null {
  const date = new Date(Date.UTC(today.y, today.m - 1, today.d + dayOffset));
  if (date.getUTCDay() !== slot.runDay) return null;
  const [h, mi] = slot.runTime.split(':').map(Number);
  return zonedToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), h, mi, slot.timeZone);
}

/** The most recent scheduled start at or before `now` (ms since epoch). */
export function latestSlot(now: number, slot: RunSlot): number {
  const today = wallParts(now, slot.timeZone);
  for (let k = 0; k <= 7; k += 1) {
    const at = slotOn(-k, today, slot);
    if (at !== null && at <= now) return at;
  }
  throw new Error('unreachable: every week has the run day');
}

/** The next scheduled start strictly after `now` (ms since epoch). */
export function nextSlot(now: number, slot: RunSlot): number {
  const today = wallParts(now, slot.timeZone);
  for (let k = 0; k <= 7; k += 1) {
    const at = slotOn(k, today, slot);
    if (at !== null && at > now) return at;
  }
  throw new Error('unreachable: every week has the run day');
}

/** "6:00 PM" from "18:00". */
export function formatRunTime(runTime: string): string {
  const [h, mi] = runTime.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Sun, Nov 23, 6:00 PM Central" — an instant shown in the schedule's own time zone. */
export function formatInZone(instant: number | string, tz: ScheduleTimeZone): string {
  const text = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(instant));
  return `${text} ${TIME_ZONE_LABELS[tz]}`;
}
