import type { Task } from "./task-store.ts";

export function todayISO(now: () => Date): string {
  return now().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

function taskLine(task: Task, today: string): string {
  const tags: string[] = [];
  if (task.dueDate) {
    if (!task.done && task.dueDate < today) tags.push("已逾期");
    if (!task.done && task.dueDate === today) tags.push("今天到期");
    tags.push(`截止 ${task.dueDate}`);
  }
  if (task.priority) tags.push(`优先级 ${task.priority}`);
  if (task.workload) tags.push(`工作量 ${task.workload}`);
  if (task.parentId) tags.push("子任务");
  return `${task.done ? "✅" : "⬜"} ${task.title}${tags.length ? " · " + tags.join(" · ") : ""}`;
}

/** 每条任务只归一组；历史数据不补写默认字段。 */
export function summaryOf(tasks: Task[], now: () => Date = () => new Date()): string {
  const today = todayISO(now);
  const pending = tasks.filter((task) => !task.done);
  const overdue = (task: Task) => !!task.dueDate && task.dueDate < today;
  const groups: Array<[string, Task[]]> = [
    ["待处理", pending.filter((task) => !overdue(task))],
    ["已逾期", pending.filter(overdue)],
    ["已完成", tasks.filter((task) => task.done)],
  ];
  const lines = [`共 ${tasks.length} 项，未完成 ${pending.length} 项。`];
  for (const [name, items] of groups) {
    lines.push(`📋 ${name}（${items.length}）`);
    lines.push(
      ...(items.length ? items.map((task) => taskLine(task, today)) : [`暂无${name}任务`]),
    );
  }
  return lines.join("\n");
}
