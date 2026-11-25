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

export class TaskRelationError extends Error {}

/** 兼容历史深层关系；迭代遍历并去重，循环关系也能安全终止。 */
export function tasksAffectedByDeletion(tasks: Task[], ids: string[]): Task[] {
  const selected = new Set(ids);
  const children = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.parentId !== undefined) {
      const siblings = children.get(task.parentId) ?? [];
      siblings.push(task.id);
      children.set(task.parentId, siblings);
    }
  }
  const queue = [...selected];
  for (let index = 0; index < queue.length; index += 1) {
    for (const id of children.get(queue[index]) ?? []) {
      if (!selected.has(id)) {
        selected.add(id);
        queue.push(id);
      }
    }
  }
  return tasks.filter((task) => selected.has(task.id));
}

function validateParent(tasks: Task[], id: string, parentId: string | undefined) {
  if (parentId === undefined) return;
  if (id === parentId) throw new TaskRelationError("任务不能把自己设为父任务。");
  const parent = tasks.find((task) => task.id === parentId);
  if (!parent) throw new TaskRelationError("父任务不存在，请先查看清单确认父任务。");
  if (parent.parentId !== undefined || tasks.some((task) => task.parentId === id)) {
    throw new TaskRelationError("暂不支持更深层级的子任务；含子任务的任务不能再设为子任务。");
  }
}

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
    const tasks = list();
    const selected = new Set(tasksAffectedByDeletion(tasks, ids).map((task) => task.id));
    const remaining = tasks.filter((task) => !selected.has(task.id));
    const count = tasks.length - remaining.length;
    if (count) save(remaining);
    return count;
  }

  return {
    list,
    removeMany,

    create(title, attrs = {}) {
      const task: Task = { id: randomUUID(), title, done: false, ...compact(attrs) };
      const tasks = list();
      validateParent(tasks, task.id, task.parentId);
      save([...tasks, task]);
      return task;
    },

    update(id, changes) {
      const tasks = list();
      const task = tasks.find((item) => item.id === id);
      if (!task) return undefined;

      validateParent(tasks, id, changes.parentId);
      Object.assign(task, compact(changes));
      save(tasks);
      return task;
    },

    remove(id) {
      return removeMany([id]) > 0;
    },
  };
}
