import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { summaryOf } from "./agent-tools.ts";
import { tasksAffectedByDeletion, type Task, type TaskStore } from "./task-store.ts";

const pendingSchema = z
  .object({
    code: z.uuid(),
    expiresAt: z.number().finite(),
    ids: z.array(z.string()).min(1),
    snapshot: z
      .array(z.looseObject({ id: z.string(), title: z.string(), done: z.boolean() }))
      .min(1),
  })
  .nullable();
type PendingDeletion = {
  code: string;
  expiresAt: number;
  ids: string[];
  snapshot: Task[];
} | null;

/** 单机本地应用的待确认删除；生产传 filename，测试不传时仅保留在实例内。 */
export function createDeletionConfirmation(tasks: TaskStore, now: () => Date, filename?: string) {
  // ponytail: 同一清单只保留一个待确认操作；多用户时按会话分别保存。
  let memory: PendingDeletion = null;

  function read(): PendingDeletion {
    if (!filename) return memory;
    if (!existsSync(filename)) return null;
    return pendingSchema.parse(JSON.parse(readFileSync(filename, "utf8")));
  }

  function save(pending: PendingDeletion) {
    if (filename) {
      mkdirSync(dirname(filename), { recursive: true });
      writeFileSync(filename + ".tmp", JSON.stringify(pending, null, 2) + "\n");
      renameSync(filename + ".tmp", filename);
    }
    memory = pending;
  }

  function affected(ids: string[]): Task[] {
    return tasksAffectedByDeletion(tasks.list(), ids);
  }

  function deleted(ids: string[]): string {
    const count = tasks.removeMany(ids);
    const all = tasks.list();
    return (
      `已删除 ${count} 项任务，可在回收站恢复。\n${summaryOf(all.slice(0, 30), now, all)}` +
      (all.length > 30 ? "\n仅展示前30项，完整清单请查看任务面板。" : "")
    );
  }

  return {
    peek() {
      const pending = read();
      if (!pending || now().getTime() >= pending.expiresAt) return null;
      if (JSON.stringify(affected(pending.ids)) !== JSON.stringify(pending.snapshot)) return null;
      return { code: pending.code, expiresAt: pending.expiresAt, tasks: pending.snapshot };
    },
    /** 工具循环完成后统一提交，避免多个单条工具调用绕过批量确认。 */
    finish(ids: string[]): string {
      const unique = [...new Set(ids)];
      const snapshot = affected(unique);
      if (!unique.every((id) => snapshot.some((task) => task.id === id))) {
        return "任务已发生变化，本轮未删除任何任务，请重新查看清单后再试。";
      }
      if (snapshot.length === 1) {
        save(null);
        return deleted(unique);
      }
      const code = randomUUID();
      save({ code, ids: unique, snapshot, expiresAt: now().getTime() + 5 * 60_000 });
      return [
        `即将删除以下 ${snapshot.length} 项任务（包含关联子任务），尚未执行：`,
        summaryOf(snapshot.slice(0, 30), now, tasks.list()),
        ...(snapshot.length > 30 ? ["仅列出前30项，确认前请在任务面板展开全部删除目标。"] : []),
        `请在 5 分钟内回复：确认删除 ${code}`,
        `如需取消，回复：取消删除 ${code}`,
        "新的删除请求会替换这次待确认操作。",
      ].join("\n");
    },

    /** 只接受最新用户消息中的完整指令，不接受模型参数或历史里的确认。 */
    respond(content: string): string | undefined {
      const text = content.trim();
      if (!/^(确认删除|取消删除)(?:\s|$)/u.test(text)) return undefined;
      const pending = read();
      if (!pending) return "没有待确认的删除操作，确认码可能已失效，请重新发起删除。";
      if (now().getTime() >= pending.expiresAt) {
        save(null);
        return "删除确认已过期，未删除任何任务，请重新发起删除。";
      }
      const command = /^(确认删除|取消删除) ([a-f0-9-]{36})$/u.exec(text);
      if (!command || command[2] !== pending.code) {
        return "确认码不匹配，未删除任何任务。请完整复制待确认提示中的指令。";
      }
      if (command[1] === "取消删除") {
        save(null);
        return "已取消删除，任务保持原样。";
      }
      if (JSON.stringify(affected(pending.ids)) !== JSON.stringify(pending.snapshot)) {
        save(null);
        return "任务已发生变化，未删除任何任务。请重新发起删除并确认最新清单。";
      }
      // 先消耗确认码再落盘任务；任何写入失败都不能让确认码再次执行。
      save(null);
      return deleted(pending.ids);
    },
  };
}
