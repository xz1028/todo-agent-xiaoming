import assert from "node:assert/strict";
import { test } from "node:test";
import { saveSession, type SavedSession } from "../src/session.ts";
import {
  activeConversation,
  loadConversations,
  saveConversations,
  newConversation,
  switchConversation,
  renameConversation,
  deleteConversation,
  restoreConversation,
  updateConversationSession,
} from "../src/conversations.ts";

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
const session = (text: string): SavedSession => ({
  version: 1,
  messages: [
    { role: "user", content: text },
    { role: "assistant", content: "回复：" + text },
  ],
});

test("历史迁移：旧单会话的消息和未完成请求进入列表，v1原文仍保留", () => {
  const store = storage();
  const previous = {
    ...session("买牛奶"),
    request: {
      requestId: crypto.randomUUID(),
      messages: [{ role: "user" as const, content: "继续查询" }],
    },
  };
  saveSession(previous, store);
  const original = store.getItem("xiaoming.chat.v1");
  const loaded = loadConversations(store);
  assert.equal(loaded.history.conversations.length, 1);
  assert.equal(activeConversation(loaded.history).title, "买牛奶");
  assert.deepEqual(activeConversation(loaded.history).session, previous);
  assert.equal(saveConversations(loaded.history, store), true);
  assert.deepEqual(loadConversations(store).history, loaded.history);
  assert.equal(store.getItem("xiaoming.chat.v1"), original);
});

test("历史隔离：新建保留原记录，切换并刷新后只使用选中会话的消息", () => {
  const store = storage();
  let history = loadConversations(store).history;
  const first = history.activeId;
  history = updateConversationSession(history, first, session("会话甲"));
  const before = history;
  history = newConversation(history);
  const second = history.activeId;
  assert.notEqual(first, second);
  assert.deepEqual(activeConversation(history).session.messages, []);
  history = updateConversationSession(history, second, session("会话乙"));
  history = switchConversation(history, first);
  saveConversations(history, store);
  const restored = loadConversations(store).history;
  assert.deepEqual(activeConversation(restored).session.messages, session("会话甲").messages);
  assert.equal(restored.conversations.find((item) => item.id === second)?.title, "会话乙");
  assert.equal(before.conversations.length, 1, "操作不修改旧状态");
});

test("历史标题：自动取首条用户消息，重命名后追加消息不覆盖自定义标题", () => {
  let history = loadConversations(storage()).history;
  history = updateConversationSession(history, history.activeId, session("第一句话"));
  assert.equal(activeConversation(history).title, "第一句话");
  history = renameConversation(history, history.activeId, "  自定义会话  ");
  history = updateConversationSession(history, history.activeId, session("另一句话"));
  assert.equal(activeConversation(history).title, "自定义会话");
  assert.throws(() => renameConversation(history, history.activeId, "  "), /标题/u);
});

test("历史删除：切换到其它会话，最近删除可在刷新后恢复；删除最后一条仍有空白会话", () => {
  const store = storage();
  let history = loadConversations(store).history;
  const first = history.activeId;
  history = updateConversationSession(history, first, session("保留记录"));
  history = newConversation(history);
  const second = history.activeId;
  history = updateConversationSession(history, second, session("第二条"));
  history = deleteConversation(history, second);
  assert.equal(history.activeId, first);
  assert.ok(history.conversations.find((item) => item.id === second)?.deletedAt);
  saveConversations(history, store);
  history = loadConversations(store).history;
  history = restoreConversation(history, second);
  assert.equal(history.activeId, second);
  assert.deepEqual(activeConversation(history).session.messages, session("第二条").messages);
  history = deleteConversation(deleteConversation(history, second), first);
  assert.deepEqual(activeConversation(history).session.messages, []);
  assert.equal(history.conversations.filter((item) => !item.deletedAt).length, 1);
});

test("历史请求：未完成时禁止切换/新建/删除，刷新优先恢复请求所属会话", () => {
  const store = storage();
  let history = loadConversations(store).history;
  const first = history.activeId;
  history = updateConversationSession(history, first, session("第一条"));
  history = newConversation(history);
  const second = history.activeId;
  history = updateConversationSession(history, second, {
    ...session("处理中"),
    request: { requestId: crypto.randomUUID(), messages: [{ role: "user", content: "新增" }] },
  });
  assert.throws(() => newConversation(history), /处理|等待/u);
  assert.throws(() => switchConversation(history, first), /处理|等待/u);
  assert.throws(() => deleteConversation(history, second), /处理|等待/u);
  saveConversations({ ...history, activeId: first }, store);
  assert.equal(loadConversations(store).history.activeId, second);
  history = updateConversationSession(history, second, session("完成回复"));
  assert.equal(switchConversation(history, first).activeId, first);
});

test("历史保护：损坏数据提示并先备份，保存失败不破坏已有历史", () => {
  const store = storage();
  store.setItem("xiaoming.chats.v2", "broken history");
  const loaded = loadConversations(store);
  assert.ok(loaded.warning);
  assert.equal(store.getItem("xiaoming.chats.v2"), "broken history");
  assert.equal(saveConversations(loaded.history, store), true);
  assert.equal(store.getItem("xiaoming.chats.v2.recovery"), "broken history");
  const saved = store.getItem("xiaoming.chats.v2");
  assert.equal(
    saveConversations(newConversation(loaded.history), {
      getItem: store.getItem,
      setItem() {
        throw new Error("quota");
      },
    }),
    false,
  );
  assert.equal(store.getItem("xiaoming.chats.v2"), saved);
});

test("历史回执：晚到回复只更新所属会话，旧请求不能覆盖已完成记录", async () => {
  const { finishConversationRequest } = await import("../src/conversations.ts");
  let history = loadConversations(storage()).history;
  const first = history.activeId;
  history = updateConversationSession(history, first, session("会话甲"));
  history = newConversation(history);
  const second = history.activeId;
  history = updateConversationSession(history, second, session("会话乙"));
  const requestId = crypto.randomUUID();
  history = updateConversationSession(history, first, {
    version: 1,
    messages: [{ role: "user", content: "甲请求" }],
    request: { requestId, messages: [{ role: "user", content: "甲请求" }] },
  });
  const result = finishConversationRequest(history, first, requestId, "甲回复");
  assert.equal(result.activeId, second);
  assert.deepEqual(activeConversation(result).session.messages, session("会话乙").messages);
  assert.equal(
    result.conversations.find((item) => item.id === first)?.session.messages.at(-1)?.content,
    "甲回复",
  );
  assert.equal(finishConversationRequest(result, first, requestId, "过期回复"), result);
});

test("历史标题：消息窗口截取后自动标题仍保留最初名称", () => {
  let history = loadConversations(storage()).history;
  history = updateConversationSession(history, history.activeId, session("最初主题"));
  history = updateConversationSession(history, history.activeId, session("截取后的首条消息"));
  assert.equal(activeConversation(history).title, "最初主题");
});

test("历史校验：超出Date范围的时间戳不能使界面崩溃", () => {
  const store = storage();
  const history = loadConversations(store).history;
  history.conversations[0].updatedAt = Number.MAX_VALUE;
  store.setItem("xiaoming.chats.v2", JSON.stringify(history));
  const result = loadConversations(store);
  assert.ok(result.warning);
  assert.ok(Number.isFinite(new Date(activeConversation(result.history).updatedAt).getTime()));
});
