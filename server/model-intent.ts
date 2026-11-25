import type { ChatMessage } from "../shared/chat.ts";
import type { Intent, TaskAttrs } from "./intent.ts";
import { getModelClient, model } from "./model.ts";
import { priorities, type Priority, type Task, type Workload, workloads } from "./task-store.ts";

const systemPrompt = `你是中文待办助手的意图解析器。只输出 JSON 对象，不要附加解释。
字段说明：
- intent: create（新建任务）| list（查看清单）| complete（标记完成）| delete（删除）| update（修改任务属性）| help | unknown
- title: 新建任务的干净标题，不含日期、优先级、工作量等属性词
- ref: 用户指代的任务关键词（如「牛奶买好了」中的「牛奶」）
- scope: all | active | done | due
- dueDate: YYYY-MM-DD 格式
- priority: high | medium | low
- workload: small | medium | large
- parentRef: 父任务的标题或 id
无法确定的字段省略即可。`;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 规则置信度不足且配置了密钥时才调用；任何失败都静默降级为规则结果。 */
export async function parseModelIntent(
  text: string,
  tasks: Task[],
  messages: ChatMessage[],
): Promise<Intent | undefined> {
  if (!process.env.DEEPSEEK_API_KEY) return undefined;

  try {
    const client = getModelClient();
    const completion = await client.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: JSON.stringify({
            message: text,
            recent: messages.slice(-6),
            tasks: tasks.map((task) => ({ id: task.id, title: task.title, done: task.done })),
            today: new Date().toISOString().slice(0, 10),
          }),
        },
      ],
    });

    const raw = asRecord(JSON.parse(completion.choices[0]?.message?.content ?? "{}"));
    if (!raw) return undefined;

    const attrs: TaskAttrs = {};
    const dueDate = stringField(raw.dueDate);
    if (dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate)) attrs.dueDate = dueDate;
    const priority = stringField(raw.priority);
    if (priority && priorities.includes(priority as Priority))
      attrs.priority = priority as Priority;
    const workload = stringField(raw.workload);
    if (workload && workloads.includes(workload as Workload)) attrs.workload = workload as Workload;
    const parentRef = stringField(raw.parentRef);
    if (parentRef) attrs.parentId = parentRef;
    const title = stringField(raw.title);
    if (title) attrs.title = title;

    switch (raw.intent) {
      case "create":
        return title ? { kind: "create", title, attrs, confidence: 0.75 } : undefined;
      case "complete": {
        const ref = stringField(raw.ref);
        return ref ? { kind: "complete", ref, confidence: 0.75 } : undefined;
      }
      case "delete": {
        const ref = stringField(raw.ref);
        return ref ? { kind: "delete", ref, confidence: 0.75 } : undefined;
      }
      case "update": {
        const ref = stringField(raw.ref);
        return ref ? { kind: "update", ref, attrs, confidence: 0.75 } : undefined;
      }
      case "list": {
        const scope = stringField(raw.scope);
        return {
          kind: "list",
          scope: scope === "done" || scope === "due" || scope === "all" ? scope : "active",
          confidence: 0.75,
        };
      }
      case "help":
        return { kind: "help", confidence: 0.75 };
      default:
        return undefined;
    }
  } catch (error) {
    console.error(
      "模型兜底失败，已按规则结果继续：",
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}
