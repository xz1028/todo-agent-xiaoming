import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSession, saveSession } from "../src/session.ts";

test("会话：刷新保留消息和未完成请求，坏数据与存储禁用可降级", () => {
  let value: string | null = null;
  const storage = {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
  const state = {
    version: 1 as const,
    messages: [{ role: "user" as const, content: "记任务" }],
    request: {
      requestId: "11111111-1111-4111-8111-111111111111",
      messages: [{ role: "user" as const, content: "记任务" }],
    },
  };
  assert.equal(saveSession(state, storage), true);
  assert.deepEqual(loadSession(storage), state);
  value = "broken";
  assert.deepEqual(loadSession(storage).messages, []);
  assert.equal(
    saveSession(state, {
      setItem() {
        throw new Error("disabled");
      },
    }),
    false,
  );
});
