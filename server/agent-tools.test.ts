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
