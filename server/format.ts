import type { Task } from "./task-store.ts";

const priorityLabel: Record<string, string> = {
  high: "高优先",
  medium: "中优先",
  low: "低优先",
};

const workloadLabel: Record<string, string> = {
  small: "工作量小",
  medium: "工作量中",
  large: "工作量大",
};

export function todayISO(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export function dueLabel(task: Task): string {
  if (!task.dueDate) return "";
  const today = todayISO();
  if (task.done) return `截止 ${task.dueDate}`;
  if (task.dueDate < today) return "⚠ 已逾期";
  if (task.dueDate === today) return "今天到期";
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowISO = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
  return task.dueDate === tomorrowISO ? "明天到期" : `截止 ${task.dueDate}`;
}

function taskLine(task: Task, nest: boolean): string {
  const parts: string[] = [];
  const due = dueLabel(task);
  if (due) parts.push(due);
  if (task.priority && priorityLabel[task.priority]) parts.push(priorityLabel[task.priority]);
  if (task.workload && workloadLabel[task.workload]) parts.push(workloadLabel[task.workload]);
  const prefix = nest ? "   └ " : "";
  const status = task.done ? "☑" : "☐";
  return `${prefix}${status} ${task.title}${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
}

/** 把清单渲染成「状态一眼可见」的文本；scope 用于区分全量/待办/已完成/到期。 */
export function formatList(
  tasks: Task[],
  scope: "all" | "active" | "done" | "due" = "all",
): string {
  const today = todayISO();
  let shown = tasks;
  if (scope === "active") shown = tasks.filter((task) => !task.done);
  if (scope === "done") shown = tasks.filter((task) => task.done);
  if (scope === "due") {
    shown = tasks.filter((task) => !task.done && !!task.dueDate && task.dueDate <= today);
  }

  if (shown.length === 0) {
    if (scope === "due") return "📋 今天没有到期或逾期的任务，轻松一下。";
    if (scope === "done") return "📋 还没有已完成的任务。";
    if (scope === "active" && tasks.length > 0) return "📋 全部任务都完成啦，做得好！";
    return "📋 清单还是空的。说「帮我记一下买牛奶」就能添加第一项。";
  }

  const pending = tasks.filter((task) => !task.done).length;
  const heading =
    scope === "due"
      ? `📋 到期 / 逾期任务（${shown.length} 条）`
      : scope === "done"
        ? `📋 已完成（${shown.length} 条）`
        : `📋 当前清单（共 ${tasks.length} 条 · ${pending} 待办 / ${tasks.length - pending} 已完成）`;

  const parents = shown.filter(
    (task) => !task.parentId || !shown.some((item) => item.id === task.parentId),
  );
  const lines: string[] = [heading];
  for (const parent of parents) {
    lines.push(taskLine(parent, false));
    const children = shown.filter((task) => task.parentId === parent.id);
    for (const child of children) lines.push(taskLine(child, true));
  }
  for (const task of shown) {
    if (
      task.parentId &&
      !parents.some((parent) => parent.id === task.parentId) &&
      !lines.includes(taskLine(task, true))
    ) {
      lines.push(taskLine(task, false));
    }
  }

  return lines.join("\n");
}

/** 单条任务的补充信息，用于创建/更新后的即时反馈。 */
export function detailSuffix(task: Task): string {
  const parts: string[] = [];
  const due = dueLabel(task);
  if (due) parts.push(due);
  if (task.priority) parts.push(priorityLabel[task.priority] ?? task.priority);
  if (task.workload) parts.push(workloadLabel[task.workload] ?? task.workload);
  if (task.parentId) parts.push("子任务");
  return parts.length ? `（${parts.join(" · ")}）` : "";
}
