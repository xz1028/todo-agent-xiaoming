import type { ChatMessage } from "../shared/chat.ts";
import { AGENT_TOOLS, executeTool } from "./agent-tools.ts";
import { createDeletionConfirmation } from "./deletion-confirmation.ts";
import { model as defaultModel, getModelClient } from "./model.ts";
import type { TaskStore } from "./task-store.ts";

export type { ChatMessage } from "../shared/chat.ts";

/** 工具调用的最小结构，足以驱动循环，也方便测试注入假实现。 */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatCompletionMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}

/** 只依赖 completions.create，测试可注入脚本化假实现，生产用 OpenAI 客户端。 */
export interface ChatClient {
  chat: {
    completions: {
      create(
        params?: Record<string, unknown>,
        options?: { signal?: AbortSignal; maxRetries?: number },
      ): Promise<{
        choices: Array<{
          index: number;
          message: ChatCompletionMessage;
          finish_reason?: string | null;
        }>;
      }>;
    };
  };
}

export interface AgentDeps {
  tasks: TaskStore;
  client?: ChatClient;
  model?: string;
  now?: () => Date;
  confirmationFile?: string;
}

export interface Agent {
  reply(messages: ChatMessage[]): Promise<string>;
}

const MAX_TOOL_ITERATIONS = 6;
const FALLBACK = "小明暂时连不上大模型，请检查 DEEPSEEK_API_KEY 后重启服务，或稍后再试。";

function systemPrompt(now: () => Date): string {
  const date = now().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  return [
    "你是「小明」，一个简洁友好的中文待办助手，通过工具管理用户的任务清单。",
    `今天的日期是 ${date}（时区 Asia/Shanghai）。涉及「明天」「周五」等相对时间时据此换算为 YYYY-MM-DD。`,
    "重要：不要凭对话历史判断任务状态。只要问题涉及已有任务（查看、完成、删除、改名），都必须先调用 list_tasks 获取最新清单，再按语义匹配任务的 id。",
    "例如「牛奶买好了」对应清单里的「买牛奶」；匹配到多条相似任务时先反问用户选哪一条，一条都没有时如实告知，绝不编造。",
    "意图模糊时先反问；删除意图明确时先 list_tasks，再用 delete_task 或 delete_tasks 登记。批量删除必须一次传入所有 ids。工具仅登记，服务端在本轮结束时统一执行普通单条删除，或发出带确认码的批量/父子任务确认；不要自行索要确认，不要声称登记等于删除成功。",
    "闲聊或与待办无关的问题就正常用中文回应，不要调用任何工具，也不要编造任务状态。",
    "完成任务或删除后，用简短中文说明结果；列出清单时未完成的排在前面，用 ⬜ 表示未完成、✅ 表示已完成，并给出未完成数量。",
    "扩展字段：add_tasks/update_task 可带 priority（high/medium/low）、effort（small/medium/large）、dueDate（YYYY-MM-DD）；「明天」「周五」按今天的日期换算成 YYYY-MM-DD。",
    "「今天要做什么」用 list_tasks 的 dueToday 和 overdue 参数，只返回今天到期和已逾期且未完成的任务。",
    "子任务用 add_tasks 的 parentId 关联父任务；删除含子任务的父任务由服务端要求用户确认，cascade=true 不授权删除。若所有子任务都完成，可提示用户把父任务也标记完成。",
  ].join("\n");
}

function toClientMessage(message: ChatMessage): Record<string, unknown> {
  return { role: message.role, content: message.content };
}

export function createAgent(deps: AgentDeps): Agent {
  const { tasks, model = defaultModel, now = () => new Date() } = deps;

  const deletionConfirmation = createDeletionConfirmation(tasks, now, deps.confirmationFile);

  // client 懒加载：没有 key 时服务也能启动，只有真正 reply 才创建客户端。
  let client: ChatClient | undefined = deps.client;
  function getClient(): ChatClient {
    if (!client) client = getModelClient() as unknown as ChatClient;
    return client;
  }

  async function callModel(conversation: Array<Record<string, unknown>>) {
    const completion = await getClient().chat.completions.create(
      {
        model,
        messages: conversation,
        tools: AGENT_TOOLS,
        tool_choice: "auto",
        thinking: { type: "disabled" },
      },
      { signal: AbortSignal.timeout(20_000), maxRetries: 0 },
    );
    return completion.choices[0]?.message;
  }

  return {
    async reply(messages: ChatMessage[]): Promise<string> {
      const conversation: Array<Record<string, unknown>> = [
        { role: "system", content: systemPrompt(now) },
        ...messages.map(toClientMessage),
      ];

      const deletionIds = new Set<string>();
      try {
        const confirmation = deletionConfirmation.respond(messages.at(-1)?.content ?? "");
        if (confirmation !== undefined) return confirmation;

        for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
          const message = await callModel(conversation);
          if (!message) return FALLBACK;

          if (message.tool_calls?.length) {
            conversation.push({
              role: "assistant",
              content: message.content ?? "",
              tool_calls: message.tool_calls,
            });
            for (const call of message.tool_calls) {
              let output: string;
              try {
                output = executeTool(call.function.name, call.function.arguments, tasks, now);
              } catch (toolError) {
                console.error("工具执行异常：", toolError);
                output = JSON.stringify({ ok: false, error: "工具执行失败，请重试。" });
              }
              if (["delete_task", "delete_tasks"].includes(call.function.name)) {
                const result = JSON.parse(output) as {
                  ok: boolean;
                  error?: string;
                  deletionIds?: string[];
                };
                if (!result.ok) return "未删除任务：" + (result.error ?? "请重新查看清单后再试。");
                for (const id of result.deletionIds ?? []) deletionIds.add(id);
              }
              conversation.push({ role: "tool", tool_call_id: call.id, content: output });
            }
            continue;
          }

          if (deletionIds.size) return deletionConfirmation.finish([...deletionIds]);
          const text = (message.content ?? "").trim();
          return text || FALLBACK;
        }
        return "我处理得有点慢，请稍后再试或换一种说法。";
      } catch (error) {
        // 无 key、网络错误、超时、模型返回异常都在这里兜底，避免 /api/chat 返回 500。
        console.error("小明调用模型失败：", error);
        return FALLBACK;
      }
    },
  };
}
