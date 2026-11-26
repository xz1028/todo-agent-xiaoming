import { createHash, randomUUID } from "node:crypto";
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

export interface TrashEntry {
  id: string;
  deletedAt: string;
  tasks: Task[];
}
export interface ImportPreview {
  added: number;
  skipped: number;
  token: string;
}
const envelopeSchema = z.object({
  version: z.literal(1),
  tasks: taskList,
  trash: z.array(z.object({ id: z.string(), deletedAt: z.string(), tasks: taskList })),
});
const importList = z
  .array(
    z.looseObject({
      id: z.string().min(1).max(200),
      title: z.string().trim().min(1).max(200),
      done: z.boolean(),
      dueDate: z.iso.date().optional(),
      priority: z.enum(priorities).optional(),
      workload: z.enum(workloads).optional(),
      effort: z.enum(workloads).optional(),
      parentId: z.string().min(1).optional(),
    }),
  )
  .max(1000);

export interface TaskStore {
  trash(): TrashEntry[];
  restore(id: string): Task[];
  previewImport(input: unknown): ImportPreview;
  importTasks(input: unknown, token: string): ImportPreview;
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

/** 非空子任务集合决定父状态；visited 兼容历史循环，单次操作只落盘一次。 */
function syncParents(tasks: Task[], parentId?: string, sourceId?: string) {
  const visited = new Set(sourceId ? [sourceId] : []);
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = tasks.find((task) => task.id === parentId);
    if (!parent) break;
    const children = tasks.filter((task) => task.parentId === parentId);
    if (children.length) parent.done = children.every((task) => task.done);
    parentId = parent.parentId;
  }
}

export function createJsonTaskStore(filename: string): TaskStore {
  function readState(): { version: 1; tasks: Task[]; trash: TrashEntry[] } {
    if (!existsSync(filename)) return { version: 1, tasks: [], trash: [] };
    const value: unknown = JSON.parse(readFileSync(filename, "utf8"));
    return Array.isArray(value)
      ? { version: 1, tasks: taskList.parse(value), trash: [] }
      : envelopeSchema.parse(value);
  }
  function list(): Task[] {
    return readState().tasks;
  }

  // 任务与回收记录原子提交；兼容旧数组，并保留上一份完整文件备份。
  function save(tasks: Task[], trash = readState().trash) {
    mkdirSync(dirname(filename), { recursive: true });
    const temporary = filename + ".tmp";
    writeFileSync(temporary, JSON.stringify({ version: 1, tasks, trash }, null, 2) + "\n", {
      mode: 0o600,
    });
    if (existsSync(filename)) {
      writeFileSync(filename + ".bak.tmp", readFileSync(filename), { mode: 0o600 });
      renameSync(filename + ".bak.tmp", filename + ".bak");
    }
    renameSync(temporary, filename);
  }

  function prepareImport(input: unknown) {
    const parsed = importList.safeParse(input);
    if (!parsed.success) throw new TaskRelationError("导入格式无效：请提供最多1000条合法任务。");
    if (
      parsed.data.some(
        (task) =>
          task.effort !== undefined && task.workload !== undefined && task.effort !== task.workload,
      )
    )
      throw new TaskRelationError("导入effort/workload冲突，未写入数据。");
    const incoming: Task[] = parsed.data.map(({ effort, ...task }) => ({
      ...task,
      ...(effort !== undefined && task.workload === undefined ? { workload: effort } : {}),
    }));
    if (new Set(incoming.map((task) => task.id)).size !== incoming.length)
      throw new TaskRelationError("导入文件含重复ID。");
    const current = list();
    const byId = new Map(current.map((task) => [task.id, task]));
    const added: Task[] = [];
    let skipped = 0;
    const canonical = (task: Task) =>
      JSON.stringify(Object.entries(task).sort(([a], [b]) => a.localeCompare(b)));
    for (const task of incoming) {
      const existing = byId.get(task.id);
      if (existing) {
        if (canonical(existing) !== canonical(task))
          throw new TaskRelationError("导入任务ID与现有任务冲突，未覆盖数据。");
        skipped += 1;
      } else added.push(task);
    }
    const merged = [...current, ...added];
    for (const task of added) validateParent(merged, task.id, task.parentId);
    const token = createHash("sha256").update(JSON.stringify({ current, incoming })).digest("hex");
    return { merged, added, skipped, token };
  }

  function removeMany(ids: string[]): number {
    const tasks = list();
    const selected = new Set(tasksAffectedByDeletion(tasks, ids).map((task) => task.id));
    const remaining = tasks.filter((task) => !selected.has(task.id));
    const count = tasks.length - remaining.length;
    if (count) {
      const parents = new Set(
        tasks.filter((task) => selected.has(task.id)).map((task) => task.parentId),
      );
      for (const parentId of parents) syncParents(remaining, parentId);
      const entry: TrashEntry = {
        id: randomUUID(),
        deletedAt: new Date().toISOString(),
        tasks: tasks.filter((task) => selected.has(task.id)),
      };
      save(remaining, [...readState().trash, entry]);
    }
    return count;
  }

  return {
    list,
    removeMany,
    trash() {
      return readState().trash;
    },
    restore(id) {
      const state = readState();
      const entry = state.trash.find((item) => item.id === id);
      if (!entry) throw new TaskRelationError("找不到该回收记录，可能已恢复。");
      const currentIds = new Set(state.tasks.map((task) => task.id));
      if (entry.tasks.some((task) => currentIds.has(task.id)))
        throw new TaskRelationError("恢复任务ID冲突，未覆盖数据。");
      const merged = [...state.tasks, ...entry.tasks];
      const ids = new Set(merged.map((task) => task.id));
      if (entry.tasks.some((task) => task.parentId && !ids.has(task.parentId)))
        throw new TaskRelationError("请先恢复关联父任务。");
      for (const task of entry.tasks) syncParents(merged, task.parentId, task.id);
      save(
        merged,
        state.trash.filter((item) => item.id !== id),
      );
      return entry.tasks;
    },
    previewImport(input) {
      const { added, skipped, token } = prepareImport(input);
      return { added: added.length, skipped, token };
    },
    importTasks(input, token) {
      const prepared = prepareImport(input);
      if (token !== prepared.token)
        throw new TaskRelationError("清单已变化或预览已过期，请重新预览。");
      for (const task of prepared.added) syncParents(prepared.merged, task.parentId, task.id);
      if (prepared.added.length) save(prepared.merged);
      return { added: prepared.added.length, skipped: prepared.skipped, token: prepared.token };
    },

    create(title, attrs = {}) {
      const task: Task = { id: randomUUID(), title, done: false, ...compact(attrs) };
      const tasks = list();
      validateParent(tasks, task.id, task.parentId);
      const parent = tasks.find((item) => item.id === task.parentId);
      if (task.dueDate === undefined && parent?.dueDate !== undefined)
        task.dueDate = parent.dueDate;
      tasks.push(task);
      syncParents(tasks, task.parentId, task.id);
      save(tasks);
      return task;
    },

    update(id, changes) {
      const tasks = list();
      const task = tasks.find((item) => item.id === id);
      if (!task) return undefined;

      validateParent(tasks, id, changes.parentId);
      const oldParentId = task.parentId;
      Object.assign(task, compact(changes));
      if (changes.done === true) {
        for (const descendant of tasksAffectedByDeletion(tasks, [id])) descendant.done = true;
      }
      if (changes.parentId !== undefined && changes.parentId !== oldParentId)
        syncParents(tasks, oldParentId, id);
      if (changes.done !== undefined || changes.parentId !== undefined)
        syncParents(tasks, task.parentId, id);
      save(tasks);
      return task;
    },

    remove(id) {
      return removeMany([id]) > 0;
    },
  };
}
