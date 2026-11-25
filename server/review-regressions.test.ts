import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { transformSync } from "esbuild";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatMessage } from "../shared/chat.ts";
import { executeTool } from "./agent-tools.ts";
import { createApp } from "./app.ts";
import { createDeletionConfirmation } from "./deletion-confirmation.ts";
import { createJsonTaskStore } from "./task-store.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "todo-review-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  const store = createJsonTaskStore(filename);
  const server = createApp({ tasks: store, reply: async () => "未使用模型" }).listen(
    0,
    "127.0.0.1",
  );
  await once(server, "listening");
  t.after(() => server[Symbol.asyncDispose]());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(method: string, path: string, body: unknown) {
    const response = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  return { store, filename, request };
}

test("HTTP 和工具拒绝不存在父任务及第三层，并保持原数据", async (t) => {
  const { store, request } = await fixture(t);
  const parent = store.create("父任务");
  const child = store.create("子任务", { parentId: parent.id });
  const original = store.list();
  for (const parentId of ["missing", "", child.id]) {
    assert.equal((await request("POST", "/api/tasks", { title: "拒绝", parentId })).status, 400);
    const out = JSON.parse(
      executeTool("add_tasks", JSON.stringify({ titles: ["拒绝"], parentId }), store),
    );
    assert.equal(out.ok, false);
    assert.deepEqual(store.list(), original);
  }
});

test("重挂接拒绝自指、环、含子任务的父任务降级和不存在目标", async (t) => {
  const { store, request } = await fixture(t);
  const a = store.create("A");
  const b = store.create("B");
  const child = store.create("A的子任务", { parentId: a.id });
  const original = store.list();
  for (const [id, parentId] of [
    [a.id, a.id],
    [a.id, child.id],
    [a.id, b.id],
    [child.id, "missing"],
  ]) {
    assert.equal((await request("PATCH", `/api/tasks/${id}`, { parentId })).status, 400);
    assert.equal(
      JSON.parse(executeTool("update_task", JSON.stringify({ id, parentId }), store)).ok,
      false,
    );
    assert.deepEqual(store.list(), original);
  }
  assert.equal((await request("PATCH", `/api/tasks/${child.id}`, { parentId: b.id })).status, 200);
});

test("历史深层任务的删除确认涵盖全部后代，后代变化使快照失效", async (t) => {
  const { store, filename } = await fixture(t);
  const legacy = [
    { id: "a", title: "父", done: false },
    { id: "b", title: "子", done: false, parentId: "a" },
    { id: "c", title: "孙", done: false, parentId: "b" },
    { id: "other", title: "保留", done: false },
  ];
  await writeFile(filename, JSON.stringify(legacy));
  const deletion = createDeletionConfirmation(store, () => new Date());
  const prompt = deletion.finish(["a"]);
  assert.match(prompt, /以下 3 项/u);
  let code = prompt.match(/确认删除 ([a-f0-9-]{36})/u)![1];
  store.update("c", { title: "修改孙任务" });
  assert.match(deletion.respond("确认删除 " + code)!, /变化/u);
  assert.equal(store.list().length, 4);
  code = deletion.finish(["a"]).match(/确认删除 ([a-f0-9-]{36})/u)![1];
  assert.match(deletion.respond("确认删除 " + code)!, /已删除 3/u);
  assert.deepEqual(store.list(), [legacy[3]]);
});

test("旧循环关系的删除会终止且保留无关数据", async (t) => {
  const { store, filename } = await fixture(t);
  await writeFile(
    filename,
    JSON.stringify([
      { id: "a", title: "A", done: false, parentId: "c" },
      { id: "b", title: "B", done: false, parentId: "a" },
      { id: "c", title: "C", done: false, parentId: "b" },
      { id: "keep", title: "保留", done: false },
    ]),
  );
  assert.equal(store.removeMany(["a"]), 3);
  assert.equal(store.list()[0].id, "keep");
});

test("工作量冲突别名在 HTTP 与工具的创建和更新中一致拒绝，相同值可接受", async (t) => {
  const { store, request } = await fixture(t);
  const task = store.create("原任务");
  const conflict = { effort: "small", workload: "large" };
  assert.equal((await request("POST", "/api/tasks", { title: "冲突", ...conflict })).status, 400);
  assert.equal((await request("PATCH", `/api/tasks/${task.id}`, conflict)).status, 400);
  assert.equal(
    JSON.parse(executeTool("add_tasks", JSON.stringify({ titles: ["冲突"], ...conflict }), store))
      .ok,
    false,
  );
  assert.equal(
    JSON.parse(executeTool("update_task", JSON.stringify({ id: task.id, ...conflict }), store)).ok,
    false,
  );
  assert.deepEqual(store.list(), [task]);
  assert.equal(
    (await request("PATCH", `/api/tasks/${task.id}`, { effort: "small", workload: "small" })).body
      .workload,
    "small",
  );
  assert.equal(
    JSON.parse(
      executeTool(
        "update_task",
        JSON.stringify({ id: task.id, effort: "large", workload: "large" }),
        store,
      ),
    ).task.workload,
    "large",
  );
});

test("真实消息组件只按行首状态着色，标题里的 emoji 不改变完成状态", async () => {
  const source = await readFile(new URL("../src/ChatHistory.tsx", import.meta.url), "utf8");
  const { code } = transformSync(source, { loader: "tsx", format: "cjs", jsx: "transform" });
  const compiled = {
    exports: {} as {
      ChatHistory: React.ComponentType<{
        messages: ChatMessage[];
        pending: boolean;
        onSelectPrompt: () => void;
      }>;
    },
  };
  new Function("require", "module", "exports", "React", code)(
    createRequire(import.meta.url),
    compiled,
    compiled.exports,
    React,
  );
  const html = renderToStaticMarkup(
    React.createElement(compiled.exports.ChatHistory, {
      messages: [{ role: "assistant", content: "⬜ 检查 ✅ 图标\n✅ 已完成 ⬜ 示例\n普通文字 ✅" }],
      pending: false,
      onSelectPrompt: () => {},
    }),
  );
  assert.match(html, /class="task-pending">⬜ 检查 ✅ 图标/u);
  assert.match(html, /class="task-done">✅ 已完成 ⬜ 示例/u);
  assert.match(html, /class="">普通文字 ✅/u);
});
