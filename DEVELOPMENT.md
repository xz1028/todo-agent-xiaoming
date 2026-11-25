# 开发与验证说明

本文档补充 README / GETTING_STARTED，说明本次实现的功能、运行与验证方式。

## 架构

- `server/agent.ts`：`createAgent({ tasks, client?, model?, now? })`，通过 OpenAI function calling 工具循环工作；`client` 懒加载，缺 key 时服务照常启动。
- `server/agent-tools.ts`：工具 schema（`list_tasks` / `add_tasks` / `complete_task` / `update_task` / `delete_task`）与执行器；参数错误返回结构化 JSON，不抛异常。
- `server/index.ts`：用依赖注入组装 `createAgent` 与 `createApp`。
- agent 单轮最多 6 次工具迭代；无 key、网络错误、超时或模型异常时返回中文兜底文案，不产生 500。

## 运行

需要 **Node.js >= 24.12**（本机默认的 22.x 不满足；如用 nvm：`nvm use 24`）。

```sh
npm ci
cp -n .env.example .env     # 真机验收时填 DEEPSEEK_API_KEY；测试不需要
npm run dev                 # http://127.0.0.1:3000
```

修改 `src/*.tsx` 后需 `npm run build` 并刷新页面。

## 验证

```sh
npm test && npm run typecheck && npm run lint && npm run fmt:check && npm run build
```

`npm test` 使用临时目录中的真实 JSON 存储 + 脚本化假模型，无需 API key，覆盖：

- 验收 6 步（创建 / 创建 / 查看 / 完成 / 删除 / 查看）及每步的真实存储状态；
- 工具层增删改查、多条添加、非法 JSON、空/超长标题、trim、不存在的 id；
- 兜底：client 抛错、工具迭代超上限；
- 扩展：清单摘要置顶统计、priority/effort 写入、dueToday/overdue 过滤、子任务 cascade 确认；
- HTTP 层：任务 API 兼容性与 `effort` 别名归一化。

### 真机验收（需 DEEPSEEK_API_KEY）

填好 `.env` 中的 key 并启动服务后运行：

```sh
node --env-file-if-exists=.env scripts/acceptance.ts
```

脚本会清空现有任务，累积 `messages` 跑完 6 步，打印每轮回复并逐轮读取 `/api/tasks` 核对状态。也可用 `BASE_URL` 指定其他地址。重启服务后再问「再给我看看清单」可验证任务持久化。

## 已实现功能

- 中文对话创建 / 查看 / 标记完成（含撤销）/ 改名 / 删除任务；任务落盘，刷新与重启后仍在。
- 一句话多任务、语义匹配（「牛奶买好了」）、相似任务反问、不存在如实告知、破坏性操作确认。
- 扩展：未完成置顶与统计、优先级、工作量（`effort`/`workload`）、到期日、今天/逾期过滤、子任务 cascade 删除。
- 前端清单状态视觉分层与换行显示。

取舍点与边界情况详见 `NOTES_FOR_SUBMIT.md`（供候选人撰写 SUBMIT.md 参考，本次未改动 SUBMIT.md）。
