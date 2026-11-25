import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { executeTool } from "./agent-tools.ts";
import { createJsonTaskStore, type TaskStore } from "./task-store.ts";

async function newStore(t: TestContext): Promise<TaskStore> {
  const directory = await mkdtemp(join(tmpdir(), "todo-tools-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return createJsonTaskStore(join(directory, "tasks.json"));
}

function result(raw: string): { ok: boolean; error?: string; tasks?: unknown[] } {
  return JSON.parse(raw);
}

test("add_tasks 支持单条与多条，并 trim 标题", async (t) => {
  const store = await newStore(t);
  const one = result(executeTool("add_tasks", JSON.stringify({ titles: ["  买牛奶  "] }), store));
  assert.equal(one.ok, true);
  assert.equal(store.list()[0].title, "买牛奶");

  const many = result(
    executeTool("add_tasks", JSON.stringify({ titles: ["取快递", "交报告"] }), store),
  );
  assert.equal(many.ok, true);
  assert.deepEqual(
    store.list().map((task) => task.title),
    ["买牛奶", "取快递", "交报告"],
  );
});

test("add_tasks 拒绝空标题与超长标题，返回结构化错误且不落盘", async (t) => {
  const store = await newStore(t);
  const empty = result(executeTool("add_tasks", JSON.stringify({ titles: ["   "] }), store));
  assert.equal(empty.ok, false);
  assert.match(empty.error ?? "", /标题/);

  const tooLong = result(
    executeTool("add_tasks", JSON.stringify({ titles: ["a".repeat(201)] }), store),
  );
  assert.equal(tooLong.ok, false);
  assert.equal(store.list().length, 0);
});

test("executeTool 对非法 JSON、未知工具与参数校验失败返回结构化错误，不抛异常", async (t) => {
  const store = await newStore(t);
  assert.equal(result(executeTool("add_tasks", "{not json", store)).ok, false);
  assert.equal(result(executeTool("no_such_tool", "{}", store)).ok, false);
  assert.equal(
    result(executeTool("add_tasks", JSON.stringify({ titles: "not-array" }), store)).ok,
    false,
  );
});

test("list_tasks 支持 all / pending / done 过滤", async (t) => {
  const store = await newStore(t);
  executeTool("add_tasks", JSON.stringify({ titles: ["A", "B"] }), store);
  const [a] = store.list();
  executeTool("complete_task", JSON.stringify({ id: a.id }), store);

  const all = result(executeTool("list_tasks", "{}", store));
  assert.equal(all.tasks?.length, 2);
  const pending = result(executeTool("list_tasks", JSON.stringify({ filter: "pending" }), store));
  assert.deepEqual(
    (pending.tasks as Array<{ title: string }>).map((task) => task.title),
    ["B"],
  );
  const done = result(executeTool("list_tasks", JSON.stringify({ filter: "done" }), store));
  assert.deepEqual(
    (done.tasks as Array<{ title: string }>).map((task) => task.title),
    ["A"],
  );
});

test("complete_task 支持撤销完成，update_task 改名，delete_task 删除", async (t) => {
  const store = await newStore(t);
  executeTool("add_tasks", JSON.stringify({ titles: ["买牛奶"] }), store);
  const id = store.list()[0].id;

  assert.equal(result(executeTool("complete_task", JSON.stringify({ id }), store)).ok, true);
  assert.equal(store.list()[0].done, true);
  assert.equal(
    result(executeTool("complete_task", JSON.stringify({ id, done: false }), store)).ok,
    true,
  );
  assert.equal(store.list()[0].done, false);

  assert.equal(
    result(executeTool("update_task", JSON.stringify({ id, title: "  买面包  " }), store)).ok,
    true,
  );
  assert.equal(store.list()[0].title, "买面包");

  assert.equal(result(executeTool("delete_task", JSON.stringify({ id }), store)).ok, true);
  assert.equal(store.list().length, 0);
});

test("对不存在的 id 操作返回结构化错误", async (t) => {
  const store = await newStore(t);
  for (const name of ["complete_task", "update_task", "delete_task"]) {
    const raw = result(executeTool(name, JSON.stringify({ id: "missing", title: "x" }), store));
    assert.equal(raw.ok, false);
    assert.match(raw.error ?? "", /找不到|不存在/);
  }
});

const frozenNow = () => new Date("2026-11-25T02:00:00Z"); // 上海时间 2026-11-25 10:00

test("扩展1：清单摘要未完成置顶并显示统计", async (t) => {
  const store = await newStore(t);
  executeTool("add_tasks", JSON.stringify({ titles: ["A", "B"] }), store);
  executeTool("complete_task", JSON.stringify({ id: store.list()[0].id }), store);

  const out = JSON.parse(executeTool("list_tasks", "{}", store, frozenNow)) as {
    ok: boolean;
    summary: string;
  };
  assert.equal(out.ok, true);
  assert.match(out.summary, /共 2 项，未完成 1 项/);
  assert.ok(out.summary.indexOf("⬜ B") < out.summary.indexOf("✅ A"), "未完成应排在前面");
});

test("扩展2：add_tasks 写入 priority 与 effort（workload 别名）", async (t) => {
  const store = await newStore(t);
  const out = JSON.parse(
    executeTool(
      "add_tasks",
      JSON.stringify({
        titles: ["交报告"],
        priority: "high",
        effort: "large",
        dueDate: "2026-11-26",
      }),
      store,
      frozenNow,
    ),
  ) as { ok: boolean; task?: unknown };
  assert.equal(out.ok, true);
  const task = store.list()[0];
  assert.equal(task.priority, "high");
  assert.equal(task.workload, "large", "effort 应归一化为 workload");
  assert.equal(task.dueDate, "2026-11-26");
  const listed = JSON.parse(executeTool("list_tasks", "{}", store, frozenNow)) as {
    summary: string;
  };
  assert.match(listed.summary, /优先级 high/);
  assert.match(listed.summary, /工作量 large/);
  assert.match(listed.summary, /明天|截止 2026-11-26|今天到期|已逾期/);
});

test("扩展2：非法 priority / effort 返回结构化错误", async (t) => {
  const store = await newStore(t);
  const badPriority = result(
    executeTool("add_tasks", JSON.stringify({ titles: ["A"], priority: "urgent" }), store),
  );
  assert.equal(badPriority.ok, false);
  const badEffort = result(
    executeTool("add_tasks", JSON.stringify({ titles: ["A"], effort: "huge" }), store),
  );
  assert.equal(badEffort.ok, false);
  assert.equal(store.list().length, 0);
});

test("扩展3：dueToday 与 overdue 过滤今天/逾期未完成任务", async (t) => {
  const store = await newStore(t);
  const now = frozenNow();
  const today = now.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }); // 2026-11-25
  const earlier = new Date(now);
  earlier.setDate(earlier.getDate() - 2);
  const past = earlier.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });

  executeTool(
    "add_tasks",
    JSON.stringify({ titles: ["今天交", "已过期", "以后做"], dueDate: today }),
    store,
    frozenNow,
  );
  // 逐条设置不同到期日
  const [todayTask, overdueTask, futureTask] = store.list();
  executeTool(
    "update_task",
    JSON.stringify({ id: overdueTask.id, dueDate: past }),
    store,
    frozenNow,
  );
  executeTool(
    "update_task",
    JSON.stringify({ id: futureTask.id, dueDate: "2026-12-01" }),
    store,
    frozenNow,
  );
  assert.ok(todayTask);

  const dueToday = JSON.parse(
    executeTool("list_tasks", JSON.stringify({ dueToday: true }), store, frozenNow),
  ) as { tasks: Array<{ title: string }> };
  assert.deepEqual(
    dueToday.tasks.map((task) => task.title),
    ["今天交"],
  );

  const overdue = JSON.parse(
    executeTool("list_tasks", JSON.stringify({ overdue: true }), store, frozenNow),
  ) as { tasks: Array<{ title: string }> };
  assert.deepEqual(
    overdue.tasks.map((task) => task.title),
    ["已过期"],
  );
});

test("扩展4：删除含子任务的父任务需 cascade 确认", async (t) => {
  const store = await newStore(t);
  executeTool("add_tasks", JSON.stringify({ titles: ["父任务"] }), store, frozenNow);
  const parent = store.list()[0];
  executeTool(
    "add_tasks",
    JSON.stringify({ titles: ["子任务"], parentId: parent.id }),
    store,
    frozenNow,
  );

  const blocked = result(
    executeTool("delete_task", JSON.stringify({ id: parent.id }), store, frozenNow),
  );
  assert.equal(blocked.ok, false);
  assert.match(blocked.error ?? "", /子任务|确认/);
  assert.equal(store.list().length, 2, "未确认时不应删除");

  const confirmed = result(
    executeTool("delete_task", JSON.stringify({ id: parent.id, cascade: true }), store, frozenNow),
  );
  assert.equal(confirmed.ok, true);
  assert.equal(store.list().length, 0, "确认后父任务与子任务一并删除");
});
