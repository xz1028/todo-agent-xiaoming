import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createJsonTaskStore } from "./task-store.ts";
import { createDeletionConfirmation } from "./deletion-confirmation.ts";
import { executeTool } from "./agent-tools.ts";
import { createApp } from "./app.ts";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "todo-linkage-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = join(dir, "tasks.json");
  return { store: createJsonTaskStore(filename), filename };
}

test("子任务创建时继承父截止日期，明确日期覆盖，之后改父日期不覆盖孩子", async (t) => {
  const { store } = await fixture(t);
  const parent = store.create("父", { dueDate: "2026-11-27" });
  const inherited = store.create("继承", { parentId: parent.id });
  const explicit = store.create("覆盖", { parentId: parent.id, dueDate: "2026-12-01" });
  assert.equal(inherited.dueDate, "2026-11-27");
  assert.equal(explicit.dueDate, "2026-12-01");
  store.update(parent.id, { dueDate: "2026-12-10" });
  assert.equal(store.list().find((task) => task.id === inherited.id)!.dueDate, "2026-11-27");
  assert.equal(store.create("独立").dueDate, undefined);
});

test("完成父任务带动全部孩子，撤销父任务不撤销孩子，重启后保持", async (t) => {
  const { store, filename } = await fixture(t);
  const parent = store.create("父");
  const a = store.create("A", { parentId: parent.id });
  const b = store.create("B", { parentId: parent.id });
  store.update(parent.id, { done: true });
  assert.ok(store.list().every((task) => task.done));
  store.update(parent.id, { done: false });
  assert.deepEqual(
    createJsonTaskStore(filename)
      .list()
      .map((task) => task.done),
    [false, true, true],
  );
  assert.ok(a && b);
});

test("全部子任务完成才完成父任务，撤销任一子任务会恢复父任务未完成", async (t) => {
  const { store } = await fixture(t);
  const parent = store.create("父");
  const a = store.create("A", { parentId: parent.id });
  const b = store.create("B", { parentId: parent.id });
  store.update(a.id, { done: true });
  assert.equal(store.list()[0].done, false);
  store.update(b.id, { done: true });
  assert.equal(store.list()[0].done, true);
  store.update(a.id, { done: false });
  assert.deepEqual(
    store.list().map((task) => task.done),
    [false, false, true],
  );
});

test("已完成父任务新增未完成子任务后重新打开，改名不触发状态重算", async (t) => {
  const { store } = await fixture(t);
  const parent = store.create("父", { done: true });
  const child = store.create("新增", { parentId: parent.id });
  assert.equal(store.list()[0].done, false);
  store.update(child.id, { done: true });
  store.update(parent.id, { done: false });
  store.update(child.id, { title: "改名" });
  assert.equal(store.list()[0].done, false);
});

test("移动与删除子任务后重新计算受影响父任务，无子任务不自动标完成", async (t) => {
  const { store } = await fixture(t);
  const old = store.create("旧父");
  const next = store.create("新父", { done: true });
  const done = store.create("已完成子", { parentId: old.id, done: true });
  const pending = store.create("未完成子", { parentId: old.id });
  store.update(pending.id, { parentId: next.id });
  assert.equal(store.list().find((task) => task.id === old.id)!.done, true);
  assert.equal(store.list().find((task) => task.id === next.id)!.done, false);
  store.update(old.id, { done: false });
  store.remove(done.id);
  assert.equal(store.list().find((task) => task.id === old.id)!.done, false);
  const second = store.create("新父的完成子", { parentId: next.id, done: true });
  store.remove(pending.id);
  assert.equal(store.list().find((task) => task.id === next.id)!.done, true);
  assert.ok(second);
});

test("联动写入保留旧自定义字段，历史循环状态处理能结束", async (t) => {
  const { store, filename } = await fixture(t);
  await writeFile(
    filename,
    JSON.stringify([
      { id: "a", title: "A", done: false, parentId: "b", custom: "保留" },
      { id: "b", title: "B", done: false, parentId: "a" },
    ]),
  );
  store.update("a", { done: true });
  assert.ok(store.list().every((task) => task.done));
  assert.equal(JSON.parse(await readFile(filename, "utf8"))[0].custom, "保留");
});

test("HTTP 与聊天工具共享继承和完成联动，状态变化让旧删除确认失效", async (t) => {
  const { store } = await fixture(t);
  const app = createApp({ tasks: store, reply: async () => "未调用模型" });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server[Symbol.asyncDispose]());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = await fetch(base + "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "父任务", dueDate: "2026-11-27" }),
  });
  const parent = await post.json();
  const added = JSON.parse(
    executeTool("add_tasks", JSON.stringify({ titles: ["子任务"], parentId: parent.id }), store),
  );
  assert.equal(added.tasks[0].dueDate, parent.dueDate);
  const confirmation = createDeletionConfirmation(store, () => new Date());
  const code = confirmation.finish([parent.id]).match(/确认删除 ([a-f0-9-]{36})/u)![1];
  const patch = await fetch(base + "/api/tasks/" + parent.id, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ done: true }),
  });
  assert.equal(patch.status, 200);
  assert.ok(store.list().every((task) => task.done));
  assert.match(confirmation.respond("确认删除 " + code)!, /变化/u);
  assert.equal(store.list().length, 2);
  executeTool("complete_task", JSON.stringify({ id: added.tasks[0].id, done: false }), store);
  const list = await (await fetch(base + "/api/tasks")).json();
  assert.deepEqual(
    list.map((task: { done: boolean }) => task.done),
    [false, false],
  );
});
