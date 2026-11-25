import { z } from "zod";
import type { Task } from "./task-store.ts";
import { todayISO } from "./task-view.ts";

export const periods = ["today", "tomorrow", "this_week", "next_week", "this_month"] as const;
export const taskQuerySchema = z
  .object({
    filter: z.enum(["all", "pending", "done"]).optional(),
    dueToday: z.boolean().optional(),
    overdue: z.boolean().optional(),
    dueFrom: z.iso.date().optional(),
    dueTo: z.iso.date().optional(),
    period: z.enum(periods).optional(),
  })
  .refine((q) => !q.dueFrom || !q.dueTo || q.dueFrom <= q.dueTo)
  .refine((q) => !q.period || (!q.dueFrom && !q.dueTo));
export type TaskQuery = z.infer<typeof taskQuerySchema>;

/** 将上海日历日期放入 UTC 运算，避免机器时区或夏令时改变日期。 */
function dateRange(period: NonNullable<TaskQuery["period"]>, today: string): [string, string] {
  const date = new Date(today + "T00:00:00Z");
  const iso = (value: Date) => value.toISOString().slice(0, 10);
  const shift = (days: number) => new Date(date.getTime() + days * 86_400_000);
  if (period === "today") return [today, today];
  if (period === "tomorrow") return [iso(shift(1)), iso(shift(1))];
  if (period === "this_month") {
    return [
      iso(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))),
      iso(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))),
    ];
  }
  const mondayOffset = -((date.getUTCDay() + 6) % 7) + (period === "next_week" ? 7 : 0);
  return [iso(shift(mondayOffset)), iso(shift(mondayOffset + 6))];
}

export function queryTasks(tasks: Task[], query: TaskQuery, now: () => Date): Task[] {
  const today = todayISO(now);
  const [from, to] = query.period ? dateRange(query.period, today) : [query.dueFrom, query.dueTo];
  const selected = tasks.filter((task) => {
    if (query.filter === "pending" && task.done) return false;
    if (query.filter === "done" && !task.done) return false;
    if (query.dueToday || query.overdue) {
      if (
        task.done ||
        !task.dueDate ||
        !((query.dueToday && task.dueDate === today) || (query.overdue && task.dueDate < today))
      )
        return false;
    }
    if (from || to) {
      if (!task.dueDate || (query.filter === undefined && task.done)) return false;
      if (from && task.dueDate < from) return false;
      if (to && task.dueDate > to) return false;
    }
    return true;
  });
  return [...selected.filter((task) => !task.done), ...selected.filter((task) => task.done)];
}
