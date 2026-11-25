import type { Priority, Task, Workload } from "./task-store.ts";

export interface TaskAttrs {
  title?: string;
  dueDate?: string;
  priority?: Priority;
  workload?: Workload;
  /** 可以是任务 id，也可以是父任务的标题（由 agent 层解析）。 */
  parentId?: string;
}

export type Intent =
  | { kind: "list"; scope: "all" | "active" | "done" | "due"; confidence: number }
  | { kind: "create"; title: string; attrs: TaskAttrs; confidence: number }
  | { kind: "complete"; ref: string; confidence: number }
  | { kind: "delete"; ref: string; confidence: number }
  | { kind: "update"; ref: string; attrs: TaskAttrs; confidence: number }
  | { kind: "help"; confidence: number }
  | { kind: "unknown"; confidence: number };

const CREATE_MARKER =
  /记一下|记住|记下|记个|记一条|记录一下|添加|新增|新建|创建|加一条|加一个|加个|加上|提醒我|提醒一下|安排|帮我记|我要|我想/;
const DELETE_MARKER = /删除|删掉|删了|移除|去掉|取消|不要了|清除/;
const COMPLETE_MARKER = /完成|好了|做完|搞定|办完|结束|勾掉|划掉|办妥/;
const UPDATE_MARKER =
  /设为|改成|改为|重命名|改标题|优先级|截止|到期日|延期|推迟|提前|工作量|放到|挪到/;
const LIST_MARKER =
  /哪些|什么任务|什么待办|看看|查看|列出|清单|列表|待办|有什么|列一下|给我看|还剩|多少/;

function ymd(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 从中文口语中抽取日期；返回原文片段和 YYYY-MM-DD 值。 */
export function extractDate(text: string): { raw: string; value: string } | undefined {
  const now = new Date();

  const iso = text.match(/\d{4}-\d{1,2}-\d{1,2}/);
  if (iso) {
    const [year, month, day] = iso[0].split("-").map(Number);
    return {
      raw: iso[0],
      value: ymd(new Date(year, month - 1, day)),
    };
  }

  const relative = text.match(/今天|今日|明天|明日|后天|大后天/);
  if (relative) {
    const offsets: Record<string, number> = {
      今天: 0,
      今日: 0,
      明天: 1,
      明日: 1,
      后天: 2,
      大后天: 3,
    };
    const target = new Date(now);
    target.setDate(target.getDate() + offsets[relative[0]]);
    return { raw: relative[0], value: ymd(target) };
  }

  const weekday = text.match(/(下下|下|本)?(周|星期)([一二三四五六日天1-7])/);
  if (weekday) {
    const names: Record<string, number> = {
      一: 1,
      二: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      日: 0,
      天: 0,
      1: 1,
      2: 2,
      3: 3,
      4: 4,
      5: 5,
      6: 6,
      7: 0,
    };
    const targetWeekday = names[weekday[3]];
    const current = now.getDay();
    let delta = (targetWeekday - current + 7) % 7;
    if (weekday[1] === "下") delta += 7;
    if (weekday[1] === "下下") delta += 14;
    if (weekday[1] === undefined && delta === 0) delta = 7;
    const target = new Date(now);
    target.setDate(target.getDate() + delta);
    return { raw: weekday[0], value: ymd(target) };
  }

  const monthDay = text.match(/(\d{1,2})月(\d{1,2})[日号]?/);
  if (monthDay) {
    const month = Number(monthDay[1]);
    const day = Number(monthDay[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let year = now.getFullYear();
      const target = new Date(year, month - 1, day);
      if (target < new Date(now.getFullYear(), now.getMonth(), now.getDate())) year += 1;
      return { raw: monthDay[0], value: ymd(new Date(year, month - 1, day)) };
    }
  }

  return undefined;
}

/** 从整句话中解析优先级、工作量、到期日与父任务线索，并返回剥离属性后的文本。 */
export function parseAttributes(text: string): { attrs: TaskAttrs; rest: string } {
  let rest = text;
  const attrs: TaskAttrs = {};

  const date = extractDate(rest);
  if (date) {
    attrs.dueDate = date.value;
    rest = rest.replace(date.raw, "");
  }

  const highPriority = rest.match(/高优先级|优先级高|很重要|特别重要|紧急|加急|急件/);
  const lowPriority = rest.match(/低优先级|优先级低|不重要|有空再做/);
  const midPriority = rest.match(/中优先级|优先级中/);
  if (highPriority) {
    attrs.priority = "high";
    rest = rest.replace(highPriority[0], "");
  } else if (lowPriority) {
    attrs.priority = "low";
    rest = rest.replace(lowPriority[0], "");
  } else if (midPriority) {
    attrs.priority = "medium";
    rest = rest.replace(midPriority[0], "");
  }

  const large = rest.match(/工作量大|大工作量|大任务|工作量[=:：]?大/);
  const small = rest.match(/工作量小|小工作量|小任务|工作量[=:：]?小/);
  const medium = rest.match(/工作量中|中工作量|工作量[=:：]?中/);
  if (large) {
    attrs.workload = "large";
    rest = rest.replace(large[0], "");
  } else if (small) {
    attrs.workload = "small";
    rest = rest.replace(small[0], "");
  } else if (medium) {
    attrs.workload = "medium";
    rest = rest.replace(medium[0], "");
  }

  const parent = rest.match(/([\u4e00-\u9fa5A-Za-z0-9]{1,30})的子任务/);
  if (parent) {
    attrs.parentId = parent[1];
    rest = rest.replace(parent[0], "");
  }

  rest = rest
    .replace(/^(的|在|于|把|给|要|是|为|：|:|，|,|、|\s)+/, "")
    .replace(/[。！!?？~～]+$/, "")
    .trim();

  return { attrs, rest };
}

/** 去掉「帮我记一下」「再记一条」等口语前缀，留下任务标题。 */
export function stripCreatePrefix(text: string): string {
  let result = text
    .replace(/^(再|先|另外)?\s*/, "")
    .replace(/^(帮我|请|麻烦|能不能|可以)?\s*/, "")
    .replace(
      /^(记录一下|记一下|记住|记下|记个|记一条|添加|新增|新建|创建|加一条|加一个|加个|加上|安排|提醒我|提醒一下|我要|我想|要|来|加)?\s*/,
      "",
    )
    .replace(/^(一|一个|一条)?\s*(个|条|件)?\s*(任务|待办|事项|事情)?\s*[:：,，]?\s*/, "");
  // 剥离属性词后可能留下「，到期，，」等残片，反复清理到稳定。
  for (let index = 0; index < 3; index += 1) {
    result = result.replace(/[。！!?？~～，,、\s]+$/, "").replace(/(到期|截止)$/, "");
  }
  return result.trim();
}

/** 归一化用于匹配的字符串：去掉语气词、指代和标点。 */
export function cleanRef(text: string): string {
  return text
    .replace(
      /好了|完成|做完|搞定|办完|结束|了|吧|啊|呢|哦|啦|嘛|呀|吗|这条|那个|那个|这件|刚才|之前|任务|待办/g,
      "",
    )
    .replace(/[，。！？、,!?：:]/g, "")
    .trim();
}

function bigrams(text: string): Set<string> {
  const result = new Set<string>();
  for (let index = 0; index < text.length - 1; index += 1) {
    result.add(text.slice(index, index + 2));
  }
  return result;
}

/** 0~1 的模糊匹配分数：包含关系优先，其次二元组与字符重合。 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;

  const gramsA = bigrams(a);
  const gramsB = bigrams(b);
  let shared = 0;
  for (const gram of gramsA) if (gramsB.has(gram)) shared += 1;
  const union = new Set([...gramsA, ...gramsB]).size || 1;
  const gramScore = shared / union;

  const charsA = new Set(a);
  const charsB = new Set(b);
  let sharedChars = 0;
  for (const char of charsA) if (charsB.has(char)) sharedChars += 1;
  const charScore = sharedChars / Math.min(charsA.size, charsB.size);

  return gramScore * 0.55 + charScore * 0.45;
}

/** 在清单中找到最贴近用户描述的任务；preferActive 会优先未完成任务。 */
export function findTask(ref: string, tasks: Task[], preferActive = false): Task | undefined {
  const needle = cleanRef(ref);
  if (!needle || tasks.length === 0) return undefined;

  let best: Task | undefined;
  let bestScore = 0;
  for (const task of tasks) {
    let score = similarity(needle, cleanRef(task.title));
    if (preferActive && !task.done) score += 0.05;
    if (score > bestScore) {
      bestScore = score;
      best = task;
    }
  }
  return bestScore >= 0.45 ? best : undefined;
}

/** 纯规则意图识别；置信度低于 0.8 时 agent 会尝试模型兜底。 */
export function parseRuleIntent(text: string, _tasks: Task[]): Intent {
  const input = text.trim();
  if (/^(帮助|help|你能做什么|怎么用|使用说明)$/i.test(input)) {
    return { kind: "help", confidence: 1 };
  }

  const isList = LIST_MARKER.test(input);
  const isDueQuery = isList && /到期|截止/.test(input);
  const isDoneQuery = isList && /已完成|已经完成|做过的|完成的任务|完成的有哪些/.test(input);
  const isDelete = DELETE_MARKER.test(input);
  const isComplete = COMPLETE_MARKER.test(input);
  const isUpdate = UPDATE_MARKER.test(input);
  const isCreate = CREATE_MARKER.test(input) || (/子任务/.test(input) && !isList);

  if (isDoneQuery) return { kind: "list", scope: "done", confidence: 0.95 };
  if (isDueQuery) return { kind: "list", scope: "due", confidence: 0.95 };

  if (isDelete) {
    const ref = input
      .replace(/^(帮我|请|麻烦)?\s*(把)?/, "")
      .replace(
        /(这条|那个|这件|一)?\s*(删除|删掉|删了|移除|去掉|取消|不要了|清除)\s*(吧|啊|呢|哦|。|！|！)?$/,
        "",
      )
      .trim();
    return { kind: "delete", ref: ref || input, confidence: 0.95 };
  }

  if (isComplete) {
    return { kind: "complete", ref: input, confidence: 0.9 };
  }

  if (isUpdate && !isCreate) {
    const { attrs } = parseAttributes(input);
    const ref = input
      .replace(/^(帮我|请|麻烦)?\s*(把)?/, "")
      .replace(
        /(设为|改成|改为|重命名|改标题|优先级|截止|到期日|延期|推迟|提前|工作量|放到|挪到).*$/,
        "",
      )
      .trim();
    if (Object.keys(attrs).length > 0 && ref) {
      return { kind: "update", ref, attrs, confidence: 0.85 };
    }
  }

  if (isList && !isCreate) {
    const activeOnly = /未完成|还没做|没做完|未完成|待完成|剩下没/.test(input);
    return { kind: "list", scope: activeOnly ? "active" : "all", confidence: 0.95 };
  }

  if (isCreate) {
    const { attrs, rest } = parseAttributes(input);
    const title = stripCreatePrefix(rest);
    if (title) return { kind: "create", title, attrs, confidence: 0.9 };
  }

  if (isList) return { kind: "list", scope: "all", confidence: 0.8 };
  return { kind: "unknown", confidence: 0 };
}
