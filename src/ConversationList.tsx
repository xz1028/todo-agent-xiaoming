import { useEffect, useRef, useState } from "react";
import { displayMessage, displayConversationTitle } from "./message-display.ts";
import type { ConversationHistory } from "./conversations.ts";

interface Props {
  open: boolean;
  compact: boolean;
  history: ConversationHistory;
  disabled: boolean;
  onClose: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
}
export function ConversationList({
  open,
  compact,
  history,
  disabled,
  onClose,
  onNew,
  onSelect,
  onRename,
  onDelete,
  onRestore,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [removed, setRemoved] = useState(false);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (open && compact) {
      if (!dialog.current?.open) dialog.current?.showModal();
    } else {
      dialog.current?.close();
    }
    if (!open) {
      setEditing(null);
      setError("");
      setRemoved(false);
      setSearch("");
    }
  }, [open, compact]);
  useEffect(() => {
    setRemoved(false);
    setSearch("");
    setEditing(null);
    setError("");
  }, [history.activeId]);
  const count = history.conversations.filter((item) => item.deletedAt !== undefined).length;
  const items = history.conversations
    .filter((item) =>
      removed
        ? item.deletedAt !== undefined
        : item.deletedAt === undefined &&
          (item.session.messages.length || item.customTitle || item.session.request),
    )
    .filter((item) =>
      displayConversationTitle(item)
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
    )
    .toSorted((a, b) => (b.deletedAt ?? b.updatedAt) - (a.deletedAt ?? a.updatedAt));
  const content = (
    <div className="history-shell">
      <div className="history-top">
        <div>
          <p className="eyebrow">保留每一次对话</p>
          <h2 id="history-title">历史对话</h2>
        </div>
        <button
          className="quiet"
          aria-label={compact ? "关闭历史对话" : "收起历史对话"}
          onClick={onClose}
        >
          {compact ? "关闭" : "收起"}
        </button>
      </div>
      <div className="history-toolbar">
        <button className="history-new" disabled={disabled} onClick={onNew}>
          ＋ 新对话
        </button>
        <div className="history-tabs">
          <button
            aria-pressed={!removed}
            onClick={() => {
              setRemoved(false);
              setEditing(null);
            }}
          >
            会话列表
          </button>
          <button
            aria-pressed={removed}
            onClick={() => {
              setRemoved(true);
              setEditing(null);
            }}
          >
            最近删除（{count}）
          </button>
        </div>
        <input
          aria-label="搜索会话标题"
          placeholder="搜索会话标题"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {disabled && (
        <p className="history-hint" role="status">
          当前请求尚未结束或核对。完成、停止并读取回执后，可以切换或整理会话。
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul className="conversation-list">
        {!items.length && (
          <li className="history-empty">
            {search.trim()
              ? "没有匹配的会话。"
              : removed
                ? "最近删除为空。"
                : "还没有历史对话，发送消息后会自动保存。"}
          </li>
        )}
        {items.map((item) => (
          <li
            key={item.id}
            className={"conversation-row " + (history.activeId === item.id ? "selected" : "")}
          >
            {editing === item.id ? (
              <form
                className="rename-conversation"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!title.trim()) {
                    setError("会话标题不能为空。");
                    return;
                  }
                  onRename(item.id, title);
                  setEditing(null);
                  setError("");
                }}
              >
                <label>
                  会话标题
                  <input
                    autoFocus
                    aria-label="新的会话标题"
                    value={title}
                    maxLength={60}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>
                <div>
                  <button disabled={disabled} type="submit">
                    保存名称
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(null);
                      setError("");
                    }}
                  >
                    取消
                  </button>
                </div>
              </form>
            ) : (
              <>
                <button
                  className="conversation-select"
                  disabled={disabled || removed}
                  aria-current={history.activeId === item.id && !removed ? "true" : undefined}
                  aria-label={"打开会话：" + displayConversationTitle(item)}
                  onClick={() => onSelect(item.id)}
                >
                  <span className="conversation-name">{displayConversationTitle(item)}</span>
                  <span className="conversation-preview">
                    {displayMessage(
                      item.session.messages.at(-1) ?? { role: "assistant", content: "暂无消息" },
                    ).slice(0, 80)}
                  </span>
                  <span className="conversation-meta">
                    <time dateTime={new Date(item.deletedAt ?? item.updatedAt).toISOString()}>
                      {new Date(item.deletedAt ?? item.updatedAt).toLocaleString("zh-CN", {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                    {history.activeId === item.id && !removed && <span>当前会话</span>}
                    {item.session.request && <span>待核对</span>}
                  </span>
                </button>
                <div className="conversation-actions">
                  {removed ? (
                    <button
                      disabled={disabled}
                      aria-label={"恢复会话：" + displayConversationTitle(item)}
                      onClick={() => onRestore(item.id)}
                    >
                      恢复并打开
                    </button>
                  ) : (
                    <>
                      <button
                        disabled={disabled}
                        aria-label={"重命名会话：" + displayConversationTitle(item)}
                        onClick={() => {
                          setEditing(item.id);
                          setTitle(displayConversationTitle(item));
                          setError("");
                        }}
                      >
                        重命名
                      </button>
                      <button
                        disabled={disabled}
                        aria-label={"删除会话：" + displayConversationTitle(item)}
                        onClick={() => onDelete(item.id)}
                      >
                        删除
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="history-footer">
        记录保存在此浏览器，每个会话最多100条消息。删除可恢复，所有会话共用待办清单。
      </p>
    </div>
  );
  return compact ? (
    <dialog
      id="conversation-history"
      ref={dialog}
      className="conversation-dialog"
      aria-labelledby="history-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {content}
    </dialog>
  ) : (
    <aside
      id="conversation-history"
      className="conversation-sidebar"
      aria-labelledby="history-title"
      hidden={!open}
    >
      {content}
    </aside>
  );
}
