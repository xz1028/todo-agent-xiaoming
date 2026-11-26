import assert from "node:assert/strict";
import type { Task } from "../server/task-store.ts";
import { queryTasks } from "../server/task-query.ts";

interface Check {
  request<T>(path: string, method?: string, body?: unknown): Promise<T>;
  list(): Promise<Task[]>;
  say(content: string): Promise<string>;
}

/** 固定语料只断言状态和目标集合，不要求模型逐字回复。 */
export async function regression(check: Check) {
  const now = () => new Date();
  const today = now().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  const date = new Date(today + "T00:00:00Z");
  const shift = (offset: number) =>
    new Date(+date + offset * 86_400_000).toISOString().slice(0, 10);
  const create = (body: unknown) => check.request<Task>("/api/tasks", "POST", body);
  const fixtures = await Promise.all([
    create({ title: "回归甲高优大任务", dueDate: shift(1), priority: "high", effort: "large" }),
    create({ title: "回归乙低优小任务", dueDate: shift(1), priority: "low", effort: "small" }),
    create({ title: "回归丙已逾期", dueDate: shift(-1), priority: "high" }),
    create({ title: "回归丁下周任务", dueDate: shift(7) }),
    create({ title: "回归戊远期任务", dueDate: shift(50) }),
  ]);
  for (const [period, text] of [
    ["tomorrow", "只列出明天到期的未完成任务"],
    ["this_week", "只列出本周到期的未完成任务"],
    ["next_week", "只列出下周到期的未完成任务"],
    ["this_month", "只列出本月到期的未完成任务"],
  ] as const) {
    const before = await check.list();
    const answer = await check.say(text);
    const expected = new Set(queryTasks(fixtures, { period }, now).map((task) => task.id));
    for (const task of fixtures) {
      assert.equal(
        answer.includes(task.title),
        expected.has(task.id),
        `回归 ${period}：${task.title}`,
      );
    }
    assert.deepEqual(await check.list(), before, "回归：查询不能修改任务");
    console.log("PASS 回归日历查询：" + period);
  }
  const filtered = await check.say("只列出明天到期、高优先级、工作量大的未完成任务");
  assert.ok(filtered.includes(fixtures[0].title), "回归组合筛选：漏掉匹配项");
  for (const task of fixtures.slice(1))
    assert.ok(!filtered.includes(task.title), "回归组合筛选：混入其他任务");

  const parent = await create({ title: "回归出行计划", dueDate: shift(1) });
  await check.say(
    "给「回归出行计划」新增两个子任务：「回归订票」和「回归装行李」，到期日跟随父任务",
  );
  const children = (await check.list()).filter((task) => task.parentId === parent.id);
  assert.equal(children.length, 2, "回归：应实际创建两个子任务");
  assert.ok(
    children.every((task) => task.dueDate === parent.dueDate),
    "回归：应继承日期",
  );
  await check.say("回归出行计划全部完成了");
  assert.ok(
    (await check.list())
      .filter((task) => task.id === parent.id || task.parentId === parent.id)
      .every((task) => task.done),
    "回归：完成父任务应完成孩子",
  );
  await check.say("刚才的「回归订票」还没完成，撤销它的完成状态");
  const afterUndo = await check.list();
  assert.equal(
    afterUndo.find((task) => task.id === parent.id)?.done,
    false,
    "回归：撤销孩子应撤销父完成",
  );
  assert.equal(afterUndo.find((task) => task.title === "回归订票")?.done, false);
  assert.equal(afterUndo.find((task) => task.title === "回归装行李")?.done, true);
  console.log("PASS 回归组合筛选、子任务继承和完成联动。");
}
