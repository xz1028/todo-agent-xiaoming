import { Router } from "express";
import { z } from "zod";
import { priorities, workloads, type TaskChanges, type TaskStore } from "./task-store.ts";

const titleField = z.string().trim().min(1).max(200);
const attributes = {
  dueDate: z.iso.date("请使用 YYYY-MM-DD 格式的有效日期").optional(),
  priority: z.enum(priorities).optional(),
  workload: z.enum(workloads).optional(),
  // effort 是 workload 的输入别名：两种命名都接受，统一存为 workload。
  effort: z.enum(workloads).optional(),
  parentId: z.string().optional(),
};

const compatibleWorkload = (input: { effort?: string; workload?: string }) =>
  input.effort === undefined || input.workload === undefined || input.effort === input.workload;
const createTaskSchema = z
  .strictObject({ title: titleField, ...attributes })
  .refine(compatibleWorkload);
const updateTaskSchema = z
  .strictObject({ title: titleField.optional(), done: z.boolean().optional(), ...attributes })
  .refine(compatibleWorkload)
  .refine((changes) => Object.keys(changes).length > 0);

type CreateInput = z.infer<typeof createTaskSchema>;
type UpdateInput = z.infer<typeof updateTaskSchema>;

/** 把 effort 别名归一化为 workload，避免存储层出现两种同义字段。 */
function toChanges(input: CreateInput | UpdateInput): TaskChanges {
  const { effort, ...rest } = input;
  return {
    ...rest,
    ...(effort !== undefined && rest.workload === undefined ? { workload: effort } : {}),
  };
}

const taskNotFound = { error: "找不到这条任务。" };
const invalidCreate = { error: "请提供 1 至 200 个字符的任务标题，或检查扩展字段格式。" };
const invalidUpdate = { error: "请提供有效的任务字段。" };

export function taskRouter(tasks: TaskStore) {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(tasks.list());
  });

  router.post("/", (req, res) => {
    const input = createTaskSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json(invalidCreate);
    res.status(201).json(tasks.create(input.data.title, toChanges(input.data)));
  });

  router.patch("/:id", (req, res) => {
    const input = updateTaskSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json(invalidUpdate);

    const updated = tasks.update(req.params.id, toChanges(input.data));
    if (!updated) return res.status(404).json(taskNotFound);
    res.json(updated);
  });

  router.delete("/:id", (req, res) => {
    if (!tasks.remove(req.params.id)) return res.status(404).json(taskNotFound);
    res.sendStatus(204);
  });

  return router;
}
