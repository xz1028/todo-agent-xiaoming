import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createJsonTaskStore } from "./task-store.ts";

test("回收站：父子删除和回收记录同次持久化，重启后完整恢复", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "todo-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "tasks.json");
  const store = createJsonTaskStore(file);
  const parent = store.create("出行");
  store.create("买票", { parentId: parent.id });
  const before = store.list();
  store.remove(parent.id);
  assert.deepEqual(store.list(), []);
  const restarted = createJsonTaskStore(file);
  assert.equal(restarted.trash().length, 1);
  restarted.restore(restarted.trash()[0].id);
  assert.deepEqual(restarted.list(), before);
  assert.deepEqual(restarted.trash(), []);
  assert.ok((await readFile(file + ".bak", "utf8")).includes("出行"));
});

test("导入：先预览合并，不覆盖当前数据，预览过期后拒绝写入", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "todo-import-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createJsonTaskStore(join(dir, "tasks.json"));
  const existing = store.create("原有");
  const added = { id: "imported", title: "导入项", done: false };
  const preview = store.previewImport([existing, added]);
  assert.equal(preview.added, 1);
  assert.equal(preview.skipped, 1);
  assert.equal(store.list().length, 1);
  store.create("预览后新增");
  assert.throws(() => store.importTasks([existing, added], preview.token), /变化|过期/u);
  const current = store.previewImport([existing, added]);
  store.importTasks([existing, added], current.token);
  assert.equal(store.list().length, 3);
  assert.throws(() => store.previewImport([{ ...existing, title: "覆盖" }]), /冲突/u);
  assert.throws(
    () => store.previewImport([{ ...added, id: "orphan", parentId: "missing" }]),
    /父任务/u,
  );
});

test("导入兼容effort别名，冲突输入不写入", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "todo-import-alias-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createJsonTaskStore(join(dir, "tasks.json"));
  const input = [{ id: "alias", title: "别名", done: false, effort: "small" }];
  const preview = store.previewImport(input);
  store.importTasks(input, preview.token);
  assert.equal(store.list()[0].workload, "small");
  assert.equal("effort" in store.list()[0], false);
  assert.throws(
    () =>
      store.previewImport([
        { id: "bad", title: "冲突", done: false, effort: "small", workload: "large" },
      ]),
    /格式|冲突/u,
  );
});

test("恢复冲突：父任务缺失或ID占用时拒绝，活动任务和回收记录均不变", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "todo-restore-conflict-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createJsonTaskStore(join(dir, "tasks.json"));
  const parent = store.create("父");
  const child = store.create("子", { parentId: parent.id });
  store.remove(child.id);
  const batch = store.trash()[0];
  store.remove(parent.id);
  const before = JSON.stringify({ tasks: store.list(), trash: store.trash() });
  assert.throws(() => store.restore(batch.id), /父任务/u);
  assert.equal(JSON.stringify({ tasks: store.list(), trash: store.trash() }), before);
  store.restore(store.trash()[1].id);
  const input = [{ ...child, title: "同ID导入项" }];
  const preview = store.previewImport(input);
  store.importTasks(input, preview.token);
  const collision = JSON.stringify({ tasks: store.list(), trash: store.trash() });
  assert.throws(() => store.restore(batch.id), /冲突/u);
  assert.equal(JSON.stringify({ tasks: store.list(), trash: store.trash() }), collision);
});
