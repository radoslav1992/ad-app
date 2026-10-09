import { z } from "zod";

// A workspace's posting rhythm: daily times in its own time zone on chosen weekdays. Approved posts can drop into the
// next free time automatically (Blitz), or be placed by hand on the calendar.
export const scheduleSchema = z.object({
  timezone: z.string().min(1).max(64).default("UTC"),
  /** "HH:MM", 24-hour, in `timezone`. */
  times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).max(12).default(["09:00", "18:00"]),
  /** 0 = Sunday … 6 = Saturday. */
  days: z.array(z.number().int().min(0).max(6)).max(7).default([0, 1, 2, 3, 4, 5, 6]),
  /** Approving a post in Blitz also schedules it in the next free slot on the default accounts. */
  autoSchedule: z.boolean().default(false),
  /** Accounts approved posts go to by default. */
  accounts: z.array(z.uuid()).max(100).default([]),
});
export type Schedule = z.infer<typeof scheduleSchema>;
/** Automations: fresh posts for review every day, without asking. */
export const automationSchema = z.object({
  enabled: z.boolean().default(false),
  /** New posts made each day (when fewer than `postsPerDay * 2` are still waiting for review). */
  postsPerDay: z.number().int().min(1).max(10).default(3),
  /** May the automation spend AI credits (AI images, talking creators)? */
  useCredits: z.boolean().default(false),
});
export type Automation = z.infer<typeof automationSchema>;
export const settingsSchema = z.object({
  schedule: scheduleSchema.default(scheduleSchema.parse({})),
  /** Formats Blitz and automations make. */
  formats: z.array(z.enum(["slideshow", "text", "hook_demo", "green_screen", "ugc", "story"])).min(1).max(6).default(["slideshow", "text"]),
  automation: automationSchema.default(automationSchema.parse({})),
  /** A small brand mark in the corner of every video (empty: none). */
  watermark: z.string().trim().max(40).default(""),
});
export type WorkspaceSettings = z.infer<typeof settingsSchema>;
export const defaultSettings = (): WorkspaceSettings => settingsSchema.parse({});

/** Whether `tz` is a time zone this runtime knows. */
export function validZone(tz: string) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
/** The wall-clock parts of a moment in a time zone. */
function parts(at: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(new Date(at * 1000)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}
/** Unix seconds of a wall-clock time in a time zone (handles DST by correcting the offset once). */
export function zonedTime(y: number, m: number, d: number, h: number, min: number, tz: string) {
  const guess = Date.UTC(y, m - 1, d, h, min) / 1000;
  const p = parts(guess, tz);
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) / 1000 - guess;
  const first = guess - offset;
  const q = parts(first, tz);
  const offset2 = Date.UTC(q.y, q.m - 1, q.d, q.h, q.min, q.s) / 1000 - first;
  return guess - offset2;
}
/**
 * The posting slots from `from` (unix seconds) on, in order, for `days` days ahead: every chosen time on every chosen
 * weekday in the schedule's time zone.
 */
export function slots(schedule: Schedule, from: number, days = 60) {
  const tz = validZone(schedule.timezone) ? schedule.timezone : "UTC";
  const out: number[] = [];
  const start = parts(from, tz);
  const times = [...schedule.times].sort();
  for (let i = 0; i <= days && times.length && schedule.days.length; i++) {
    const date = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    if (!schedule.days.includes(date.getUTCDay())) continue;
    for (const t of times) {
      const [h, min] = t.split(":").map(Number);
      const at = zonedTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), h, min, tz);
      if (at > from) out.push(at);
    }
  }
  return out;
}
/** The first slot after `from` that no scheduled post already takes (within 10 minutes). */
export function nextFreeSlot(schedule: Schedule, from: number, taken: number[]) {
  return slots(schedule, from).find((s) => !taken.some((t) => Math.abs(t - s) < 600)) ?? null;
}
