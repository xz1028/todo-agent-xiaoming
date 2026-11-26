import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { ChatMessage } from "../shared/chat.ts";

const receiptSchema = z.object({
  id: z.uuid(),
  hash: z.string(),
  state: z.enum(["running", "done", "interrupted"]),
  reply: z.string().optional(),
});
type Receipt = z.infer<typeof receiptSchema>;
export class RequestConflict extends Error {}
const interrupted =
  "上次请求因服务中断，部分操作可能已经保存。请先核对任务清单，再明确提出后续操作；本请求不会自动重放。";

/** 单进程JSON应用：运行中的相同ID共享Promise；磁盘running在重启后只读回执，不重放。 */
export function createChatRequests(filename?: string) {
  let receipts: Receipt[] =
    filename && existsSync(filename)
      ? z.array(receiptSchema).parse(JSON.parse(readFileSync(filename, "utf8")))
      : [];
  receipts = receipts.map((item) =>
    item.state === "running" ? { ...item, state: "interrupted", reply: interrupted } : item,
  );
  const active = new Map<string, { controller: AbortController; promise: Promise<Receipt> }>();
  function save() {
    // 完成回执保留最近500条；运行中记录不淘汰。过期ID不可用于长期全局去重。
    receipts = [
      ...receipts.filter((item) => item.state === "running"),
      ...receipts.filter((item) => item.state !== "running").slice(-500),
    ];
    if (!filename) return;
    mkdirSync(dirname(filename), { recursive: true });
    writeFileSync(filename + ".tmp", JSON.stringify(receipts, null, 2) + "\n", { mode: 0o600 });
    renameSync(filename + ".tmp", filename);
  }
  return {
    get(id: string) {
      return receipts.find((item) => item.id === id);
    },
    cancel(id: string) {
      const item = active.get(id);
      item?.controller.abort();
      return !!item;
    },
    async run(
      id: string,
      messages: ChatMessage[],
      perform: (signal: AbortSignal) => Promise<string>,
    ): Promise<Receipt> {
      const hash = createHash("sha256").update(JSON.stringify(messages)).digest("hex");
      const existing = receipts.find((item) => item.id === id);
      if (existing) {
        if (existing.hash !== hash) throw new RequestConflict("同一请求编号不能用于不同消息。");
        return active.get(id)?.promise ?? existing;
      }
      if (active.size) throw new RequestConflict("上一条消息仍在处理中，请等待完成后再发送。");
      const receipt: Receipt = { id, hash, state: "running" };
      receipts.push(receipt);
      try {
        save();
      } // 写入成功才开始产生副作用。
      catch (error) {
        receipts = receipts.filter((item) => item !== receipt);
        throw error;
      }
      const controller = new AbortController();
      // 延后执行一微任务，先登记active，防止同步异常留下不可取消的请求。
      const promise = Promise.resolve().then(async () => {
        try {
          receipt.reply = await perform(controller.signal);
          receipt.state = "done";
        } catch {
          receipt.reply = interrupted;
          receipt.state = "interrupted";
        } finally {
          try {
            save();
          } finally {
            active.delete(id);
          }
        }
        return receipt;
      });
      active.set(id, { controller, promise });
      return promise;
    },
  };
}
