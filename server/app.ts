import { randomUUID } from "node:crypto";
import { createChatRequests, RequestConflict } from "./chat-requests.ts";
import type { ReplyOptions } from "./agent.ts";
import { resolve } from "node:path";
import express, { type ErrorRequestHandler } from "express";
import { chatRequestSchema, type ChatMessage } from "../shared/chat.ts";
import { TaskRelationError, type TaskStore } from "./task-store.ts";
import { taskRouter } from "./tasks.ts";

interface AppDependencies {
  reply(messages: ChatMessage[], options?: ReplyOptions): Promise<string>;
  requestFile?: string;
  pendingDeletion?: () => unknown;
  tasks: TaskStore;
}

export function createApp({ reply, tasks, requestFile, pendingDeletion }: AppDependencies) {
  const app = express();
  const requests = createChatRequests(requestFile);
  app.use(express.json({ limit: "1mb" }));
  app.get("/api/deletion", (_req, res) => res.json(pendingDeletion?.() ?? null));

  app.post("/api/chat", async (req, res) => {
    const input = chatRequestSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供对话记录，并以用户消息结尾。" });
    }
    const requestId = input.data.requestId ?? randomUUID();
    const result = await requests.run(requestId, input.data.messages, (signal) =>
      reply(input.data.messages, { signal, requestId }),
    );
    res.json({ reply: result.reply, ...(input.data.requestId ? { requestId } : {}) });
  });

  app.get("/api/chat/:id", (req, res) => {
    const receipt = requests.get(req.params.id);
    if (!receipt) return res.status(404).json({ error: "找不到该请求回执。" });
    return res.json({ requestId: receipt.id, state: receipt.state, reply: receipt.reply });
  });
  app.post("/api/chat/:id/cancel", (req, res) => {
    const found = requests.get(req.params.id);
    if (!found) return res.status(404).json({ error: "找不到该请求。" });
    requests.cancel(req.params.id);
    return res.status(202).json({ state: found.state });
  });
  app.use("/api/tasks", taskRouter(tasks));
  app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在。" }));
  app.use(handleApiError);

  app.use(express.static(resolve("public")));
  app.get("/assets/chat.js", (_req, res) => res.sendFile(resolve("dist/chat.js")));
  return app;
}

const handleApiError: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof RequestConflict) return res.status(409).json({ error: error.message });
  if (error instanceof TaskRelationError) {
    return res.status(400).json({ error: error.message });
  }
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({ error: "请求需要使用有效的 JSON。" });
  }
  if (error.type === "entity.too.large") {
    return res.status(413).json({ error: "对话太长，请刷新后开始新的对话。" });
  }
  console.error(error);
  res.status(500).json({ error: "服务暂时无法处理请求，请稍后重试。" });
};
