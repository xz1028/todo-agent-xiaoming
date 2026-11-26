import type { ChatMessage } from "../shared/chat.ts";

export interface PendingRequest {
  requestId: string;
  messages: ChatMessage[];
}
export interface SavedSession {
  version: 1;
  messages: ChatMessage[];
  request?: PendingRequest;
}
const key = "xiaoming.chat.v1";
export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu.test(value)
  );
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validMessages(value: unknown, max: number): value is ChatMessage[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every(
      (message) =>
        isObject(message) &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim().length > 0 &&
        message.content.length <= 8000,
    )
  );
}
export function parseSavedSession(value: unknown): SavedSession | undefined {
  if (!isObject(value) || value.version !== 1 || !validMessages(value.messages, 100)) return;
  let request: PendingRequest | undefined;
  if (value.request !== undefined) {
    const pending = value.request;
    if (
      !isObject(pending) ||
      !isUuid(pending.requestId) ||
      !validMessages(pending.messages, 200) ||
      pending.messages.at(-1)?.role !== "user"
    )
      return;
    request = { requestId: pending.requestId, messages: pending.messages };
  }
  return { version: 1, messages: value.messages, ...(request ? { request } : {}) };
}
export function loadSession(storage?: Pick<Storage, "getItem">): SavedSession {
  try {
    const raw = (storage ?? localStorage).getItem(key);
    if (raw) {
      const result = parseSavedSession(JSON.parse(raw));
      if (result) return result;
    }
  } catch {
    /* 历史损坏或浏览器禁用存储时仍可使用聊天。 */
  }
  return { version: 1, messages: [] };
}
export function saveSession(session: SavedSession, storage?: Pick<Storage, "setItem">): boolean {
  try {
    (storage ?? localStorage).setItem(key, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}
export function retainedMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice(-100).map((message) => ({
    ...message,
    content:
      message.content.length > 8000
        ? message.content.slice(0, 7900) + "\n（较长内容已截断，请查看任务面板。）"
        : message.content,
  }));
}
