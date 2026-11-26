import {
  isUuid,
  loadSession,
  parseSavedSession,
  retainedMessages,
  type SavedSession,
} from "./session.ts";

export interface Conversation {
  id: string;
  title: string;
  customTitle: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  session: SavedSession;
}
export interface ConversationHistory {
  version: 2;
  activeId: string;
  conversations: Conversation[];
}
export const historyKey = "xiaoming.chats.v2";
function titleOf(session: SavedSession) {
  return (
    session.messages
      .find((message) => message.role === "user")
      ?.content.trim()
      .replace(/\s+/gu, " ")
      .slice(0, 30) || "新对话"
  );
}
function makeConversation(session: SavedSession = { version: 1, messages: [] }): Conversation {
  const time = Date.now();
  return {
    id: crypto.randomUUID(),
    title: titleOf(session),
    customTitle: false,
    createdAt: time,
    updatedAt: time,
    session,
  };
}
function initial(session?: SavedSession): ConversationHistory {
  const item = makeConversation(session);
  return { version: 2, activeId: item.id, conversations: [item] };
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const validTime = (value: unknown): value is number =>
  typeof value === "number" && value > 0 && Number.isFinite(new Date(value).getTime());
function parseHistory(value: unknown): ConversationHistory | undefined {
  if (
    !isObject(value) ||
    value.version !== 2 ||
    typeof value.activeId !== "string" ||
    !Array.isArray(value.conversations)
  )
    return;
  const conversations: Conversation[] = [];
  for (const item of value.conversations) {
    if (
      !isObject(item) ||
      !isUuid(item.id) ||
      typeof item.title !== "string" ||
      !item.title.trim() ||
      item.title.length > 60 ||
      typeof item.customTitle !== "boolean" ||
      !validTime(item.createdAt) ||
      !validTime(item.updatedAt) ||
      (item.deletedAt !== undefined && !validTime(item.deletedAt))
    )
      return;
    const session = parseSavedSession(item.session);
    if (!session || (item.deletedAt !== undefined && session.request)) return;
    conversations.push({
      id: item.id,
      title: item.title,
      customTitle: item.customTitle,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      ...(item.deletedAt !== undefined ? { deletedAt: item.deletedAt } : {}),
      session,
    });
  }
  if (new Set(conversations.map((item) => item.id)).size !== conversations.length) return;
  const live = conversations.filter((item) => item.deletedAt === undefined);
  if (!live.length) {
    const created = makeConversation();
    conversations.unshift(created);
    live.push(created);
  }
  const pending = live.filter((item) => item.session.request);
  if (pending.length > 1) return;
  const active = pending[0] ?? live.find((item) => item.id === value.activeId) ?? live[0];
  return { version: 2, activeId: active.id, conversations };
}
export function loadConversations(storage?: Pick<Storage, "getItem">): {
  history: ConversationHistory;
  warning?: string;
} {
  try {
    const store = storage ?? localStorage;
    const raw = store.getItem(historyKey);
    if (raw !== null) {
      const history = parseHistory(JSON.parse(raw));
      if (history) return { history };
      return { history: initial(), warning: "历史记录格式异常，原始记录仍保留在浏览器中。" };
    }
    return { history: initial(loadSession(store)) };
  } catch {
    return {
      history: initial(),
      warning: "暂时无法读取历史记录；旧记录未被删除，请检查浏览器存储。",
    };
  }
}
export function saveConversations(
  history: ConversationHistory,
  storage?: Pick<Storage, "getItem" | "setItem">,
): boolean {
  try {
    const store = storage ?? localStorage;
    const raw = store.getItem(historyKey);
    if (raw !== null) {
      let valid = false;
      try {
        valid = !!parseHistory(JSON.parse(raw));
      } catch {
        /* 保存前备份损坏原文。 */
      }
      if (!valid) store.setItem(historyKey + ".recovery", raw);
    }
    store.setItem(historyKey, JSON.stringify(history));
    return true;
  } catch {
    return false;
  }
}
export function activeConversation(history: ConversationHistory): Conversation {
  return history.conversations.find(
    (item) => item.id === history.activeId && item.deletedAt === undefined,
  )!;
}
function ensureIdle(history: ConversationHistory) {
  if (history.conversations.some((item) => item.deletedAt === undefined && item.session.request))
    throw new Error("请先等待或停止当前处理，并读取本次回执。");
}
export function updateConversationSession(
  history: ConversationHistory,
  id: string,
  session: SavedSession,
): ConversationHistory {
  return {
    ...history,
    conversations: history.conversations.map((item) =>
      item.id === id && item.deletedAt === undefined
        ? {
            ...item,
            session,
            updatedAt: Date.now(),
            title: item.customTitle || item.session.messages.length ? item.title : titleOf(session),
          }
        : item,
    ),
  };
}
export function newConversation(history: ConversationHistory): ConversationHistory {
  ensureIdle(history);
  const empty = history.conversations.find(
    (item) => item.deletedAt === undefined && !item.customTitle && !item.session.messages.length,
  );
  if (empty) return { ...history, activeId: empty.id };
  const item = makeConversation();
  return { ...history, activeId: item.id, conversations: [item, ...history.conversations] };
}
export function switchConversation(history: ConversationHistory, id: string): ConversationHistory {
  ensureIdle(history);
  if (!history.conversations.some((item) => item.id === id && item.deletedAt === undefined))
    throw new Error("找不到该会话。");
  return { ...history, activeId: id };
}
export function renameConversation(
  history: ConversationHistory,
  id: string,
  title: string,
): ConversationHistory {
  ensureIdle(history);
  title = title.trim();
  if (!title || title.length > 60) throw new Error("会话标题应为1至60个字符。");
  if (!history.conversations.some((item) => item.id === id && item.deletedAt === undefined))
    throw new Error("找不到该会话。");
  return {
    ...history,
    conversations: history.conversations.map((item) =>
      item.id === id ? { ...item, title, customTitle: true, updatedAt: Date.now() } : item,
    ),
  };
}
export function deleteConversation(history: ConversationHistory, id: string): ConversationHistory {
  ensureIdle(history);
  if (!history.conversations.some((item) => item.id === id && item.deletedAt === undefined))
    throw new Error("找不到该会话。");
  const time = Date.now();
  const conversations = history.conversations.map((item) =>
    item.id === id ? { ...item, deletedAt: time, updatedAt: time } : item,
  );
  let active =
    conversations.find((item) => item.id === history.activeId && item.deletedAt === undefined) ??
    conversations
      .filter((item) => item.deletedAt === undefined)
      .toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!active) {
    active = makeConversation();
    conversations.unshift(active);
  }
  return { ...history, activeId: active.id, conversations };
}
export function restoreConversation(history: ConversationHistory, id: string): ConversationHistory {
  ensureIdle(history);
  if (!history.conversations.some((item) => item.id === id && item.deletedAt !== undefined))
    throw new Error("找不到该删除记录。");
  return {
    ...history,
    activeId: id,
    conversations: history.conversations.map((item) => {
      if (item.id !== id) return item;
      const { deletedAt: _removed, ...rest } = item;
      return { ...rest, updatedAt: Date.now() };
    }),
  };
}

export function finishConversationRequest(
  history: ConversationHistory,
  id: string,
  requestId: string,
  answer: string,
): ConversationHistory {
  const item = history.conversations.find((item) => item.id === id && item.deletedAt === undefined);
  if (!item || item.session.request?.requestId !== requestId) return history;
  return updateConversationSession(history, id, {
    version: 1,
    messages: retainedMessages([...item.session.messages, { role: "assistant", content: answer }]),
  });
}
