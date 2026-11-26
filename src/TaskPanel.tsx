import { useEffect, useRef, useState } from "react";
import type { Task, TrashEntry } from "../server/task-store.ts";
import { api } from "./chat-client.ts";

interface Card extends Task {
  group: "pending" | "overdue" | "done";
  parentTitle?: string;
  progress?: { done: number; total: number };
}
interface Page {
  tasks: Card[];
  total: number;
  nextOffset?: number;
}
interface Deletion {
  code: string;
  expiresAt: number;
  tasks: Task[];
}
interface Preview {
  tasks: Task[];
  added: number;
  skipped: number;
  token: string;
}
interface Props {
  active: boolean;
  revision: number;
  disabled: boolean;
  onSend: (text: string) => Promise<void>;
}
const labels = { pending: "待处理", overdue: "已逾期", done: "已完成" };
const priorityLabels = { high: "高优先级", medium: "中优先级", low: "低优先级" };
const effortLabels = { small: "小工作量", medium: "中工作量", large: "大工作量" };

export function TaskPanel({ active, revision, disabled, onSend }: Props) {
  const [page, setPage] = useState<Page>({ tasks: [], total: 0 });
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<"tasks" | "trash">("tasks");
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  const [deletion, setDeletion] = useState<Deletion | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [clock, setClock] = useState(Date.now());
  const actionLock = useRef(false);
  const previewSection = useRef<HTMLElement>(null);
  useEffect(() => {
    if (preview) previewSection.current?.focus();
  }, [preview]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ filter, offset: String(offset), limit: "20" });
    if (search.trim()) query.set("search", search.trim());
    void Promise.all([
      api<Page>("/api/tasks/view?" + query),
      api<Deletion | null>("/api/deletion"),
      mode === "trash" ? api<TrashEntry[]>("/api/tasks/trash") : Promise.resolve([]),
    ])
      .then(([next, pending, removed]) => {
        if (!alive) return;
        setPage(next);
        setDeletion(pending);
        setTrash(removed);
        if (offset > 0 && !next.tasks.length) setOffset(Math.max(0, offset - 20));
      })
      .catch((cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : "无法加载任务。");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [revision, reload, offset, filter, search, mode]);
  useEffect(() => {
    const refresh = () => setReload((value) => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  useEffect(() => {
    if (!deletion) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deletion]);
  async function action(work: () => Promise<void>) {
    if (actionLock.current || disabled) return;
    actionLock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      setReload((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作未完成，请刷新核对。");
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  async function importFile(file: File) {
    if (file.size > 900_000) throw new Error("文件过大，请使用小于900KB的任务导出文件。");
    const raw: unknown = JSON.parse(await file.text());
    const tasks = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object" && "tasks" in raw
        ? raw.tasks
        : undefined;
    const result = await api<Omit<Preview, "tasks">>("/api/tasks/import/preview", "POST", {
      tasks,
    });
    setPreview({ ...result, tasks: tasks as Task[] });
  }
  const locked = disabled || busy;
  return (
    <aside className={active ? "task-panel active" : "task-panel"} aria-label="任务面板">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">小明的记事本</p>
          <h2>任务清单</h2>
        </div>
        <button className="quiet" disabled={busy} onClick={() => setReload((value) => value + 1)}>
          刷新
        </button>
      </div>
      <div className="panel-tools">
        <button aria-pressed={mode === "tasks"} onClick={() => setMode("tasks")}>
          当前任务
        </button>
        <button aria-pressed={mode === "trash"} onClick={() => setMode("trash")}>
          回收站
        </button>
        <button
          disabled={locked}
          onClick={() =>
            void action(async () => {
              const data = await api("/api/tasks/export");
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
              );
              const link = document.createElement("a");
              link.href = url;
              link.download = "xiaoming-tasks-" + new Date().toLocaleDateString("en-CA") + ".json";
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              setNotice("已导出当前任务，回收站记录请单独恢复后再导出。");
            })
          }
        >
          导出
        </button>
        <label className={locked ? "file-button disabled" : "file-button"}>
          导入
          <input
            type="file"
            accept=".json,application/json"
            aria-label="导入任务文件"
            disabled={locked}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void action(() => importFile(file));
            }}
          />
        </label>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="panel-note" role="status">
          {notice}
        </p>
      )}
      {preview && (
        <section
          ref={previewSection}
          tabIndex={-1}
          className="import-preview"
          aria-label="导入预览"
        >
          <h3>导入预览</h3>
          <p>
            新增 {preview.added} 项，跳过相同记录 {preview.skipped} 项。
          </p>
          <p className="panel-note">只合并活动任务；同 ID 的不同内容会拒绝导入。</p>
          <ul>
            {preview.tasks.slice(0, 10).map((task) => (
              <li key={task.id}>{task.title}</li>
            ))}
          </ul>
          {preview.tasks.length > 10 && <p>另有 {preview.tasks.length - 10} 项</p>}
          <button
            disabled={locked}
            onClick={() =>
              void action(async () => {
                const result = await api<{ added: number }>("/api/tasks/import", "POST", {
                  tasks: preview.tasks,
                  token: preview.token,
                });
                setPreview(null);
                setNotice("已导入 " + result.added + " 项任务。");
              })
            }
          >
            确认导入
          </button>
          <button disabled={busy} onClick={() => setPreview(null)}>
            取消
          </button>
        </section>
      )}
      {deletion && deletion.expiresAt > clock && (
        <section className="deletion-preview" aria-label="待确认删除">
          <h3>待确认删除 · {deletion.tasks.length} 项</h3>
          <details>
            <summary>查看全部删除目标</summary>
            <ul>
              {deletion.tasks.map((task) => (
                <li key={task.id}>{task.title}</li>
              ))}
            </ul>
          </details>
          <p className="panel-note">
            {Math.max(1, Math.ceil((deletion.expiresAt - clock) / 60_000))}{" "}
            分钟内有效，包含关联子任务。
          </p>
          <button disabled={locked} onClick={() => void onSend("确认删除 " + deletion.code)}>
            确认删除
          </button>
          <button disabled={locked} onClick={() => void onSend("取消删除 " + deletion.code)}>
            取消删除
          </button>
        </section>
      )}
      {mode === "tasks" ? (
        <>
          <div className="task-filters">
            <input
              aria-label="搜索任务"
              placeholder="按标题搜索"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setOffset(0);
              }}
            />
            <select
              aria-label="任务状态"
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                setOffset(0);
              }}
            >
              <option value="all">全部状态</option>
              <option value="pending">未完成</option>
              <option value="done">已完成</option>
            </select>
          </div>
          <p className="panel-note" role="status">
            {loading ? "正在更新清单…" : `匹配 ${page.total} 项 · 本页 ${page.tasks.length} 项`}
          </p>
          <div className="task-cards" aria-busy={loading}>
            {!loading && !page.tasks.length && (
              <p className="empty-note">这里还没有任务，和小明说一句就能记下来。</p>
            )}
            {(["pending", "overdue", "done"] as const).map((group) => {
              const items = page.tasks.filter((task) => task.group === group);
              return items.length ? (
                <section key={group} className={"task-group " + group}>
                  <h3>
                    {labels[group]} <span>{items.length}</span>
                  </h3>
                  {items.map((task) => (
                    <article
                      key={task.id}
                      className={
                        "task-card " +
                        (task.parentId ? "subtask " : "") +
                        (task.done ? "completed" : "")
                      }
                    >
                      <label className="task-title">
                        <input
                          type="checkbox"
                          checked={task.done}
                          disabled={locked || loading}
                          aria-label={(task.done ? "撤销完成：" : "完成：") + task.title}
                          onChange={() =>
                            void action(async () => {
                              await api("/api/tasks/" + encodeURIComponent(task.id), "PATCH", {
                                done: !task.done,
                              });
                              setNotice("已更新「" + task.title + "」。");
                            })
                          }
                        />
                        <span>{task.title}</span>
                      </label>
                      {task.parentId && (
                        <p className="parent-name">↳ {task.parentTitle ?? "父任务不在当前清单"}</p>
                      )}
                      <div className="task-badges">
                        {task.dueDate && (
                          <span className={group === "overdue" ? "badge overdue-badge" : "badge"}>
                            {group === "overdue" ? "已逾期 · " : "截止 "}
                            {task.dueDate}
                          </span>
                        )}
                        {task.priority && (
                          <span className={"badge priority-" + task.priority}>
                            {priorityLabels[task.priority] ?? task.priority}
                          </span>
                        )}
                        {task.workload && (
                          <span className="badge">
                            {effortLabels[task.workload] ?? task.workload}
                          </span>
                        )}
                      </div>
                      {task.progress && (
                        <div className="child-progress">
                          <progress
                            value={task.progress.done}
                            max={task.progress.total}
                            aria-label={task.title + "子任务完成进度"}
                          />
                          <small>
                            {task.progress.done}/{task.progress.total} 已完成
                          </small>
                        </div>
                      )}
                    </article>
                  ))}
                </section>
              ) : null;
            })}
          </div>
          <div className="pagination">
            <button
              disabled={offset === 0 || loading}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              上一页
            </button>
            <span>第 {Math.floor(offset / 20) + 1} 页</span>
            <button
              disabled={page.nextOffset === undefined || loading}
              onClick={() => setOffset(page.nextOffset!)}
            >
              下一页
            </button>
          </div>
        </>
      ) : (
        <div className="trash-list">
          <p className="panel-note">按删除批次恢复，包含当时删除的子任务。</p>
          {!loading && !trash.length && <p className="empty-note">回收站为空。</p>}
          {trash.map((entry) => (
            <article className="task-card" key={entry.id}>
              <strong>{entry.tasks.length} 项任务</strong>
              <ul>
                {entry.tasks.slice(0, 5).map((task) => (
                  <li key={task.id}>{task.title}</li>
                ))}
              </ul>
              {entry.tasks.length > 5 && (
                <details>
                  <summary>查看其余 {entry.tasks.length - 5} 项</summary>
                  <ul>
                    {entry.tasks.slice(5).map((task) => (
                      <li key={task.id}>{task.title}</li>
                    ))}
                  </ul>
                </details>
              )}
              <small>{new Date(entry.deletedAt).toLocaleString("zh-CN")}</small>
              <button
                disabled={locked || loading}
                onClick={() =>
                  void action(async () => {
                    await api(
                      "/api/tasks/trash/" + encodeURIComponent(entry.id) + "/restore",
                      "POST",
                    );
                    setNotice("已恢复本批任务。");
                  })
                }
              >
                恢复这一批
              </button>
            </article>
          ))}
        </div>
      )}
    </aside>
  );
}
