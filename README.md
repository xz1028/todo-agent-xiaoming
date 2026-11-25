# 小明智能体 · 待办清单

一个用中文对话管理待办任务的智能体。通过 OpenAI function calling 工具循环创建、查看、完成、删除和改名任务，任务持久化在本地 JSON 文件中，刷新页面或重启服务后依然保留。

仓库地址：<https://github.com/xz1028/todo-agent-xiaoming>

## 功能特性

- **对话式任务管理**：创建、查看、标记完成、撤销完成、改名、删除，全用中文自然语言完成。
- **语义匹配**：说「牛奶买好了」即可对应到清单里的「买牛奶」；操作前会读取最新清单，不依赖对话历史判断状态。相似任务会先反问，找不到的任务如实告知。
- **一句话多条任务**：「记一下买牛奶和取快递」会一次创建多条。
- **扩展属性**：优先级（高/中/低）、工作量（小/中/大）、到期日（今天到期 / 已逾期过滤）、子任务（`parentId`，删除父任务需确认）。
- **清晰的清单展示**：未完成任务置顶，用 ⬜ / ✅ 标记状态，并给出「共 N 项，未完成 M 项」统计。
- **删除确认**：普通单条任务直接删除；批量删除或删除含子任务的父任务时，服务端先保存待确认操作，需在 5 分钟内按提示回复确认码。重启服务后仍可确认，取消、过期和任务变更都会阻止旧操作执行。
- **健壮的兜底**：无 API key、网络错误、超时或模型返回异常时返回友好中文提示，不会导致接口 500；每次模型调用最多等待 20 秒且不自动重试；客户端懒加载，缺 key 时服务照常启动。

## 快速开始

需要 **Node.js 24.12 或更高版本**。

```sh
git clone https://github.com/xz1028/todo-agent-xiaoming.git
cd todo-agent-xiaoming
npm ci
npm run dev
```

浏览器打开 <http://127.0.0.1:3000> 即可开始对话。若 3000 端口被占用，可用 `PORT=3001 npm run dev`。

### 接入模型

默认 `deepseek-flash`。如需接入，在根目录创建 `.env`：

```sh
cp .env.example .env
# 填写 DEEPSEEK_API_KEY，可选 DEEPSEEK_MODEL 更换模型
```

重启 `npm run dev` 后生效。未配置 key 时功能受限，只会返回兜底提示；任务 API 与测试不依赖 key。

## 使用示例

| 你说                                 | 小明的行为                         |
| ------------------------------------ | ---------------------------------- |
| 帮我记一下买牛奶                     | 新增待办「买牛奶」                 |
| 记一下买牛奶和取快递                 | 一次新增两条                       |
| 我有哪些任务？                       | 列出任务及完成状态，未完成置顶     |
| 交报告，明天到期，高优先级，工作量大 | 创建带到期日与属性的任务           |
| 牛奶买好了                           | 将「买牛奶」标记为已完成           |
| 今天要做什么？                       | 列出今天到期与已逾期的未完成任务   |
| 取快递这条删掉吧                     | 删除「取快递」                     |
| 删除买牛奶和取快递                   | 展示待删除任务，等待带确认码的指令 |
| 再给我看看清单                       | 展示最新清单                       |

任务写入项目根目录 `data/tasks.json`（已加入 `.gitignore`），重启服务后仍可查询。浏览器中的聊天记录在刷新后会清空。待确认删除保存在 `data/pending-deletion.json`（同样不提交），确认时不依赖浏览器历史或模型调用。

## 验证

```sh
npm test && npm run typecheck && npm run lint && npm run fmt:check && npm run build
```

`npm test` 使用临时目录中的真实 JSON 存储 + 脚本化假模型，无需 API key，覆盖验收对话、工具层边界、兜底逻辑与扩展功能。填好 key 后可运行真机验收脚本：

```sh
node --env-file-if-exists=.env scripts/acceptance.ts
```

它会自动清空任务、累积对话跑完 6 步，并逐轮打印回复与任务状态。更多运行与验证细节见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 项目结构

| 路径                                 | 作用                                                       |
| ------------------------------------ | ---------------------------------------------------------- |
| `src/App.tsx`、`src/ChatHistory.tsx` | 聊天界面，发送对话历史并渲染回复                           |
| `server/index.ts`                    | 组装 agent 与任务存储，启动服务                            |
| `server/agent.ts`                    | 智能体实现：function calling 工具循环、system prompt、兜底 |
| `server/agent-tools.ts`              | 工具 schema 与执行器（增删改查、到期过滤、子任务）         |
| `server/deletion-confirmation.ts`    | 待确认删除的持久化、超时、取消与快照校验                   |
| `server/app.ts`                      | Express 路由：`/api/chat` 与 `/api/tasks`                  |
| `server/task-store.ts`               | 本地 JSON 任务存储（临时文件 + rename 原子写入）           |
| `server/tasks.ts`                    | 任务 API 的输入校验与响应                                  |
| `server/model.ts`                    | DeepSeek 客户端与模型配置                                  |
| `server/openapi.yaml`                | 任务 API 完整定义                                          |
| `shared/chat.ts`                     | 对话消息类型与请求校验                                     |
| `scripts/acceptance.ts`              | 真机验收脚本                                               |

任务接口的完整路径、字段与返回值见 [OpenAPI 说明](server/openapi.yaml)。

## 技术栈

TypeScript（Node 原生运行 `.ts`）、Express 5、OpenAI SDK、zod、React 19、node:test、oxlint / oxfmt。未引入额外依赖。
