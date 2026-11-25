import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export const priorities = ["high", "medium", "low"] as const;
export const workloads = ["small", "medium", "large"] as const;

export type Priority = (typeof priorities)[number];
export type Workload = (typeof workloads)[number];

/** 扩展字段全部可选；老数据只有 id/title/done 时完全兼容。 */
export interface Task {
  id: string;
  title: string;
  done: boolean;
  dueDate?: string;
  priority?: Priority;
  workload?: Workload;
  parentId?: string;
}

export type TaskChanges = Partial<Omit<Task, "id">>;

/** zod 只校验既有三字段；looseObject 保留历史数据里的额外字段（含旧版自定义字段）。 */
const storedTask = z.looseObject({ id: z.string(), title: z.string(), done: z.boolean() });
const taskList = z.array(storedTask) as z.ZodType<Task[]>;

export interface TaskStore {
  list(): Task[];
  create(title: string, attrs?: TaskChanges): Task;
  update(id: string, changes: TaskChanges): Task | undefined;
  remove(id: string): boolean;
  removeMany(ids: string[]): number;
}

function compact(changes: TaskChanges): TaskChanges {
  const result: TaskChanges = {};
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) result[key as keyof TaskChanges] = value as never;
  }
  return result;
}

export function createJsonTaskStore(filename: string): TaskStore {
  function list(): Task[] {
    if (!existsSync(filename)) return [];
    return taskList.parse(JSON.parse(readFileSync(filename, "utf8")));
  }

  // 同一服务进程内同步完成读写；替换文件前，原清单始终完整可读。
  function save(tasks: Task[]) {
    mkdirSync(dirname(filename), { recursive: true });
    const temporary = filename + ".tmp";
    writeFileSync(temporary, JSON.stringify(tasks, null, 2) + "\n");
    renameSync(temporary, filename);
  }

  function removeMany(ids: string[]): number {
    const selected = new Set(ids);
    const tasks = list();
    const remaining = tasks.filter(
      (task) => !selected.has(task.id) && !selected.has(task.parentId ?? ""),
    );
    const count = tasks.length - remaining.length;
    if (count) save(remaining);
    return count;
  }

  return {
    list,
    removeMany,

    create(title, attrs = {}) {
      const task: Task = { id: randomUUID(), title, done: false, ...compact(attrs) };
      save([...list(), task]);
      return task;
    },

    update(id, changes) {
      const tasks = list();
      const task = tasks.find((item) => item.id === id);
      if (!task) return undefined;

      Object.assign(task, compact(changes));
      save(tasks);
      return task;
    },

    remove(id) {
      return removeMany([id]) > 0;
    },
  };
}
