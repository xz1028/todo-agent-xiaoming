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
    "所有新增、修改、完成和删除操作都必须通过工具实际执行或登记。只有本轮工具返回成功才能描述相应结果，不能模仿历史回复直接说「已记下」「已创建」。工具报错时如实说明，不得声称已成功。",
    "新建普通任务或父任务都使用 add_tasks：父任务就是不带 parentId 的普通任务，并不存在单独的父任务类型。比如「帮我记一条父任务：出行」必须调用 add_tasks，titles 为 [出行]，不能只回复已创建。用户所说的「父任务」等结构词不属于标题。",
    "重要：不要凭对话历史判断任务状态。只要问题涉及已有任务（查看、完成、删除、改名），都必须先调用 list_tasks 获取最新清单，再按语义匹配任务的 id。",
    "例如「牛奶买好了」对应清单里的「买牛奶」；匹配到多条相似任务时先反问用户选哪一条，一条都没有时如实告知，绝不编造。",
    "意图模糊时先反问；删除意图明确时先 list_tasks，再调用 prepare_deletion 准备删除，ids 包含本轮所有待删除任务。这个工具不会删除数据，不需要先取得确认；普通单条删除和父子/批量删除都必须先调用它。调用成功后执行端才会直接删除普通单条任务或生成父子/批量确认提示。",
    "你不能生成、猜测或沿用历史里的删除确认码，也不要模仿服务端的确认提示。未调用 prepare_deletion 就不能声称已登记；调用成功后简短说明已准备即可，真正的确认码和提示由执行端生成。",
    "闲聊或与待办无关的问题就正常用中文回应，不要调用任何工具，也不要编造任务状态。",
    "完成任务或删除后，用简短中文说明结果；列出清单时未完成的排在前面，用 ⬜ 表示未完成、✅ 表示已完成，并给出未完成数量。",
    "扩展字段：add_tasks/update_task 可带 priority（high/medium/low）、effort（small/medium/large）、dueDate（YYYY-MM-DD）；「明天」「周五」按今天的日期换算成 YYYY-MM-DD。",
    "「今天要做什么」用 list_tasks 的 dueToday 和 overdue 参数，只返回今天到期和已逾期且未完成的任务。",
    "查询今天/明天/本周/下周/本月到期任务时，list_tasks 的 period 分别用 today/tomorrow/this_week/next_week/this_month，服务端按上海日期计算，周一到周日为一周。本月为整个日历月。其他明确范围用 dueFrom/dueTo（含两端），不能与 period 混用。范围查询默认排除已完成；明确查询完成项时设置 filter=done。",
    "筛选优先级/工作量时用 list_tasks 的 priority/effort，并与 filter、日期条件组合；按日期排序设置 sort=dueDate，按创建顺序设置 sort=created，默认优先级、截止日期、创建顺序。列表的分组和父子层级优先，兄弟任务之间采用此排序。缺省属性按中优先级/中工作量比较，不修改旧数据。",
    "展示清单时保留工具 summary 的待处理/已逾期/已完成三组、数量、父子缩进与完成进度；分组按每条任务自身状态，跨组子任务保留父名，不重复计数。",
    "创建子任务必须先 list_tasks 找到顶层父任务 id，再调用 add_tasks 并设置 parentId；绝不能仅回复已添加，最多父子两层。子任务未指定dueDate时创建时复制父日期，显式日期优先，之后改父日期不覆盖孩子。服务端自动联动完成状态：完成父任务会完成全部孩子，全部子任务完成会完成父任务，撤销子任务会使父任务未完成；撤销父任务时孩子状态不变。新增、移动、删除孩子也会重算仍有孩子的父任务。无需模型额外逐条完成孩子。删除含子任务的父任务仍由服务端要求用户确认，cascade=true不授权删除。",
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
    return completion.choices[0];
  }

  return {
    async reply(messages: ChatMessage[]): Promise<string> {
      const conversation: Array<Record<string, unknown>> = [
        { role: "system", content: systemPrompt(now) },
        ...messages.map(toClientMessage),
      ];

      const deletionIds = new Set<string>();
      const operationErrors = new Set<string>();
      let deletionError: string | undefined;
      try {
        const confirmation = deletionConfirmation.respond(messages.at(-1)?.content ?? "");
        if (confirmation !== undefined) return confirmation;

        for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
          const completion = await callModel(conversation);
          const message = completion?.message;
          if (!message) return FALLBACK;
          const expectedFinish = message.tool_calls?.length ? "tool_calls" : "stop";
          if (completion.finish_reason !== expectedFinish) {
            return "模型回复未完整结束，本轮未执行删除。请查看清单核对其他操作的结果后再试。";
          }

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
              const result = JSON.parse(output) as {
                ok: boolean;
                error?: string;
                deletionIds?: string[];
              };
              if (
                ["prepare_deletion", "delete_task", "delete_tasks"].includes(call.function.name)
              ) {
                if (!result.ok) {
                  deletionIds.clear();
                  deletionError = result.error ?? "请重新查看清单后再试。";
                  output = JSON.stringify({
                    ok: false,
                    error:
                      deletionError +
                      "本轮之前登记的删除范围已清空，尚未删除任务。请重新 list_tasks 后准备全部目标。",
                  });
                } else {
                  deletionError = undefined;
                  for (const id of result.deletionIds ?? []) deletionIds.add(id);
                }
              } else if (!result.ok) {
                operationErrors.add(result.error ?? "部分操作未成功，请核对清单。");
              }
              conversation.push({ role: "tool", tool_call_id: call.id, content: output });
            }
            continue;
          }

          if (deletionError) return "未删除任务：" + deletionError;
          if (deletionIds.size) {
            const result = deletionConfirmation.finish([...deletionIds]);
            return operationErrors.size
              ? `${result}\n本轮其他操作曾失败：${[...operationErrors].join("；")}\n如已重试，请以当前清单为准。`
              : result;
          }
          const text = (message.content ?? "").trim();
          if (/确认删除 [a-f0-9-]{36}/u.test(text)) {
            // 确认码只能由持久化记录生成；模型生成的文本不能伪装成可执行的确认。
            conversation.push({ role: "assistant", content: text });
            conversation.push({
              role: "system",
              content:
                "本轮没有工具登记删除，上条回复中的确认码无效，不能展示给用户。若用户要求删除，先 list_tasks 再调用 prepare_deletion；该工具不执行删除，不需预先确认。若有歧义请追问。不要自行生成确认码。",
            });
            continue;
          }
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
