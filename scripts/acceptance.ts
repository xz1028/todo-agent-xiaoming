/**
 * 默认启动使用临时数据目录的真实服务，逐步断言六步验收；退出时清理进程和数据。
 * BASE_URL 可指定已有服务，但仅接受空清单，绝不清空目标数据。
 * --extended 额外检查相对日期、到期并集、歧义、批量和父子任务确认。
 */
import assert from "node:assert/strict";
import { regression } from "./regression.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatMessage } from "../shared/chat.ts";
import type { Task } from "../server/task-store.ts";

/** 使用生产入口与独立 cwd；端口由操作系统分配。 */
export async function startService(directory: string) {
  const child = spawn(process.execPath, [resolve(import.meta.dirname, "../server/index.ts")], {
    cwd: directory,
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await once(child, "close");
  }
  try {
    const baseUrl = await new Promise<string>((resolveReady, reject) => {
      let output = "";
      const timer = setTimeout(() => finish(new Error("验收服务启动超时。")), 10_000);
      function finish(error?: Error, url?: string) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.off("error", onError);
        child.off("exit", onExit);
        if (error) reject(error);
        else resolveReady(url!);
      }
      function onData(chunk: Buffer) {
        output += chunk.toString();
        const url = output.match(/http:\/\/127\.0\.0\.1:[1-9]\d*/u)?.[0];
        if (url) finish(undefined, url);
      }
      function onError(error: Error) {
        finish(error);
      }
      function onExit(code: number | null) {
        finish(new Error("验收服务提前退出：" + code));
      }
      child.stdout.on("data", onData);
      child.once("error", onError);
      child.once("exit", onExit);
    });
    child.stdout.resume();
    return { baseUrl, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

function state(tasks: Task[]) {
  return tasks
    .map(({ title, done }) => ({ title, done }))
    .sort((a, b) => a.title.localeCompare(b.title, "zh"));
}

function tester(baseUrl: string) {
  let messages: ChatMessage[] = [];
  async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(path === "/api/chat" ? 130_000 : 10_000),
    });
    if (!response.ok)
      throw new Error(path + " 返回 " + response.status + ": " + (await response.text()));
    return response.json() as Promise<T>;
  }
  const list = () => request<Task[]>("/api/tasks");
  async function say(content: string) {
    const outgoing: ChatMessage[] = [...messages, { role: "user", content }];
    const { reply } = await request<{ reply: string }>("/api/chat", "POST", { messages: outgoing });
    assert.ok(typeof reply === "string" && reply.trim(), "聊天回复不能为空");
    assert.doesNotMatch(reply, /暂时连不上大模型|我处理得有点慢/u, "模型调用未完成");
    messages = [...outgoing, { role: "assistant", content: reply }];
    console.log("用户：" + content + "\n小明：" + reply + "\n");
    return reply;
  }
  return { request, list, say };
}

async function basic(check: ReturnType<typeof tester>) {
  const steps = [
    { text: "帮我记一下买牛奶", expected: [{ title: "买牛奶", done: false }] },
    {
      text: "再记一条取快递",
      expected: [
        { title: "买牛奶", done: false },
        { title: "取快递", done: false },
      ],
    },
    {
      text: "我有哪些任务？",
      expected: [
        { title: "买牛奶", done: false },
        { title: "取快递", done: false },
      ],
    },
    {
      text: "牛奶买好了",
      expected: [
        { title: "买牛奶", done: true },
        { title: "取快递", done: false },
      ],
    },
    { text: "取快递这条删掉吧", expected: [{ title: "买牛奶", done: true }] },
    { text: "再给我看看清单", expected: [{ title: "买牛奶", done: true }] },
  ];
  for (const [index, step] of steps.entries()) {
    const answer = await check.say(step.text);
    assert.deepEqual(
      state(await check.list()),
      [...step.expected].sort((a, b) => a.title.localeCompare(b.title, "zh")),
      "第 " + (index + 1) + " 步状态不符合预期",
    );
    if (index === 2) {
      assert.ok(answer.includes("买牛奶") && answer.includes("取快递"), "第 3 步应展示两条任务");
      assert.match(answer, /⬜|☐|未完成|待办/u, "第 3 步应显示未完成状态");
    }
    if (index === 5) {
      assert.ok(answer.includes("买牛奶") && !answer.includes("取快递"), "第 6 步应只展示剩余任务");
      assert.match(answer, /✅|☑|已完成/u, "第 6 步应显示完成状态");
    }
    console.log("PASS 第 " + (index + 1) + " 步：真实任务状态符合预期。\n");
  }
}

function codeOf(answer: string) {
  const code = answer.match(/确认删除 ([a-f0-9-]{36})/u)?.[1];
  assert.ok(code, "应生成服务端待确认记录和确认码");
  return code;
}

async function extended(check: ReturnType<typeof tester>) {
  const date = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toLocaleDateString("en-CA", {
      timeZone: "Asia/Shanghai",
    });
  await check.say("帮我记一下交验收报告，明天到期，高优先级，工作量大");
  const report = (await check.list()).find((task) => task.title === "交验收报告");
  assert.ok(report, "应创建交验收报告");
  assert.equal(report.dueDate, date(1), "明天按上海日期换算");
  assert.equal(report.priority, "high");
  assert.equal(report.workload, "large");
  console.log("PASS 相对日期、优先级与工作量。\n");

  const today = await check.request<Task>("/api/tasks", "POST", {
    title: "今天到期验收",
    dueDate: date(0),
  });
  const overdue = await check.request<Task>("/api/tasks", "POST", {
    title: "逾期待办验收",
    dueDate: date(-1),
  });
  const answer = await check.say("今天有哪些任务到期？请同时列出已逾期未完成任务");
  assert.ok(
    answer.includes(today.title) && answer.includes(overdue.title),
    "应同时展示今天到期与逾期任务",
  );
  assert.ok(!answer.includes(report.title), "不应展示明天到期的任务");
  console.log("PASS 今天到期与逾期并集查询。\n");

  const beforeBatch = await check.list();
  const batch = codeOf(await check.say("删除「今天到期验收」和「逾期待办验收」"));
  assert.deepEqual(await check.list(), beforeBatch, "批量确认前不能删除");
  await check.say("确认删除 " + batch);
  assert.deepEqual(
    await check.list(),
    beforeBatch.filter((task) => task.id !== today.id && task.id !== overdue.id),
  );
  console.log("PASS 批量删除确认与固定删除范围。\n");

  await check.say("帮我记一条父任务：验收出行");
  const parent = (await check.list()).find((task) => task.title === "验收出行");
  assert.ok(
    parent,
    "父任务「验收出行」未实际创建；当前任务：" + JSON.stringify(state(await check.list())),
  );
  await check.say("给「验收出行」添加子任务「验收买票」");
  const child = (await check.list()).find((task) => task.title === "验收买票");
  assert.ok(child, "子任务标题未精确保留，当前任务：" + JSON.stringify(await check.list()));
  assert.equal(child.parentId, parent.id);
  const beforeParent = await check.list();
  const parentCode = codeOf(await check.say("删除「验收出行」"));
  assert.deepEqual(await check.list(), beforeParent, "父子删除确认前不能落盘");
  const canceled = await check.say("取消删除 " + parentCode);
  assert.match(canceled, /已取消删除/u, "取消删除未得到服务端确认");
  assert.deepEqual(await check.list(), beforeParent, "取消后任务不变");
  const retryCode = codeOf(await check.say("现在删除「验收出行」"));
  assert.notEqual(retryCode, parentCode);
  await check.say("确认删除 " + retryCode);
  assert.deepEqual(
    await check.list(),
    beforeParent.filter((task) => task.id !== parent.id && task.id !== child.id),
  );
  console.log("PASS 子任务关联、取消与父子删除确认。\n");

  await check.request("/api/tasks", "POST", { title: "联系张老师" });
  await check.request("/api/tasks", "POST", { title: "联系张同学" });
  const beforeAmbiguous = await check.list();
  const question = await check.say("把联系张这条标为完成");
  assert.deepEqual(await check.list(), beforeAmbiguous, "歧义任务不能擅自修改");
  assert.match(question, /哪|选择|明确|确认|具体|？|\?/u, "应追问具体是哪条任务");
  console.log("PASS 相似任务消歧。\n");
}

async function main() {
  const externalUrl = process.env.BASE_URL?.trim() || undefined;
  if (!externalUrl && !process.env.DEEPSEEK_API_KEY?.trim()) {
    throw new Error("请先在本地 .env 中填写 DEEPSEEK_API_KEY；默认验收会启动隔离服务。");
  }
  const directory = externalUrl ? undefined : await mkdtemp(join(tmpdir(), "todo-acceptance-"));
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  try {
    if (directory) service = await startService(directory);
    let check = tester(externalUrl ?? service!.baseUrl);
    assert.deepEqual(
      await check.list(),
      [],
      "验收需要空清单；目标已有任务，未清空或修改现有数据。",
    );
    console.log(
      directory
        ? "使用临时数据目录进行隔离验收。\n"
        : "使用外部空清单进行验收；不会自动清空数据。\n",
    );
    await basic(check);
    if (directory && service) {
      const beforeRestart = await check.list();
      await service.stop();
      service = await startService(directory);
      check = tester(service.baseUrl);
      assert.deepEqual(await check.list(), beforeRestart, "实际服务重启后任务应保留");
      const answer = await check.say("再给我看看清单");
      assert.ok(answer.includes("买牛奶") && !answer.includes("取快递"));
      assert.match(answer, /✅|☑|已完成/u);
      console.log("PASS 实际服务重启后的查询与任务持久化。\n");
    }
    if (process.argv.includes("--extended")) await extended(check);
    if (process.argv.includes("--regression")) await regression(check);
    console.log(
      "PASS 验收完成。" + (externalUrl ? "外部服务的重启需另行验证。" : "临时进程与数据将清理。"),
    );
  } finally {
    await service?.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error("FAIL 验收失败：", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
