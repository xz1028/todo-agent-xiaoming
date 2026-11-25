import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { reply } from "./agent.ts";
import { createJsonTaskStore, type TaskStore } from "./task-store.ts";

async function newStore(t: TestContext): Promise<TaskStore> {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return createJsonTaskStore(join(directory, "tasks.json"));
}

async function say(
  tasks: TaskStore,
  history: ChatMessage[],
  text: string,
): Promise<{ answer: string; history: ChatMessage[] }> {
  const messages: ChatMessage[] = [...history, { role: "user", content: text }];
  const answer = await reply(messages, tasks);
  const response: ChatMessage = { role: "assistant", content: answer };
  return { answer, history: [...messages, response] };
}

test("验收对话：创建、查看、完成、删除", async (t) => {
  const tasks = await newStore(t);
  let history: ChatMessage[] = [];

  let turn = await say(tasks, history, "帮我记一下买牛奶");
  assert.match(turn.answer, /已记下/);
  assert.match(turn.answer, /买牛奶/);
  history = turn.history;

  turn = await say(tasks, history, "再记一条取快递");
  assert.match(turn.answer, /取快递/);
  history = turn.history;
  assert.equal(tasks.list().length, 2);

  turn = await say(tasks, history, "我有哪些任务？");
  assert.match(turn.answer, /当前清单/);
  assert.match(turn.answer, /☐ 买牛奶/);
  assert.match(turn.answer, /☐ 取快递/);
  history = turn.history;

  turn = await say(tasks, history, "牛奶买好了");
  assert.match(turn.answer, /已完成「买牛奶」/);
  assert.equal(tasks.list().find((task) => task.title === "买牛奶")?.done, true);
  assert.equal(tasks.list().find((task) => task.title === "取快递")?.done, false);
  history = turn.history;

  turn = await say(tasks, history, "取快递这条删掉吧");
  assert.match(turn.answer, /已删除「取快递」/);
  history = turn.history;

  turn = await say(tasks, history, "再给我看看清单");
  assert.match(turn.answer, /☑ 买牛奶/);
  assert.doesNotMatch(turn.answer, /取快递/);
});

test("洗衣服这类语序变化也能标记完成", async (t) => {
  const tasks = await newStore(t);
  const first = await say(tasks, [], "帮我记一下洗衣服");
  const second = await say(tasks, first.history, "衣服洗好了");
  assert.match(second.answer, /已完成「洗衣服」/);
  assert.equal(tasks.list()[0].done, true);
});

test("扩展属性：到期、优先级、工作量与子任务", async (t) => {
  const tasks = await newStore(t);
  const created = await say(tasks, [], "帮我记一下交报告，明天到期，高优先级，工作量大");
  const report = tasks.list()[0];
  assert.equal(report.title, "交报告");
  assert.ok(report.dueDate, "应解析出到期日");
  assert.equal(report.priority, "high");
  assert.equal(report.workload, "large");
  assert.match(created.answer, /明天到期/);

  const sub = await say(tasks, created.history, "交报告的子任务：整理数据");
  assert.match(sub.answer, /整理数据/);
  const child = tasks.list().find((task) => task.title.includes("整理数据"));
  assert.ok(child, "子任务应被创建");
  assert.equal(child?.parentId, report.id);

  const due = await say(tasks, sub.history, "今天有哪些任务到期？");
  assert.match(due.answer, /到期|没有到期/);
});

test("边界情况：空清单、未找到任务、指代与重复完成", async (t) => {
  const tasks = await newStore(t);
  const empty = await say(tasks, [], "看看我的待办");
  assert.match(empty.answer, /空的/);

  const missing = await say(tasks, [], "把不存在的任务删掉吧");
  assert.match(missing.answer, /没找到/);

  const created = await say(tasks, [], "记一下取快递");
  const done = await say(tasks, created.history, "取快递做完了");
  assert.match(done.answer, /已完成/);
  const repeat = await say(tasks, done.history, "取快递完成了");
  assert.match(repeat.answer, /已经完成/);

  const pronoun = await say(tasks, repeat.history, "这条删掉吧");
  assert.match(pronoun.answer, /已删除/);
  assert.equal(tasks.list().length, 0);
});

test("任务写入 JSON 文件，重建存储后仍可查询", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-persist-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");

  const first = createJsonTaskStore(filename);
  await say(first, [], "记一下买牛奶");

  const restarted = createJsonTaskStore(filename);
  const answer = await say(restarted, [], "我有哪些任务？");
  assert.match(answer.answer, /买牛奶/);
});
