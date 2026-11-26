import type { ChatMessage } from "./chat.ts";

/** 保留最近完整轮次，任务状态始终重新查询；不把旧历史伪装成可靠摘要。 */
export function recentMessages(messages: ChatMessage[]): ChatMessage[] {
  let size = 0;
  let start = messages.length;
  while (start > 0 && messages.length - start < 24) {
    const next = messages[start - 1];
    if (start < messages.length && size + next.content.length > 12_000) break;
    size += next.content.length;
    start -= 1;
  }
  while (start < messages.length - 1 && messages[start]?.role !== "user") start += 1;
  return messages.slice(start);
}
