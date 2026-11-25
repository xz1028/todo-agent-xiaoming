import type { TaskStore } from "./task-store.ts";

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
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_tasks",
      description: "新增一条或多条任务；一句话里有多条任务时一次传入 titles 数组。",
      parameters: {
        type: "object",
        properties: {
          titles: {
            type: "array",
            items: { type: "string" },
            description: "任务标题数组，每项为 1 至 200 个字符",
            minItems: 1,
          },
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
      description: "修改一条任务的标题。id 必须来自 list_tasks 的结果。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "任务 id" },
          title: { type: "string", description: "新标题，1 至 200 个字符" },
        },
        required: ["id", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_task",
      description: "删除一条任务。id 必须来自 list_tasks 的结果。",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "任务 id" } },
        required: ["id"],
      },
    },
  },
] as const;

type JsonObject = Record<string, unknown>;
type ScriptResult = {
  ok: boolean;
  error?: string;
  tasks?: unknown[];
  task?: unknown;
  summary?: string;
};

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

function summaryOf(tasks: ReturnType<TaskStore["list"]>): string {
  const pending = tasks.filter((task) => !task.done).length;
  const lines = tasks.map((task) => `${task.done ? "✅" : "⬜"} ${task.title}`);
  return `共 ${tasks.length} 项，未完成 ${pending} 项。\n${lines.join("\n")}`.trim();
}

/** 执行一个工具调用；任何失败都以结构化 JSON 返回，绝不抛异常给 agent 循环。 */
export function executeTool(name: string, argsJson: string, store: TaskStore): string {
  let raw: unknown;
  try {
    raw = JSON.parse(argsJson);
  } catch {
    return error("工具参数不是合法的 JSON。");
  }
  if (!isObject(raw)) return error("工具参数必须是一个对象。");

  switch (name) {
    case "list_tasks": {
      if (raw.filter !== undefined && !["all", "pending", "done"].includes(raw.filter as string)) {
        return error("filter 只能是 all、pending 或 done。");
      }
      let tasks = store.list();
      if (raw.filter === "pending") tasks = tasks.filter((task) => !task.done);
      if (raw.filter === "done") tasks = tasks.filter((task) => task.done);
      return success({ tasks, summary: summaryOf(tasks) });
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
      const created = titles.map((title) => store.create(title));
      return success({ tasks: created, summary: summaryOf(store.list()) });
    }

    case "complete_task": {
      const { id, error: idError } = requireId(raw);
      if (idError || !id) return error(idError ?? "缺少任务 id。");
      const done = raw.done === undefined ? true : raw.done;
      if (typeof done !== "boolean") return error("done 必须是布尔值。");
      const current = store.list().find((task) => task.id === id);
      if (!current) return error("找不到这条任务，请先调用 list_tasks 确认 id。");
      const updated = store.update(id, { done });
      return success({ task: updated, summary: summaryOf(store.list()) });
    }

    case "update_task": {
      const { id, error: idError } = requireId(raw);
      if (idError || !id) return error(idError ?? "缺少任务 id。");
      const { title, error: titleError } = cleanTitle(raw.title);
      if (titleError || !title) return error(`修改失败：${titleError}`);
      if (!store.list().some((task) => task.id === id)) {
        return error("找不到这条任务，请先调用 list_tasks 确认 id。");
      }
      const updated = store.update(id, { title });
      return success({ task: updated, summary: summaryOf(store.list()) });
    }

    case "delete_task": {
      const { id, error: idError } = requireId(raw);
      if (idError || !id) return error(idError ?? "缺少任务 id。");
      if (!store.list().some((task) => task.id === id)) {
        return error("找不到这条任务，请先调用 list_tasks 确认 id。");
      }
      store.remove(id);
      return success({ summary: summaryOf(store.list()) });
    }

    default:
      return error(`未知工具：${name}`);
  }
}
