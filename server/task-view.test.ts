import assert from "node:assert/strict";
import { test } from "node:test";
import { summaryOf } from "./agent-tools.ts";
import type { Task } from "./task-store.ts";

const now = () => new Date("2026-11-25T16:30:00Z");
const item = (id: string, attrs: Partial<Task> = {}): Task => ({
  id,
  title: id,
  done: false,
  ...attrs,
});

test("清单分组计数互斥：过期但完成只计入已完成，无日期归待处理", () => {
  const text = summaryOf(
    [
      item("无日期"),
      item("今天", { dueDate: "2026-11-26" }),
      item("逾期", { dueDate: "2026-11-25" }),
      item("已完成", { dueDate: "2026-11-24", done: true }),
    ],
    now,
  );
  assert.match(text, /共 4 项，未完成 3 项/u);
  assert.match(text, /📋 待处理（2）/u);
  assert.match(text, /📋 已逾期（1）/u);
  assert.match(text, /📋 已完成（1）/u);
  assert.equal(text.match(/✅ 已完成/g)?.length, 1);
  assert.ok(text.indexOf("⬜ 今天") < text.indexOf("⬜ 逾期"));
  assert.ok(text.indexOf("⬜ 逾期") < text.indexOf("✅ 已完成"));
  assert.match(text, /已逾期.*2026-11-25/u);
});

test("空列表仍显示三组和各自的空状态", () => {
  const text = summaryOf([], now);
  for (const name of ["待处理", "已逾期", "已完成"]) {
    assert.ok(text.includes(`📋 ${name}（0）`));
    assert.ok(text.includes(`暂无${name}任务`));
  }
});

test("上海跨日后今天任务自动转到逾期组", () => {
  const task = item("跨日", { dueDate: "2026-11-25" });
  assert.match(
    summaryOf([task], () => new Date("2026-11-25T15:59:59Z")),
    /已逾期（0）/u,
  );
  assert.match(
    summaryOf([task], () => new Date("2026-11-25T16:00:00Z")),
    /已逾期（1）/u,
  );
});

test("父任务显示完整孩子进度，同组孩子缩进，跨组标注父名且不重复计数", () => {
  const tasks = [
    item("子未完成", { parentId: "父" }),
    item("父"),
    item("子完成", { parentId: "父", done: true }),
  ];
  const text = summaryOf(tasks, now);
  assert.match(text, /⬜ 父 · 1\/2 已完成\n  ⬜ 子未完成/u);
  assert.match(text, /  ✅ 子完成.*父任务：父/u);
  assert.match(text, /共 3 项，未完成 2 项/u);
});

test("筛选只显示子任务时使用完整上下文统计，不增加父行或其他孩子", () => {
  const all = [
    item("父"),
    item("可见", { parentId: "父" }),
    item("隐藏", { parentId: "父", done: true }),
  ];
  const text = summaryOf([all[1]], now, all);
  assert.match(text, /共 1 项，未完成 1 项/u);
  assert.match(text, /  ⬜ 可见.*父任务：父/u);
  assert.ok(!text.includes("隐藏"));
  const parent = summaryOf([all[0]], now, all);
  assert.match(parent, /1\/2 已完成/u);
});

test("历史循环与孤儿关系展示每条一次并安全结束", () => {
  const tasks = [
    item("A", { parentId: "B" }),
    item("B", { parentId: "A" }),
    item("孤儿", { parentId: "不存在" }),
  ];
  const text = summaryOf(tasks, now);
  assert.equal(text.match(/⬜ A/g)?.length, 1);
  assert.equal(text.match(/⬜ B/g)?.length, 1);
  assert.equal(text.match(/⬜ 孤儿/g)?.length, 1);
  assert.match(text, /父任务不在清单中/u);
});

test("保留父子结构时同组兄弟按优先级排序，创建顺序选项能恢复原顺序", () => {
  const tasks = [
    item("父"),
    item("低", { parentId: "父", priority: "low" }),
    item("高", { parentId: "父", priority: "high" }),
  ];
  const text = summaryOf(tasks, now);
  assert.ok(text.indexOf("⬜ 父") < text.indexOf("⬜ 高"));
  assert.ok(text.indexOf("⬜ 高") < text.indexOf("⬜ 低"));
  const created = summaryOf(tasks, now, tasks, "created");
  assert.ok(created.indexOf("⬜ 低") < created.indexOf("⬜ 高"));
});
