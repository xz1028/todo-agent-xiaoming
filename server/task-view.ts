import { sortTasks, type TaskSort } from "./task-order.ts";
import type { Task } from "./task-store.ts";

export function todayISO(now: () => Date): string {
  return now().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

function taskLine(task: Task, today: string, children: Task[], parentLabel?: string): string {
  const tags: string[] = [];
  if (children.length)
    tags.push(`${children.filter((child) => child.done).length}/${children.length} 已完成`);
  if (task.dueDate) {
    if (!task.done && task.dueDate < today) tags.push("已逾期");
    if (!task.done && task.dueDate === today) tags.push("今天到期");
    tags.push(`截止 ${task.dueDate}`);
  }
  if (task.priority) tags.push(`优先级 ${task.priority}`);
  if (task.workload) tags.push(`工作量 ${task.workload}`);
  if (task.parentId) tags.push("子任务");
  if (parentLabel) tags.push(parentLabel);
  return `${task.done ? "✅" : "⬜"} ${task.title}${tags.length ? " · " + tags.join(" · ") : ""}`;
}

/** 每条任务只归一组；历史数据不补写默认字段。 */
export function summaryOf(
  tasks: Task[],
  now: () => Date = () => new Date(),
  allTasks: Task[] = tasks,
  sort: TaskSort = "priority",
): string {
  const today = todayISO(now);
  const byId = new Map(allTasks.map((task) => [task.id, task]));
  const children = new Map<string, Task[]>();
  for (const task of allTasks) {
    if (task.parentId !== undefined) {
      const list = children.get(task.parentId) ?? [];
      list.push(task);
      children.set(task.parentId, list);
    }
  }
  const ordered = sortTasks(tasks, sort);
  const pending = ordered.filter((task) => !task.done);
  const overdue = (task: Task) => !!task.dueDate && task.dueDate < today;
  const groups: Array<[string, Task[]]> = [
    ["待处理", pending.filter((task) => !overdue(task))],
    ["已逾期", pending.filter(overdue)],
    ["已完成", ordered.filter((task) => task.done)],
  ];
  const lines = [`共 ${tasks.length} 项，未完成 ${pending.length} 项。`];
  for (const [name, items] of groups) {
    lines.push(`📋 ${name}（${items.length}）`);
    if (!items.length) {
      lines.push(`暂无${name}任务`);
      continue;
    }
    const local = new Map(items.map((task) => [task.id, task]));
    const visited = new Set<string>();
    const roots = items.filter((task) => !local.has(task.parentId ?? ""));
    for (const root of [...roots, ...items]) {
      const stack = [{ task: root, depth: root.parentId && !local.has(root.parentId) ? 1 : 0 }];
      while (stack.length) {
        const { task, depth } = stack.pop()!;
        if (visited.has(task.id)) continue;
        visited.add(task.id);
        const parent = task.parentId ? byId.get(task.parentId) : undefined;
        const label =
          task.parentId && !local.has(task.parentId)
            ? parent
              ? `父任务：${parent.title}`
              : "父任务不在清单中"
            : undefined;
        lines.push(
          "  ".repeat(Math.min(depth, 4)) +
            taskLine(task, today, children.get(task.id) ?? [], label),
        );
        const visibleChildren = sortTasks(
          (children.get(task.id) ?? []).filter((child) => local.has(child.id)),
          sort,
        );
        for (const child of visibleChildren.toReversed())
          stack.push({ task: child, depth: depth + 1 });
      }
    }
  }
  return lines.join("\n");
}
