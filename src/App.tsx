import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { recentMessages } from "../shared/chat-history.ts";
import { api, requestReply, waitForReceipt } from "./chat-client.ts";
import {
  loadSession,
  retainedMessages,
  saveSession,
  type PendingRequest,
  type SavedSession,
} from "./session.ts";
import { ChatHistory } from "./ChatHistory.tsx";
import { TaskPanel } from "./TaskPanel.tsx";

function isSendShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
  const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
  return event.key === "Enter" && !event.shiftKey && !composing;
}

export default function App() {
  const [session, setSession] = useState(loadSession);
  const current = useRef(session);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [storageWarning, setStorageWarning] = useState(false);
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState<"chat" | "tasks">("chat");
  const input = useRef<HTMLTextAreaElement>(null);
  const locked = useRef(false);
  const recovered = useRef(false);
  function commit(next: SavedSession) {
    current.current = next;
    setSession(next);
    setStorageWarning(!saveSession(next));
  }
  function complete(request: PendingRequest, answer: string) {
    if (current.current.request?.requestId !== request.requestId) return;
    commit({
      version: 1,
      messages: retainedMessages([
        ...current.current.messages,
        { role: "assistant", content: answer },
      ]),
    });
    setRevision((value) => value + 1);
  }
  async function execute(request: PendingRequest, recover = false) {
    if (locked.current) return;
    locked.current = true;
    setPending(true);
    setError("");
    setSeconds(0);
    try {
      const answer = recover
        ? await waitForReceipt(request.requestId)
        : await requestReply(request);
      complete(request, answer);
    } catch (cause) {
      setError(
        (cause instanceof Error ? cause.message : "连接中断。") +
          " 本次请求编号已保留，请核对任务后读取回执或重试同一请求。",
      );
      setRevision((value) => value + 1);
    } finally {
      locked.current = false;
      setPending(false);
      setStopping(false);
      requestAnimationFrame(() => input.current?.focus());
    }
  }
  useEffect(() => {
    if (!recovered.current) {
      recovered.current = true;
      if (current.current.request) void execute(current.current.request, true);
    }
  }, []);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [pending]);
  async function send(text: string) {
    const content = text.trim();
    if (!content || locked.current || current.current.request) return;
    const messages = retainedMessages([...current.current.messages, { role: "user", content }]);
    const request = { requestId: crypto.randomUUID(), messages: recentMessages(messages) };
    commit({ version: 1, messages, request });
    setDraft("");
    await execute(request);
  }
  async function stop() {
    const request = current.current.request;
    if (!request) return;
    setStopping(true);
    try {
      await api("/api/chat/" + request.requestId + "/cancel", "POST");
    } catch (cause) {
      setStopping(false);
      setError(cause instanceof Error ? cause.message : "停止请求未送达，请读取回执。");
    }
  }
  return (
    <div className="app">
      <header>
        <img src="/logo.png" alt="" />
        <strong>TokeNow</strong>
        <span>小明智能体</span>
        <button
          className="quiet header-action"
          disabled={pending || !!session.request}
          onClick={() => commit({ version: 1, messages: [] })}
        >
          新对话
        </button>
      </header>
      <nav className="mobile-tabs" aria-label="工作区">
        <button aria-pressed={tab === "chat"} onClick={() => setTab("chat")}>
          对话
        </button>
        <button aria-pressed={tab === "tasks"} onClick={() => setTab("tasks")}>
          任务清单
        </button>
      </nav>
      <div className="workspace">
        <main className={tab === "chat" ? "chat-pane active" : "chat-pane"}>
          <ChatHistory
            messages={session.messages}
            pending={pending}
            pendingLabel={stopping ? "正在停止，核对已保存操作…" : `正在处理… ${seconds} 秒`}
            onSelectPrompt={send}
          />
          <div className="compose">
            {storageWarning && (
              <p className="error" role="status">
                浏览器未能保存对话，刷新后可能无法恢复。本次请求可在当前页面继续处理。
              </p>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {session.request && !pending && (
              <div className="recovery-actions">
                <button onClick={() => void execute(session.request!, true)}>读取本次回执</button>
                <button onClick={() => void execute(session.request!)}>重试同一请求</button>
              </div>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void send(draft);
              }}
            >
              <textarea
                aria-label="消息"
                ref={input}
                placeholder="输入消息…"
                rows={2}
                maxLength={4000}
                value={draft}
                readOnly={pending || !!session.request}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (isSendShortcut(event)) {
                    event.preventDefault();
                    void send(draft);
                  }
                }}
              />
              {pending ? (
                <button
                  type="button"
                  className="stop"
                  disabled={stopping}
                  onClick={() => void stop()}
                >
                  停止
                </button>
              ) : (
                <button
                  className="send"
                  disabled={!!session.request || !draft.trim()}
                  aria-label="发送消息"
                >
                  ↑
                </button>
              )}
            </form>
            <small>Enter 发送 · Shift + Enter 换行 · 对话保存在此浏览器</small>
          </div>
        </main>
        <TaskPanel
          active={tab === "tasks"}
          revision={revision}
          disabled={pending || !!session.request}
          onSend={send}
        />
      </div>
    </div>
  );
}
