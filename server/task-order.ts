import type { Task } from "./task-store.ts";

export type TaskSort = "priority" | "dueDate" | "created";
const rank = { high: 0, medium: 1, low: 2 };

/** JS 稳定排序保留存储中的创建顺序；不补写旧字段。 */
export function sortTasks(tasks: Task[], sort: TaskSort = "priority"): Task[] {
  return tasks.toSorted((a, b) => {
    const status = Number(a.done) - Number(b.done);
    if (status || sort === "created") return status;
    if (sort === "priority") {
      const priority = (rank[a.priority ?? "medium"] ?? 1) - (rank[b.priority ?? "medium"] ?? 1);
      if (priority) return priority;
    }
    const first = a.dueDate || "\uffff";
    const second = b.dueDate || "\uffff";
    return first < second ? -1 : first > second ? 1 : 0;
  });
}
