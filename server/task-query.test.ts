import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { executeTool } from "./agent-tools.ts";
import { createJsonTaskStore } from "./task-store.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "todo-query-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createJsonTaskStore(join(directory, "tasks.json"));
  const query = (args: unknown, time = "2026-11-25T16:30:00Z") =>
    JSON.parse(executeTool("list_tasks", JSON.stringify(args), store, () => new Date(time)));
  return { store, query };
}

test("日期区间包含两端，默认排除已完成和无日期，显式done可以查询完成项", async (t) => {
  const { store, query } = await fixture(t);
  store.create("开始", { dueDate: "2026-11-26" });
  store.create("结束", { dueDate: "2026-11-27" });
  store.create("区间外", { dueDate: "2026-11-28" });
  store.create("无日期");
  store.create("完成", { dueDate: "2026-11-26", done: true });
  const args = { dueFrom: "2026-11-26", dueTo: "2026-11-27" };
  assert.deepEqual(
    query(args).tasks.map((x: { title: string }) => x.title),
    ["开始", "结束"],
  );
  assert.deepEqual(
    query({ ...args, filter: "done" }).tasks.map((x: { title: string }) => x.title),
    ["完成"],
  );
  assert.equal(query({ ...args, filter: "all" }).tasks.length, 3);
});

for (const [period, time, dates, expected] of [
  ["tomorrow", "2026-11-25T16:30:00Z", ["2026-11-26", "2026-11-27", "2026-11-28"], ["2026-11-27"]],
  [
    "this_week",
    "2026-11-29T15:30:00Z",
    ["2026-11-22", "2026-11-23", "2026-11-29", "2026-11-30"],
    ["2026-11-23", "2026-11-29"],
  ],
  [
    "next_week",
    "2026-11-29T15:30:00Z",
    ["2026-11-29", "2026-11-30", "2026-12-06", "2026-12-07"],
    ["2026-11-30", "2026-12-06"],
  ],
  [
    "this_week",
    "2026-11-29T16:00:00Z",
    ["2026-11-29", "2026-11-30", "2026-12-06", "2026-12-07"],
    ["2026-11-30", "2026-12-06"],
  ],
  [
    "this_month",
    "2028-02-28T16:00:00Z",
    ["2028-02-01", "2028-02-29", "2028-03-01"],
    ["2028-02-01", "2028-02-29"],
  ],
  ["tomorrow", "2026-12-31T00:00:00Z", ["2026-12-31", "2027-01-01", "2027-01-02"], ["2027-01-01"]],
] as const) {
  test(`日历范围 ${period} @ ${time} 按上海日期正确查询`, async (t) => {
    const { store, query } = await fixture(t);
    for (const dueDate of dates) store.create(dueDate, { dueDate });
    assert.deepEqual(
      query({ period }, time).tasks.map((x: { title: string }) => x.title),
      expected,
    );
  });
}

test("非法日期、倒置范围和互相冲突的范围参数返回错误，不改变清单", async (t) => {
  const { store, query } = await fixture(t);
  const original = store.create("保留");
  for (const args of [
    { dueFrom: "2026-02-30" },
    { dueTo: 3 },
    { dueFrom: "2026-12-01", dueTo: "2026-11-30" },
    { period: "invalid" },
    { period: "today", dueFrom: "2026-11-26" },
  ]) {
    assert.equal(query(args).ok, false);
    assert.deepEqual(store.list(), [original]);
  }
});
