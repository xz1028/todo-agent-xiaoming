import type { ChatMessage } from "../shared/chat.ts";
import type { Conversation } from "./conversations.ts";
import { isUuid } from "./session.ts";

function deletionCommand(content: string): string | undefined {
  const match = /^(确认删除|取消删除) ([a-f0-9-]{36})$/u.exec(content.trim());
  return match && isUuid(match[2]) ? match[1] : undefined;
}

/** 只转换已知确认指令的显示，原始消息继续用于发送、保存及请求重试。 */
export function displayMessage(message: ChatMessage): string {
  if (message.role === "user") return deletionCommand(message.content) ?? message.content;
  return message.content
    .split("\n")
    .map((line) => {
      const confirm = /^请在 (\d+) 分钟内回复：(确认删除 .+)$/u.exec(line);
      if (confirm && deletionCommand(confirm[2]) === "确认删除") {
        return `请在 ${confirm[1]} 分钟内，在任务面板点击“确认删除”。`;
      }
      const cancel = /^如需取消，回复：(取消删除 .+)$/u.exec(line);
      if (cancel && deletionCommand(cancel[1]) === "取消删除") {
        return "如需取消，在任务面板点击“取消删除”。";
      }
      return line;
    })
    .join("\n");
}

/** 兼容旧记录由确认指令截断生成的自动标题；用户自定义标题保持原文。 */
export function displayConversationTitle(
  item: Pick<Conversation, "title" | "customTitle">,
): string {
  if (item.customTitle) return item.title;
  return (
    deletionCommand(item.title) ??
    item.title.replace(
      /^(确认删除|取消删除) [a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]$/u,
      "$1",
    )
  );
}
