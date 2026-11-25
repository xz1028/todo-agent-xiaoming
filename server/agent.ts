import type { ChatMessage } from "../shared/chat.ts";
import type { Task, TaskChanges, TaskStore } from "./task-store.ts";
import { cleanRef, findTask, parseRuleIntent, type TaskAttrs } from "./intent.ts";
import { detailSuffix, formatList } from "./format.ts";
import { parseModelIntent } from "./model-intent.ts";

export type { ChatMessage } from "../shared/chat.ts";

function resolveParent(value: string | undefined, tasks: Task[]): string | undefined {
  if (!value) return undefined;
  const exact = tasks.find((task) => task.id === value);
  if (exact) return exact.id;
  return findTask(value, tasks)?.id;
}

function toChanges(attrs: TaskAttrs, tasks: Task[]): TaskChanges {
  const changes: TaskChanges = {};
  if (attrs.title) changes.title = attrs.title;
  if (attrs.dueDate) changes.dueDate = attrs.dueDate;
  if (attrs.priority) changes.priority = attrs.priority;
  if (attrs.workload) changes.workload = attrs.workload;
  if (attrs.parentId) changes.parentId = resolveParent(attrs.parentId, tasks);
  return changes;
}

/** 「这条」「刚才那个」等指代：从最近的对话轮次里找回被操作过的任务。 */
function isPronoun(ref: string): boolean {
  return cleanRef(ref).length === 0 || /^(这|那|它|刚才|刚刚)/.test(ref.trim());
}

function recentRef(messages: ChatMessage[], tasks: Task[]): string | undefined {
  for (let index = messages.length - 2; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const intent = parseRuleIntent(message.content, tasks);
    if (intent.kind === "create") return intent.title;
    if (intent.kind === "complete" || intent.kind === "delete" || intent.kind === "update") {
      return intent.ref;
    }
  }
  return undefined;
}

function findTarget(ref: string, messages: ChatMessage[], tasks: Task[], preferActive: boolean) {
  const direct = findTask(ref, tasks, preferActive);
  if (direct) return direct;
  if (!isPronoun(ref)) return undefined;
  const remembered = recentRef(messages, tasks);
  return remembered ? findTask(remembered, tasks, preferActive) : undefined;
}

function helpText(): string {
  return [
    "我可以帮你管理待办，试试这样说：",
    "· 帮我记一下买牛奶",
    "· 我有哪些任务？",
    "· 牛奶买好了",
    "· 取快递这条删掉吧",
    "还支持：明天到期、高优先级、工作量小、XX 的子任务。",
  ].join("\n");
}

/** 接收对话历史与任务存储，返回本轮回复；任务在回复前已落盘。 */
export async function reply(messages: ChatMessage[], tasks: TaskStore): Promise<string> {
  const text = messages.at(-1)?.content.trim() ?? "";
  if (!text) return "请告诉我你想做什么。";

  const snapshot = tasks.list();
  const rule = parseRuleIntent(text, snapshot);
  const intent =
    rule.confidence >= 0.8 ? rule : ((await parseModelIntent(text, snapshot, messages)) ?? rule);
  let current = tasks.list();

  switch (intent.kind) {
    case "help":
      return helpText();

    case "list":
      return formatList(current, intent.scope);

    case "create": {
      const created = tasks.create(intent.title, toChanges(intent.attrs, current));
      return `✅ 已记下「${created.title}」${detailSuffix(created)}。\n${formatList(tasks.list())}`;
    }

    case "complete": {
      const target = findTarget(intent.ref, messages, current, true);
      if (!target) return `没找到对应的任务。\n${formatList(current)}`;
      if (target.done) return `「${target.title}」已经完成啦。\n${formatList(current)}`;
      tasks.update(target.id, { done: true });
      return `✅ 已完成「${target.title}」。\n${formatList(tasks.list())}`;
    }

    case "delete": {
      const target = findTarget(intent.ref, messages, current, false);
      if (!target) return `没找到对应的任务。\n${formatList(current)}`;
      const childCount = current.filter((task) => task.parentId === target.id).length;
      tasks.remove(target.id);
      const suffix = childCount ? `及其 ${childCount} 个子任务` : "";
      return `🗑 已删除「${target.title}」${suffix}。\n${formatList(tasks.list())}`;
    }

    case "update": {
      const target = findTarget(intent.ref, messages, current, false);
      if (!target) return `没找到对应的任务。\n${formatList(current)}`;
      const changes = toChanges(intent.attrs, current);
      if (Object.keys(changes).length === 0) {
        return `没识别到要修改的内容。\n${helpText()}`;
      }
      const updated = tasks.update(target.id, changes);
      const title = updated?.title ?? target.title;
      return `✏️ 已更新「${title}」${detailSuffix(updated ?? target)}。\n${formatList(tasks.list())}`;
    }

    default:
      return `我没太明白你的意思。\n${helpText()}\n${formatList(current)}`;
  }
}
