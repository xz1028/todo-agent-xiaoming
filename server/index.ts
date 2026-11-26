import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createAgent } from "./agent.ts";
import { createApp } from "./app.ts";
import { createJsonTaskStore } from "./task-store.ts";

const tasks = createJsonTaskStore(join("data", "tasks.json"));
const agent = createAgent({
  tasks,
  confirmationFile: join("data", "pending-deletion.json"),
  onTrace: (event) => console.info("agent.trace", JSON.stringify(event)),
});
const app = createApp({
  reply: agent.reply,
  tasks,
  pendingDeletion: agent.pendingDeletion,
  requestFile: join("data", "chat-requests.json"),
});
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, "127.0.0.1", () => {
  const { port: actualPort } = server.address() as AddressInfo;
  console.log(`小明智能体已启动：http://127.0.0.1:${actualPort}`);
});
