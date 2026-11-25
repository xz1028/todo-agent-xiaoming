import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { createAgent, type ChatClient, type ChatCompletionMessage } from "./agent.ts";
import { createJsonTaskStore, type TaskStore } from "./task-store.ts";

async function newStore(t: TestContext): Promise<TaskStore> {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return createJsonTaskStore(join(directory, "tasks.json"));
}

type ScriptStep = ChatCompletionMessage | ((store: TaskStore) => ChatCompletionMessage);

/** 按预设顺序逐次返回一条模型消息；步骤可为函数以在调用时读取最新 store；用完即报错。 */
function scriptedClient(steps: ScriptStep[], store: TaskStore): ChatClient {
  let index = 0;
  return {
    chat: {
      completions: {
        async create() {
          if (index >= steps.length) throw new Error("脚本已耗尽");
          const step = steps[index++];
          const message = typeof step === "function" ? step(store) : step;
          return {
            choices: [
              {
                index: 0,
                message,
                finish_reason: message.tool_calls?.length ? "tool_calls" : "stop",
              },
            ],
          };
        },
      },
    },
  };
}

function toolCall(id: string, name: string, argsJson: string): ChatCompletionMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: argsJson } }],
  };
}

function finalText(content: string): ChatCompletionMessage {
  return { role: "assistant", content };
}

/** 累积对话历史跑一轮，返回回复与更新后的历史。 */
async function say(
  agent: { reply(messages: ChatMessage[]): Promise<string> },
  history: ChatMessage[],
  text: string,
): Promise<{ answer: string; history: ChatMessage[] }> {
  const messages: ChatMessage[] = [...history, { role: "user", content: text }];
  const answer = await agent.reply(messages);
  return { answer, history: [...messages, { role: "assistant", content: answer }] };
}

test("验收对话 6 步：创建、创建、查看、完成、删除、查看", async (t) => {
  const store = await newStore(t);
  // 第 3、4、5、6 步涉及已有任务，模型先 list_tasks 再操作；id 在调用时从最新 store 读取。
  const client = scriptedClient(
    [
      toolCall("c1", "add_tasks", JSON.stringify({ titles: ["买牛奶"] })),
      finalText("已记下「买牛奶」"),
      toolCall("c2", "add_tasks", JSON.stringify({ titles: ["取快递"] })),
      finalText("已记下「取快递」"),
      toolCall("c3", "list_tasks", "{}"),
      finalText("当前清单：\n⬜ 买牛奶\n⬜ 取快递\n未完成 2 项"),
      toolCall("c4", "list_tasks", "{}"),
      (current) =>
        toolCall(
          "c5",
          "complete_task",
          JSON.stringify({ id: current.list().find((task) => task.title === "买牛奶")?.id ?? "" }),
        ),
      finalText("已完成「买牛奶」"),
      toolCall("c6", "list_tasks", "{}"),
      (current) =>
        toolCall(
          "c7",
          "delete_task",
          JSON.stringify({ id: current.list().find((task) => task.title === "取快递")?.id ?? "" }),
        ),
      finalText("已删除「取快递」"),
      toolCall("c8", "list_tasks", "{}"),
      finalText("当前清单：\n✅ 买牛奶\n未完成 0 项"),
    ],
    store,
  );
  const agent = createAgent({ tasks: store, client });

  let history: ChatMessage[] = [];
  let turn = await say(agent, history, "帮我记一下买牛奶");
  assert.match(turn.answer, /买牛奶/);
  history = turn.history;

  turn = await say(agent, history, "再记一条取快递");
  assert.match(turn.answer, /取快递/);
  assert.equal(store.list().length, 2);
  history = turn.history;

  turn = await say(agent, history, "我有哪些任务？");
  assert.match(turn.answer, /买牛奶/);
  assert.match(turn.answer, /取快递/);
  history = turn.history;

  turn = await say(agent, history, "牛奶买好了");
  assert.equal(store.list().find((task) => task.title === "买牛奶")?.done, true);
  assert.equal(store.list().find((task) => task.title === "取快递")?.done, false);
  history = turn.history;

  turn = await say(agent, history, "取快递这条删掉吧");
  assert.equal(
    store.list().some((task) => task.title === "取快递"),
    false,
  );
  history = turn.history;

  turn = await say(agent, history, "再给我看看清单");
  assert.match(turn.answer, /买牛奶/);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].done, true);
});

test("兜底：client 抛错时 reply 返回中文提示，不抛异常", async (t) => {
  const store = await newStore(t);
  const client: ChatClient = {
    chat: {
      completions: {
        async create() {
          throw new Error("network down");
        },
      },
    },
  };
  const agent = createAgent({ tasks: store, client });
  const answer = await agent.reply([{ role: "user", content: "帮我记一下买牛奶" }]);
  assert.match(answer, /连不上大模型|稍后再试|不可用/);
  assert.equal(store.list().length, 0);
});

test("兜底：工具迭代超过上限时返回中文提示，不抛异常", async (t) => {
  const store = await newStore(t);
  const client: ChatClient = {
    chat: {
      completions: {
        async create() {
          return {
            choices: [
              {
                index: 0,
                message: toolCall("loop", "list_tasks", "{}") as ChatCompletionMessage,
                finish_reason: "tool_calls",
              },
            ],
          };
        },
      },
    },
  };
  const agent = createAgent({ tasks: store, client });
  const answer = await agent.reply([{ role: "user", content: "我有哪些任务？" }]);
  assert.match(answer, /连不上大模型|稍后再试|不可用|迭代/);
});

test("注入的 now 出现在 system prompt，供日期换算使用", async (t) => {
  const store = await newStore(t);
  let captured = "";
  const client: ChatClient = {
    chat: {
      completions: {
        async create(params) {
          captured = JSON.stringify(params?.messages);
          return {
            choices: [{ index: 0, message: finalText("你好"), finish_reason: "stop" }],
          };
        },
      },
    },
  };
  const agent = createAgent({
    tasks: store,
    client,
    now: () => new Date("2026-11-25T10:00:00Z"),
  });
  await agent.reply([{ role: "user", content: "你好" }]);
  assert.match(captured, /2026-11-25/);
  assert.match(captured, /Asia\/Shanghai/);
});
