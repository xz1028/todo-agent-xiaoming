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
