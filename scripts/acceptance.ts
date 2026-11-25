/**
 * 真机验收：对运行中的服务累积 messages 跑完验收 6 步，打印每轮回复，
 * 并在每一步后读取 /api/tasks 核对真实状态。
 *
 * 用法：
 *   1) 在 .env 中填好 DEEPSEEK_API_KEY
 *   2) npm run dev 启动服务（默认 http://127.0.0.1:3000）
 *   3) node --env-file-if-exists=.env scripts/acceptance.ts
 *
 * 脚本会先清空现有任务（逐个 DELETE），保证从干净状态开始。
 */
import type { ChatMessage } from "../shared/chat.ts";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:3000";

interface Task {
  id: string;
  title: string;
  done: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok && response.status !== 204) {
    throw new Error(`${path} 返回 ${response.status}: ${await response.text()}`);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

async function clearTasks() {
  const tasks = await request<Task[]>("/api/tasks");
  for (const task of tasks) {
    await request<void>(`/api/tasks/${task.id}`, { method: "DELETE" });
  }
  console.log(`已清空现有任务（${tasks.length} 条）。\n`);
}

async function main() {
  await clearTasks();

  const steps = [
    "帮我记一下买牛奶",
    "再记一条取快递",
    "我有哪些任务？",
    "牛奶买好了",
    "取快递这条删掉吧",
    "再给我看看清单",
  ];
  let messages: ChatMessage[] = [];

  for (const [index, text] of steps.entries()) {
    messages = [...messages, { role: "user", content: text }];
    const { reply } = await request<{ reply: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages }),
    });
    messages = [...messages, { role: "assistant", content: reply }];
    const tasks = await request<Task[]>("/api/tasks");
    console.log(`=== 第 ${index + 1} 步：${text} ===`);
    console.log(`回复：${reply}`);
    console.log(
      `状态：${tasks.map((task) => `${task.done ? "✅" : "⬜"} ${task.title}`).join("、") || "（空）"}\n`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
