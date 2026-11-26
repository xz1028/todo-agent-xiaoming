import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { createApp } from "./app.ts";
import { createJsonTaskStore } from "./task-store.ts";

async function startTestApp(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  const conversations: ChatMessage[][] = [];
  const app = createApp({
    tasks: createJsonTaskStore(filename),
    async reply(messages) {
      conversations.push(messages);
      return "收到";
    },
  });

  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }

  return { request, conversations, filename };
}

test("任务 API 可以创建、列出、修改和删除任务", async (t) => {
  const { request } = await startTestApp(t);
  const collection = "/api/tasks";
  assert.deepEqual(await request("GET", collection), { status: 200, body: [] });

  const created = await request("POST", collection, { title: " 买牛奶 " });
  assert.equal(created.status, 201);
  const task = created.body;
  assert.equal(typeof task.id, "string");
  assert.deepEqual(task, { id: task.id, title: "买牛奶", done: false });

  const item = collection + "/" + task.id;
  const completed = await request("PATCH", item, { done: true });
  assert.deepEqual(completed, { status: 200, body: { ...task, done: true } });
  const renamed = await request("PATCH", item, { title: "买面包" });
  assert.deepEqual(renamed, { status: 200, body: { ...task, title: "买面包", done: true } });
  assert.deepEqual((await request("GET", collection)).body, [renamed.body]);

  assert.deepEqual(await request("DELETE", item), { status: 204, body: null });
  assert.deepEqual((await request("GET", collection)).body, []);
});

test("任务 API 拒绝无效输入并区分不存在的任务", async (t) => {
  const { request } = await startTestApp(t);
  assert.equal((await request("POST", "/api/tasks", { title: " " })).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", {})).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", { done: true })).status, 404);
  assert.equal((await request("DELETE", "/api/tasks/missing")).status, 404);
});

test("任务 API 接受 effort 别名并归一化为 workload", async (t) => {
  const { request } = await startTestApp(t);
  const created = await request("POST", "/api/tasks", {
    title: "交报告",
    priority: "high",
    effort: "large",
    dueDate: "2026-11-26",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.title, "交报告");
  assert.equal(created.body.priority, "high");
  assert.equal(created.body.workload, "large");
  assert.equal(created.body.dueDate, "2026-11-26");
  assert.equal(created.body.effort, undefined, "别名不应写入存储");

  const updated = await request("PATCH", `/api/tasks/${created.body.id}`, { effort: "small" });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.workload, "small");
});

test("任务 API 拒绝无效日历日期并保留原数据，接受合法闰日", async (t) => {
  const { request } = await startTestApp(t);
  const created = await request("POST", "/api/tasks", { title: "原任务", dueDate: "2024-02-29" });
  assert.equal(created.status, 201);
  for (const dueDate of ["2026-02-30", "2025-02-29", "1900-02-29", "2026-13-01"]) {
    assert.equal((await request("POST", "/api/tasks", { title: "无效", dueDate })).status, 400);
    assert.equal(
      (await request("PATCH", "/api/tasks/" + created.body.id, { dueDate })).status,
      400,
    );
    assert.deepEqual((await request("GET", "/api/tasks")).body, [created.body]);
  }
});

test("更新已有 JSON 清单时保留其他任务和扩展字段", async (t) => {
  const { request, filename } = await startTestApp(t);
  const first = { id: "a", title: "买牛奶", done: false, priority: 1 };
  const second = { id: "b", title: "取快递", done: false };
  await writeFile(filename, JSON.stringify([first, second]));

  assert.equal((await request("PATCH", "/api/tasks/a", { done: true })).status, 200);
  assert.deepEqual(createJsonTaskStore(filename).list(), [{ ...first, done: true }, second]);
});

test("聊天 API 只将有效的完整对话传给智能体，并返回其回复", async (t) => {
  const { request, conversations } = await startTestApp(t);
  const messages = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好！" },
    { role: "user", content: "今天有哪些待办？" },
  ];
  const valid = await request("POST", "/api/chat", { messages });
  assert.deepEqual(valid, { status: 200, body: { reply: "收到" } });

  const invalid = await request("POST", "/api/chat", { messages: messages.slice(0, 2) });
  assert.equal(invalid.status, 400);
  assert.deepEqual(conversations, [messages]);
});

test("请求防重：并发重试只执行一次，同ID不同内容拒绝，完成回执可读取", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "todo-receipts-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tasks = createJsonTaskStore(join(directory, "tasks.json"));
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const app = createApp({
    tasks,
    requestFile: join(directory, "requests.json"),
    async reply() {
      tasks.create("只创建一次");
      await gate;
      return "已记下";
    },
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const requestId = "11111111-1111-4111-8111-111111111111";
  const body = { requestId, messages: [{ role: "user", content: "帮我新增" }] };
  const send = (payload: unknown) =>
    fetch(url + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  const one = send(body);
  const two = send(body);
  await new Promise((resolve) => setTimeout(resolve, 30));
  release();
  assert.equal((await one).status, 200);
  assert.equal((await two).status, 200);
  assert.equal(tasks.list().length, 1);
  assert.equal(
    (await send({ ...body, messages: [{ role: "user", content: "其他任务" }] })).status,
    409,
  );
  assert.equal((await fetch(url + "/api/chat/" + requestId)).status, 200);
  await send(body);
  assert.equal(tasks.list().length, 1);
});

test("恢复接口：回收站恢复与导入预览保留现有任务", async (t) => {
  const { request } = await startTestApp(t);
  const created = await request("POST", "/api/tasks", { title: "恢复任务" });
  await request("DELETE", "/api/tasks/" + created.body.id);
  const trash = await request("GET", "/api/tasks/trash");
  assert.equal(trash.status, 200);
  assert.equal(
    (await request("POST", "/api/tasks/trash/" + trash.body[0].id + "/restore")).status,
    200,
  );
  const exported = await request("GET", "/api/tasks/export");
  assert.equal(exported.body.tasks.length, 1);
  const input = { tasks: [{ id: "new-import", title: "新增导入", done: false }] };
  const preview = await request("POST", "/api/tasks/import/preview", input);
  assert.equal(preview.body.added, 1);
  assert.equal((await request("GET", "/api/tasks")).body.length, 1);
  assert.equal(
    (await request("POST", "/api/tasks/import", { ...input, token: preview.body.token })).status,
    200,
  );
  assert.equal((await request("GET", "/api/tasks/view?limit=1")).body.total, 2);
});
