import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createChatRequests } from "./chat-requests.ts";

test("回执：重启后成功请求不会重放，遗留运行记录明确中断", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "todo-journal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "requests.json");
  const messages = [{ role: "user" as const, content: "新增" }];
  const id = "11111111-1111-4111-8111-111111111111";
  await createChatRequests(file).run(id, messages, async () => "已新增");
  const replay = await createChatRequests(file).run(id, messages, async () => {
    throw new Error("不得执行");
  });
  assert.equal(replay.reply, "已新增");
  await writeFile(
    file,
    JSON.stringify([
      {
        id,
        hash: createHash("sha256").update(JSON.stringify(messages)).digest("hex"),
        state: "running",
      },
    ]),
  );
  const stopped = await createChatRequests(file).run(id, messages, async () => {
    throw new Error("不得执行");
  });
  assert.equal(stopped.state, "interrupted");
  assert.match(stopped.reply!, /不会自动重放/u);
});

test("回执：取消信号传递到执行端并保留终态回执", async () => {
  const journal = createChatRequests();
  const id = "11111111-1111-4111-8111-111111111111";
  const result = journal.run(id, [{ role: "user", content: "你好" }], async (signal) => {
    if (signal.aborted) return "已停止";
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return "已停止";
  });
  assert.equal(journal.cancel(id), true);
  assert.equal((await result).reply, "已停止");
  assert.equal(journal.get(id)?.state, "done");
});

test("回执：首次落盘失败不执行任务，也不留下永远运行的内存记录", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "todo-journal-fail-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const block = join(dir, "not-a-directory");
  await writeFile(block, "blocked");
  const journal = createChatRequests(join(block, "requests.json"));
  const id = "11111111-1111-4111-8111-111111111111";
  let changed = false;
  await assert.rejects(() =>
    journal.run(id, [{ role: "user", content: "新增" }], async () => {
      changed = true;
      return "已新增";
    }),
  );
  assert.equal(changed, false);
  assert.equal(journal.get(id), undefined);
});
