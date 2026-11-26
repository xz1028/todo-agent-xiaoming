import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { startService } from "../scripts/acceptance.ts";
import { summaryOf } from "./agent-tools.ts";
import { createApp } from "./app.ts";
import { createDeletionConfirmation } from "./deletion-confirmation.ts";
import { createJsonTaskStore } from "./task-store.ts";

const repository = resolve(import.meta.dirname, "..");

async function target(
  t: TestContext,
  { ignoreCreation = false, wrongDate = false, fakeParentConfirmation = false } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "todo-acceptance-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tasks = createJsonTaskStore(join(directory, "tasks.json"));
  const deletion = createDeletionConfirmation(tasks, () => new Date());
  let step = 0;
  let parentDeletionSeen = false;
  const app = createApp({
    tasks,
    async reply(messages) {
      if (ignoreCreation) return "已记下买牛奶";
      step += 1;
      if (step > 6) {
        const text = messages.at(-1)!.content;
        const confirmed = deletion.respond(text);
        if (confirmed !== undefined) return confirmed;
        if (text.startsWith("帮我记一下交验收报告")) {
          tasks.create("交验收报告", {
            dueDate: new Date(Date.now() + (wrongDate ? 0 : 86_400_000)).toLocaleDateString(
              "en-CA",
              { timeZone: "Asia/Shanghai" },
            ),
            priority: "high",
            workload: "large",
          });
        } else if (text.startsWith("今天有哪些任务到期")) {
          const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
          return summaryOf(
            tasks.list().filter((task) => !task.done && !!task.dueDate && task.dueDate <= today),
          );
        } else if (text.startsWith("删除「今天到期验收」")) {
          return deletion.finish(
            tasks
              .list()
              .filter((task) => ["今天到期验收", "逾期待办验收"].includes(task.title))
              .map((task) => task.id),
          );
        } else if (text.startsWith("帮我记一条父任务")) {
          tasks.create("验收出行");
        } else if (text.startsWith("给「验收出行」添加子任务")) {
          tasks.create("验收买票", {
            parentId: tasks.list().find((task) => task.title === "验收出行")!.id,
          });
        } else if (text.includes("删除「验收出行」")) {
          if (fakeParentConfirmation && !parentDeletionSeen) {
            parentDeletionSeen = true;
            return "确认删除 11111111-1111-4111-8111-111111111111";
          }
          return deletion.finish([tasks.list().find((task) => task.title === "验收出行")!.id]);
        } else if (text === "把联系张这条标为完成") {
          return "你要完成的是联系张老师还是联系张同学？";
        }
        return summaryOf(tasks.list());
      }
      if (step === 1) tasks.create("买牛奶");
      if (step === 2) tasks.create("取快递");
      if (step === 4) tasks.update(tasks.list()[0].id, { done: true });
      if (step === 5) tasks.remove(tasks.list()[1].id);
      return (
        tasks
          .list()
          .map((task) => (task.done ? "✅ " : "⬜ ") + task.title)
          .join("\n") || "已记下买牛奶"
      );
    },
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  return { tasks, url: "http://127.0.0.1:" + (server.address() as AddressInfo).port };
}

function run(baseUrl = "", extended = false, environment: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolveResult) => {
    execFile(
      process.execPath,
      ["scripts/acceptance.ts", ...(extended ? ["--extended"] : [])],
      {
        cwd: repository,
        env: { ...process.env, BASE_URL: baseUrl, DEEPSEEK_API_KEY: "", ...environment },
        timeout: 5_000,
      },
      (error, stdout, stderr) => {
        resolveResult({
          code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

test("验收 CLI：六步真实 HTTP 状态正确时退出成功", async (t) => {
  const service = await target(t);
  const output = await run(service.url);
  assert.equal(output.code, 0, output.stderr);
  assert.deepEqual(
    service.tasks.list().map(({ title, done }) => ({ title, done })),
    [{ title: "买牛奶", done: true }],
  );
});

test("验收 CLI：模型声称成功但任务未创建时必须非零退出", async (t) => {
  const service = await target(t, { ignoreCreation: true });
  const output = await run(service.url);
  assert.notEqual(output.code, 0);
  assert.match(output.stderr, /第 1 步|创建.*失败|状态不符合/u);
});

test("验收 CLI：拒绝已有任务的外部目标且不删除用户数据", async (t) => {
  const service = await target(t);
  const existing = service.tasks.create("用户原有任务");
  const output = await run(service.url);
  assert.notEqual(output.code, 0);
  assert.match(output.stderr, /空清单|已有任务|非空/u);
  assert.deepEqual(service.tasks.list(), [existing]);
});

test("验收 CLI：默认模式缺少 key 时在启动隔离服务前明确失败", async () => {
  const output = await run();
  assert.notEqual(output.code, 0);
  assert.match(output.stderr, /DEEPSEEK_API_KEY/u);
});

test("验收 CLI：空白 BASE_URL 使用隔离服务，不将空字符串当作地址", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "todo-acceptance-transport-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preload = join(directory, "transport.mjs");
  await writeFile(
    preload,
    [
      "const nativeFetch = globalThis.fetch;",
      "globalThis.fetch = (input, init) => new URL(String(input)).hostname === 'api.deepseek.com'",
      "  ? Promise.resolve(new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } }))",
      "  : nativeFetch(input, init);",
    ].join("\n"),
  );
  for (const baseUrl of ["", "   "]) {
    const output = await run(baseUrl, false, {
      DEEPSEEK_API_KEY: "test-only-placeholder",
      NODE_OPTIONS: "--import=" + pathToFileURL(preload).href,
    });
    // 受控模型不创建任务，因此应进入真实隔离服务后由第一步状态断言拒绝。
    assert.notEqual(output.code, 0);
    assert.match(output.stderr, /第 1 步状态不符合|模型调用未完成/u);
    assert.doesNotMatch(output.stderr, /Invalid URL/u);
  }
});

test("扩展验收 CLI：相对日期、并集筛选、删除确认和歧义均正确时通过", async (t) => {
  const service = await target(t);
  const output = await run(service.url, true);
  assert.equal(output.code, 0, output.stderr);
  assert.match(output.stdout, /PASS 相似任务消歧/u);
});

test("扩展验收 CLI：模型写错相对日期时非零退出", async (t) => {
  const service = await target(t, { wrongDate: true });
  const output = await run(service.url, true);
  assert.notEqual(output.code, 0);
  assert.match(output.stderr, /明天按上海日期换算/u);
});

test("扩展验收 CLI：伪确认码导致取消未成功时不能宣告验收通过", async (t) => {
  const service = await target(t, { fakeParentConfirmation: true });
  const output = await run(service.url, true);
  assert.notEqual(output.code, 0);
  assert.match(output.stderr, /取消删除未得到服务端确认/u);
});

test("隔离验收服务：系统分配端口，真实进程重启后读取同一临时数据", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "todo-isolated-service-"));
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  t.after(async () => {
    await service?.stop();
    await rm(directory, { recursive: true, force: true });
  });
  service = await startService(directory);
  assert.notEqual(new URL(service.baseUrl).port, "0");
  const created = await fetch(service.baseUrl + "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "隔离任务" }),
  }).then((response) => response.json());
  await service.stop();
  service = await startService(directory);
  const tasks = await fetch(service.baseUrl + "/api/tasks").then((response) => response.json());
  assert.deepEqual(tasks, [created]);
});

test("回归验收 CLI：忽略日期筛选的回复不能通过回归集", async (t) => {
  const service = await target(t);
  const output = await new Promise<{ code: number; stderr: string }>((resolveResult) => {
    execFile(
      process.execPath,
      ["scripts/acceptance.ts", "--regression"],
      {
        cwd: repository,
        env: { ...process.env, BASE_URL: service.url, DEEPSEEK_API_KEY: "" },
        timeout: 5_000,
      },
      (error, _stdout, stderr) => resolveResult({ code: error ? 1 : 0, stderr }),
    );
  });
  assert.notEqual(output.code, 0, "忽略筛选的目标应被新回归集拒绝");
  assert.match(output.stderr, /回归/u);
});
