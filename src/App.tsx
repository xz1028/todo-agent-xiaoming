import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { recentMessages } from "../shared/chat-history.ts";
import { api, requestReply, waitForReceipt } from "./chat-client.ts";
import { retainedMessages, type PendingRequest } from "./session.ts";
import {
  activeConversation,
  loadConversations,
  saveConversations,
  newConversation,
  switchConversation,
  renameConversation,
  deleteConversation,
  restoreConversation,
  updateConversationSession,
  finishConversationRequest,
  type ConversationHistory,
} from "./conversations.ts";
import { ConversationList } from "./ConversationList.tsx";
import { ChatHistory } from "./ChatHistory.tsx";
import { TaskPanel } from "./TaskPanel.tsx";
import { displayConversationTitle } from "./message-display.ts";
import { ThemeSelector } from "./ThemeSelector.tsx";

function isSendShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
  const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
  return event.key === "Enter" && !event.shiftKey && !composing;
}

export default function App() {
  const [initial] = useState(loadConversations);
  const [history, setHistory] = useState(initial.history);
  const current = useRef(history);
  const conversation = activeConversation(history);
  const session = conversation.session;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [compactHistory, setCompactHistory] = useState(
    () => window.matchMedia("(max-width: 1100px)").matches,
  );
  const historyButton = useRef<HTMLButtonElement>(null);
  const historyVisible = compactHistory ? historyOpen : !sidebarCollapsed;
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1100px)");
    const update = () => {
      setCompactHistory(media.matches);
      setHistoryOpen(false);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  function closeHistory() {
    if (compactHistory) setHistoryOpen(false);
    else setSidebarCollapsed(true);
    historyButton.current?.focus();
  }
  const [draft, setDraft] = useState("");
  const drafts = useRef(new Map<string, string>());
  const [pending, setPending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [storageWarning, setStorageWarning] = useState(initial.warning ?? "");
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState<"chat" | "tasks">("chat");
  const input = useRef<HTMLTextAreaElement>(null);
  const locked = useRef(false);
  const recovered = useRef(false);
  function commit(next: ConversationHistory) {
    current.current = next;
    setHistory(next);
    setStorageWarning(
      saveConversations(next)
        ? ""
        : "浏览器未能保存历史对话，请先保留当前页面；旧的已保存记录仍在。",
    );
  }
  function complete(request: PendingRequest, answer: string, conversationId: string) {
    const next = finishConversationRequest(
      current.current,
      conversationId,
      request.requestId,
      answer,
    );
    if (next === current.current) return;
    commit(next);
    setRevision((value) => value + 1);
  }
  function changeConversation(
    action: (history: ConversationHistory) => ConversationHistory,
    close = true,
  ) {
    if (locked.current) return;
    try {
      const previousId = current.current.activeId;
      const next = action(current.current);
      commit(next);
      if (next.activeId !== previousId) {
        drafts.current.set(previousId, draft);
        setDraft(drafts.current.get(next.activeId) ?? "");
      }
      setError("");
      if (close) {
        setHistoryOpen(false);
        setTab("chat");
        requestAnimationFrame(() => input.current?.focus());
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法更新会话。");
    }
  }
  async function execute(request: PendingRequest, conversationId: string, recover = false) {
    if (locked.current) return;
    locked.current = true;
    setPending(true);
    setError("");
    setSeconds(0);
    try {
      const answer = recover
        ? await waitForReceipt(request.requestId)
        : await requestReply(request);
      complete(request, answer, conversationId);
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
      const item = activeConversation(current.current);
      if (item.session.request) void execute(item.session.request, item.id, true);
    }
  }, []);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [pending]);
  async function send(text: string) {
    const content = text.trim();
    const item = activeConversation(current.current);
    if (!content || locked.current || item.session.request) return;
    const messages = retainedMessages([...item.session.messages, { role: "user", content }]);
    const request = { requestId: crypto.randomUUID(), messages: recentMessages(messages) };
    commit(updateConversationSession(current.current, item.id, { version: 1, messages, request }));
    drafts.current.delete(item.id);
    setDraft("");
    await execute(request, item.id);
  }
  async function stop() {
    const request = activeConversation(current.current).session.request;
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
        <div className="header-actions">
          <ThemeSelector />
          <button
            ref={historyButton}
            className="quiet"
            aria-label={historyVisible ? "收起历史对话" : "展开历史对话"}
            aria-expanded={historyVisible}
            aria-controls="conversation-history"
            onClick={() => {
              if (compactHistory) setHistoryOpen((value) => !value);
              else setSidebarCollapsed((value) => !value);
            }}
          >
            {historyVisible ? "收起历史" : "历史对话"}
          </button>
          <button
            className="quiet"
            disabled={pending || !!session.request}
            onClick={() => changeConversation(newConversation)}
          >
            新对话
          </button>
        </div>
      </header>
      <nav className="mobile-tabs" aria-label="工作区">
        <button aria-pressed={tab === "chat"} onClick={() => setTab("chat")}>
          对话
        </button>
        <button aria-pressed={tab === "tasks"} onClick={() => setTab("tasks")}>
          任务清单
        </button>
      </nav>
      <div className={"workspace" + (!compactHistory && historyVisible ? " with-history" : "")}>
        <ConversationList
          open={historyVisible}
          compact={compactHistory}
          history={history}
          disabled={pending || !!session.request}
          onClose={closeHistory}
          onNew={() => changeConversation(newConversation)}
          onSelect={(id) => changeConversation((value) => switchConversation(value, id))}
          onRename={(id, title) =>
            changeConversation((value) => renameConversation(value, id, title), false)
          }
          onDelete={(id) => changeConversation((value) => deleteConversation(value, id), false)}
          onRestore={(id) => changeConversation((value) => restoreConversation(value, id))}
        />
        <main className={tab === "chat" ? "chat-pane active" : "chat-pane"}>
          <div className="conversation-heading">
            <h2>{displayConversationTitle(conversation)}</h2>
            <span>当前会话</span>
          </div>
          <ChatHistory
            messages={session.messages}
            pending={pending}
            pendingLabel={stopping ? "正在停止，核对已保存操作…" : `正在处理… ${seconds} 秒`}
            onSelectPrompt={send}
          />
          <div className="compose">
            {storageWarning && (
              <p className="error" role="status">
                {storageWarning}
              </p>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {session.request && !pending && (
              <div className="recovery-actions">
                <button onClick={() => void execute(session.request!, conversation.id, true)}>
                  读取本次回执
                </button>
                <button onClick={() => void execute(session.request!, conversation.id)}>
                  重试同一请求
                </button>
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
