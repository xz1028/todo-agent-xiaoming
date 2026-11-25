import type { Task, TaskChanges, TaskStore } from "./task-store.ts";

/** OpenAI function calling 所需的工具定义（最小接口，不依赖具体 SDK 类型）。 */
export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_tasks",
      description: "查看任务清单。涉及已有任务时先调用本工具获取最新状态，不要凭对话历史判断。",
      parameters: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            enum: ["all", "pending", "done"],
            description: "all=全部（默认），pending=未完成，done=已完成",
          },
          dueToday: { type: "boolean", description: "只返回今天到期的未完成任务" },
          overdue: {
            type: "boolean",
            description: "只返回已逾期（到期日早于今天）的未完成任务",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_tasks",
      description:
        "新增一条或多条任务；一句话里有多条任务时一次传入 titles 数组。可附带到期日、优先级、工作量或父任务。",
      parameters: {
        type: "object",
        properties: {
          titles: {
            type: "array",
            items: { type: "string" },
            description: "任务标题数组，每项为 1 至 200 个字符",
            minItems: 1,
          },
          dueDate: { type: "string", description: "到期日 YYYY-MM-DD（由相对日期换算）" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
          effort: {
            type: "string",
            enum: ["small", "medium", "large"],
            description: "工作量，别名 workload",
          },
          parentId: { type: "string", description: "父任务 id，用于创建子任务" },
        },
        required: ["titles"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_task",
      description: "把一条任务标记为完成或撤销完成。id 必须来自 list_tasks 的结果。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "任务 id" },
          done: { type: "boolean", description: "true=完成（默认），false=撤销完成" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description: "修改一条任务的标题或扩展属性。id 必须来自 list_tasks 的结果。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "任务 id" },
          title: { type: "string", description: "新标题，1 至 200 个字符" },
          dueDate: { type: "string", description: "到期日 YYYY-MM-DD" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
          effort: { type: "string", enum: ["small", "medium", "large"] },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_task",
      description:
        "登记一条删除请求，id 必须来自 list_tasks。本轮结束后服务端决定直接删除或请求确认；工具不直接删除。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "任务 id" },
          cascade: { type: "boolean", description: "兼容旧参数；不能代替用户确认，也不授权删除" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_tasks",
      description:
        "登记批量删除请求，ids 必须来自 list_tasks。服务端在本轮结束后请求用户确认，工具不直接删除。",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            description: "本轮所有待删除任务的 id",
          },
        },
        required: ["ids"],
      },
    },
  },
] as const;

type JsonObject = Record<string, unknown>;
interface ScriptResult {
  ok: boolean;
  error?: string;
  tasks?: Task[];
  task?: Task;
  summary?: string;
  deletionIds?: string[];
}

const error = (message: string): string =>
  JSON.stringify({ ok: false, error: message } satisfies ScriptResult);
const success = (payload: Omit<ScriptResult, "ok">): string =>
  JSON.stringify({ ok: true, ...payload } satisfies ScriptResult);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanTitle(value: unknown): { title?: string; error?: string } {
  if (typeof value !== "string") return { error: "任务标题必须是文字。" };
  const title = value.trim();
  if (!title) return { error: "任务标题不能为空。" };
  if (title.length > 200) return { error: "任务标题不能超过 200 个字符。" };
  return { title };
}

function requireId(args: JsonObject): { id?: string; error?: string } {
  if (typeof args.id !== "string" || !args.id.trim()) {
    return { error: "请提供要操作的任务 id。" };
  }
  return { id: args.id };
}

/** 从工具参数里提取可选扩展字段；effort 是 workload 的输入别名。 */
function attributes(args: JsonObject): { changes: TaskChanges; error?: string } {
  const changes: TaskChanges = {};
  if (args.dueDate !== undefined) {
    if (typeof args.dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(args.dueDate)) {
      return { changes, error: "到期日必须是 YYYY-MM-DD 格式。" };
    }
    changes.dueDate = args.dueDate;
  }
  if (args.priority !== undefined) {
    if (!["high", "medium", "low"].includes(args.priority as string)) {
      return { changes, error: "优先级只能是 high、medium 或 low。" };
    }
    changes.priority = args.priority as Task["priority"];
  }
  const effort = args.effort ?? args.workload;
  if (effort !== undefined) {
    if (!["small", "medium", "large"].includes(effort as string)) {
      return { changes, error: "工作量只能是 small、medium 或 large。" };
    }
    changes.workload = effort as Task["workload"];
  }
  if (args.parentId !== undefined) {
    if (typeof args.parentId !== "string") return { changes, error: "父任务 id 必须是文字。" };
    changes.parentId = args.parentId;
  }
  return { changes };
}

function todayISO(now: () => Date): string {
  return now().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

/** 单任务行：状态标记 + 属性标签；未完成排在前面由调用方保证。 */
function taskLine(task: Task, today: string): string {
  const tags: string[] = [];
  if (task.dueDate) {
    if (task.done) tags.push(`截止 ${task.dueDate}`);
    else if (task.dueDate < today) tags.push("已逾期");
    else if (task.dueDate === today) tags.push("今天到期");
    else tags.push(`截止 ${task.dueDate}`);
  }
  if (task.priority) tags.push(`优先级 ${task.priority}`);
  if (task.workload) tags.push(`工作量 ${task.workload}`);
  if (task.parentId) tags.push("子任务");
  const suffix = tags.length ? ` · ${tags.join(" · ")}` : "";
  return `${task.done ? "✅" : "⬜"} ${task.title}${suffix}`;
}

/** 预格式化摘要：未完成置顶、显示统计与完成状态；供模型直接引用。 */
export function summaryOf(tasks: Task[], now: () => Date = () => new Date()): string {
  const pending = tasks.filter((task) => !task.done);
  const ordered = [...pending, ...tasks.filter((task) => task.done)];
  const today = todayISO(now);
  const lines = ordered.map((task) => taskLine(task, today));
  return `共 ${tasks.length} 项，未完成 ${pending.length} 项。${lines.length ? `\n${lines.join("\n")}` : ""}`;
}

/** 执行一个工具调用；任何失败都以结构化 JSON 返回，绝不抛异常给 agent 循环。 */
export function executeTool(
  name: string,
  argsJson: string,
  store: TaskStore,
  now: () => Date = () => new Date(),
): string {
  let raw: unknown;
  try {
    raw = JSON.parse(argsJson);
  } catch {
    return error("工具参数不是合法的 JSON。");
  }
  if (!isObject(raw)) return error("工具参数必须是一个对象。");

  const summary = () => summaryOf(store.list(), now);

  switch (name) {
    case "list_tasks": {
      if (raw.filter !== undefined && !["all", "pending", "done"].includes(raw.filter as string)) {
        return error("filter 只能是 all、pending 或 done。");
      }
      for (const flag of ["dueToday", "overdue"] as const) {
        if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") {
          return error(`${flag} 必须是布尔值。`);
        }
      }
      const today = todayISO(now);
      let tasks = store.list();
      if (raw.filter === "pending") tasks = tasks.filter((task) => !task.done);
      if (raw.filter === "done") tasks = tasks.filter((task) => task.done);
      if (raw.dueToday) tasks = tasks.filter((task) => !task.done && task.dueDate === today);
      if (raw.overdue) {
        tasks = tasks.filter((task) => !task.done && !!task.dueDate && task.dueDate < today);
      }
      // 未完成置顶，方便模型与用户一眼看出待处理项。
      tasks = [...tasks.filter((task) => !task.done), ...tasks.filter((task) => task.done)];
      return success({ tasks, summary: summaryOf(tasks, now) });
    }

    case "add_tasks": {
      if (!Array.isArray(raw.titles) || raw.titles.length === 0) {
        return error("请提供至少一条任务标题（titles 数组）。");
      }
      const titles: string[] = [];
      for (const item of raw.titles) {
        const { title, error: titleError } = cleanTitle(item);
        if (titleError || !title) return error(`添加失败：${titleError}`);
        titles.push(title);
      }
      const { changes, error: attrError } = attributes(raw);
      if (attrError) return error(`添加失败：${attrError}`);
      const created = titles.map((title) => store.create(title, changes));
      return success({ tasks: created, summary: summary() });
    }

    case "complete_task": {
      const { id, error: idError } = requireId(raw);
      if (idError || !id) return error(idError ?? "缺少任务 id。");
      const done = raw.done === undefined ? true : raw.done;
      if (typeof done !== "boolean") return error("done 必须是布尔值。");
      if (!store.list().some((task) => task.id === id)) {
        return error("找不到这条任务，请先调用 list_tasks 确认 id。");
      }
      const updated = store.update(id, { done });
      return success({ task: updated, summary: summary() });
    }

    case "update_task": {
      const { id, error: idError } = requireId(raw);
      if (idError || !id) return error(idError ?? "缺少任务 id。");
      const changes: TaskChanges = {};
      if (raw.title !== undefined) {
        const { title, error: titleError } = cleanTitle(raw.title);
        if (titleError || !title) return error(`修改失败：${titleError}`);
        changes.title = title;
      }
      const attrs = attributes(raw);
      if (attrs.error) return error(`修改失败：${attrs.error}`);
      Object.assign(changes, attrs.changes);
      if (!Object.keys(changes).length) return error("没有提供要修改的内容。");
      if (!store.list().some((task) => task.id === id)) {
        return error("找不到这条任务，请先调用 list_tasks 确认 id。");
      }
      const updated = store.update(id, changes);
      return success({ task: updated, summary: summary() });
    }

    case "delete_task":
    case "delete_tasks": {
      let ids: string[];
      if (name === "delete_task") {
        const { id, error: idError } = requireId(raw);
        if (idError || !id) return error(idError ?? "缺少任务 id。");
        if (raw.cascade !== undefined && typeof raw.cascade !== "boolean") {
          return error("cascade 必须是布尔值，且不能代替用户确认。");
        }
        ids = [id];
      } else {
        if (
          !Array.isArray(raw.ids) ||
          !raw.ids.length ||
          !raw.ids.every((id) => typeof id === "string" && id.trim())
        ) {
          return error("请提供非空的任务 id 数组（ids）。");
        }
        ids = [...new Set(raw.ids as string[])];
      }
      const current = store.list();
      if (!ids.every((id) => current.some((task) => task.id === id))) {
        return error("找不到任务，请先调用 list_tasks 确认全部 id；未登记任何删除。");
      }
      return success({
        deletionIds: ids,
        summary:
          "删除请求已登记，尚未执行。本轮结束后服务端统一执行单条普通删除，或向用户请求批量/父子任务删除确认。不要重复登记。",
      });
    }

    default:
      return error(`未知工具：${name}`);
  }
}
