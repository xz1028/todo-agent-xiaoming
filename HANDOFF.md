# HANDOFF · 小明智能体待办清单

> 交接文档，供接手者（Codex）继续优化本项目。最后更新：2026-11-25。

## 1. 项目是什么

一个用中文对话管理待办任务的智能体。核心是 OpenAI function calling 工具循环：模型决定调用哪个工具，服务端执行工具并把结构化结果回填，直到模型给出纯文本回复。任务持久化在本地 JSON 文件。

仓库：`https://github.com/xz1028/todo-agent`（公开），本地路径即本目录。

## 2. 环境与运行（重要）

- **Node.js 必须 >= 24.12**。本机默认是 22.22.2，不达标。每次开终端先 `nvm use 24`（本机为 v24.16.0），否则 npm 脚本可能异常。所有验证命令都在 Node 24 下跑过。
- 依赖：`npm ci`。没有 Python，全栈 TypeScript。
- 启动：`npm run dev` → <http://127.0.0.1:3000>。改前端 `src/*.tsx` 后需 `npm run build` 并刷新页面。
- `.env` 由 `.env.example` 复制而来，**`DEEPSEEK_API_KEY` 当前为空**，所以真机调用未验证。测试不需要 key。
- 红线：**不要编辑 `SUBMIT.md`**（仓库 `AGENTS.md` 明确禁止，且是候选人本人提交材料）；**不要编造或提交 key**；`.env`、`data/` 已被 `.gitignore` 覆盖，勿强行加入版本控制。

## 3. Git 状态

- 分支 `main`，工作树干净，`main...origin/main` 无 ahead/behind，全部改动已 push。
- 本次新增提交（均在 origin/main 上）：
  - `2445da6` 用 function calling 重构 agent
  - `7f48a76` 扩展：清单展示 / 优先级工作量 / 到期过滤 / 子任务 + 验收脚本
  - `fa0eeb9` 新增 DEVELOPMENT.md、NOTES_FOR_SUBMIT.md，前端状态符号
  - `b26edcd`、`2851b18` README 迭代（现为面向项目的正式文档）

## 4. 架构与关键文件

| 文件                                     | 职责                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/agent.ts`                        | `createAgent(deps)`：`{ tasks, client?, model?, now? }` 依赖注入；system prompt 注入日期/时区；工具循环上限 6 次；无 key/网络错误/超时/异常统一返回中文兜底并 `console.error`；client 懒加载。导出 `ChatClient`/`ChatCompletionMessage`/`ToolCall` 最小接口便于测试注入。 |
| `server/agent-tools.ts`                  | `AGENT_TOOLS`（5 个 OpenAI function schema）+ `executeTool(name, argsJson, store, now)`。所有参数错误以结构化 JSON `{ok:false,error}` 返回，不抛异常；`summaryOf(tasks, now)` 生成预格式化清单（未完成置顶、统计、⬜/✅、属性标签）。                                     |
| `server/index.ts`                        | `createAgent({tasks})` → `createApp({reply: agent.reply, tasks})`。                                                                                                                                                                                                       |
| `server/app.ts`                          | Express 5：`POST /api/chat`（zod 校验，消息须以 user 结尾）、`/api/tasks` 挂载 taskRouter、统一错误处理。                                                                                                                                                                 |
| `server/task-store.ts`                   | `TaskStore` 同步接口；JSON 读写用临时文件 + rename 原子替换；`z.looseObject` 保留旧数据额外字段；`remove` 级联删除子任务。                                                                                                                                                |
| `server/tasks.ts`                        | 任务 HTTP API 的 zod 校验；把 `effort` 别名归一化为 `workload`。                                                                                                                                                                                                          |
| `server/model.ts`                        | `getModelClient()`（baseURL `https://api.deepseek.com`），`model = DEEPSEEK_MODEL                                                                                                                                                                                         |     | "deepseek-flash"`。 |
| `shared/chat.ts`                         | `ChatMessage` 类型 + `chatRequestSchema`。                                                                                                                                                                                                                                |
| `src/ChatHistory.tsx`                    | 聊天 UI；`MessageBody` 按行识别 `📋`/`⬜`/`✅`/`☐`/`☑` 做状态样式，CSS 已 `white-space: pre-wrap`。                                                                                                                                                                       |
| `scripts/acceptance.ts`                  | 真机验收：清空任务 → 累积 messages 跑 6 步 → 每轮打印回复与 `/api/tasks` 状态。                                                                                                                                                                                           |
| `server/*.test.ts`                       | 21 个测试：`agent.test.ts`（假模型脚本化验收 + 兜底 + 日期注入）、`agent-tools.test.ts`（工具层边界 + 扩展）、`app.test.ts`（HTTP API）。                                                                                                                                 |
| `DEVELOPMENT.md` / `NOTES_FOR_SUBMIT.md` | 运行验证说明 / 提交素材（四节：功能列表、工程决策、边界情况、优化空间）。                                                                                                                                                                                                 |

### 数据流

`POST /api/chat` → `reply(messages)` → 组装 `[system prompt, ...历史]` → 调模型 → 若有 `tool_calls` 则逐个 `executeTool` 并以 `role:"tool", tool_call_id` 回填 → 再调模型 → 纯文本返回。涉及已有任务时 system prompt 强制先 `list_tasks` 再按语义匹配 id，不依赖对话历史判断状态。

## 5. 关键设计决策（改动前务必了解）

- **effort vs workload**：任务书字段名是 `effort`，原仓库用 `workload`。当前方案：存储统一 `workload`，`effort` 作为输入别名在工具层和 HTTP 层归一化（见 `server/tasks.ts` 的 `toChanges`、`agent-tools.ts` 的 `attributes`）。改动时别破坏这个兼容。
- **时区**：相对日期（明天/周五）由模型按 system prompt 注入的当前日期换算为 `YYYY-MM-DD`；所有日期计算用 `Asia/Shanghai`；`now` 可注入以便测试。
- **到期过滤**：`dueToday`/`overdue` 只看未完成任务，两者并用为并集。
- **子任务**：仅一层 `parentId`；删除父任务需 `cascade=true` 确认；工具层会检查子任务数并拒绝未确认的删除。
- **无确认状态机**：是否确认完全依赖模型遵循 system prompt，这是当前最大软肋（见优化项）。

## 6. 验证命令

```sh
nvm use 24
npm test && npm run typecheck && npm run lint && npm run fmt:check && npm run build
```

基线：`tests 21 / pass 21 / fail 0`；typecheck 通过；lint 0 warning；fmt 通过；build 产出 `dist/chat.js`。`oxfmt` 会检查 markdown，改完文档后跑 `npm run fmt` 再 `fmt:check`。

真机验收（需填 key）：`node --env-file-if-exists=.env scripts/acceptance.ts`。

## 7. 已知限制与未验证项

- 真机 DeepSeek 调用**未验证**（无 key）；验收脚本已备好。
- 人工"重启服务后任务仍在"未做，只有 JSON 文件测试间接证明。
- 子任务无多层与循环引用检测。
- 批量破坏性操作（「全删了」）只在 system prompt 层要求确认，无代码级保障。
- 无请求超时控制，`reply` 可能无限等待。
- 对话历史刷新即清空，指代（「刚才那条」）跨会话丢失。

## 8. 给接手者的优化清单（按优先级）

**P0 · 确认状态机**：把「删除含子任务父任务」「批量删除」的确认做成显式状态（待确认操作 + 持久化 + 超时），不再单纯依赖模型遵循 prompt。涉及 `agent.ts`、`agent-tools.ts`，需加测试。

**P0 · 超时控制**：给 `callModel` 加 `AbortSignal.timeout`（如 20s），超时走现有兜底。涉及 `agent.ts`，加测试。

**P1 · 真机验收**：填 key 跑 `scripts/acceptance.ts`，重点观察模型是否真的做到：操作前先 `list_tasks`、相似任务反问、破坏性操作确认、相对日期换算。把结果写进 SUBMIT.md（注意：SUBMIT.md 由候选人本人写，接手者不要代写）。

**P1 · 上下文膨胀**：`list_tasks` 返回完整任务数组，长清单会撑爆上下文。加分页/字段裁剪/摘要优先策略。涉及 `agent-tools.ts`。

**P2 · 子任务增强**：多层嵌套 + 循环引用检测 + 展示层级；父任务完成度由子任务推导。

**P2 · 前端**：把 ⬜/✅、优先级、工作量做成更明确的视觉标签；支持深色模式；保留 `white-space: pre-wrap`。

**P3 · 可维护性**：把 `intent.ts`/`model-intent.ts`/`format.ts`（旧规则引擎遗留，现已无引用）清理掉；给 `scripts/acceptance.ts` 加断言与退出码以便接入 CI。

每次改动后：跑全部质量命令 → Conventional Commit → push 前确认。
