import { useEffect, useRef } from "react";
import type { ChatMessage } from "../shared/chat.ts";

const examplePrompts = [
  "帮我记一下买牛奶",
  "我有哪些任务？",
  "今天有哪些任务到期？",
  "记一下交报告，明天到期，高优先级",
];

interface ChatHistoryProps {
  messages: ChatMessage[];
  pending: boolean;
  onSelectPrompt: (prompt: string) => void;
}

/** 把清单回复按行标注状态：标题加粗、待办正常、已完成淡化并加删除线。 */
function MessageBody({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div>
      {lines.map((line, index) => {
        const className = /^\s*📋/u.test(line)
          ? "list-heading"
          : /^\s*[✅☑]/u.test(line)
            ? "task-done"
            : /^\s*[⬜☐]/u.test(line)
              ? / · 已逾期(?: ·|$)/u.test(line)
                ? "task-pending task-overdue"
                : "task-pending"
              : "";
        return (
          <span key={index} className={className}>
            {line}
            {index < lines.length - 1 ? "\n" : ""}
          </span>
        );
      })}
    </div>
  );
}

export function ChatHistory({ messages, pending, onSelectPrompt }: ChatHistoryProps) {
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [messages, pending]);

  return (
    <div className="scroll" ref={viewport}>
      {messages.length === 0 ? (
        <section className="welcome">
          <img src="/logo.png" alt="" />
          <h1>小明智能体</h1>
          <p>今天有什么待办？</p>
          <div className="examples">
            {examplePrompts.map((prompt) => (
              <button key={prompt} onClick={() => onSelectPrompt(prompt)}>
                {prompt}
                <span aria-hidden="true">↗</span>
              </button>
            ))}
          </div>
        </section>
      ) : (
        <div className="thread" role="log" aria-label="对话记录" aria-live="polite">
          {messages.map((message, index) => (
            <div key={index} className={`message ${message.role}`}>
              <small>{message.role === "user" ? "你" : "小明智能体"}</small>
              <MessageBody content={message.content} />
            </div>
          ))}
          {pending && <p role="status">正在回复…</p>}
        </div>
      )}
    </div>
  );
}
