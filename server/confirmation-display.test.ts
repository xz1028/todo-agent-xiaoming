import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { transformSync } from "esbuild";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatMessage } from "../shared/chat.ts";
import { createDeletionConfirmation } from "./deletion-confirmation.ts";
import { createJsonTaskStore } from "./task-store.ts";
import {
  loadConversations,
  saveConversations,
  updateConversationSession,
} from "../src/conversations.ts";

type HistoryProps = React.ComponentProps<typeof import("../src/ChatHistory.tsx").ChatHistory>;
type ListProps = React.ComponentProps<
  typeof import("../src/ConversationList.tsx").ConversationList
>;
function component<P>(name: string): React.ComponentType<P> {
  const url = new URL("../src/" + name + ".tsx", import.meta.url);
  const { code } = transformSync(readFileSync(url, "utf8"), {
    loader: "tsx",
    format: "cjs",
    jsx: "transform",
  });
  const compiled = { exports: {} as Record<string, React.ComponentType<P>> };
  new Function("require", "module", "exports", "React", code)(
    createRequire(url),
    compiled,
    compiled.exports,
    React,
  );
  return compiled.exports[name];
}
const ChatHistory = component<HistoryProps>("ChatHistory");
const ConversationList = component<ListProps>("ConversationList");
const noop = () => {};
const render = (messages: ChatMessage[]) =>
  renderToStaticMarkup(
    React.createElement(ChatHistory, { messages, pending: false, onSelectPrompt: noop }),
  );

test("确认展示：真实服务端提示与按钮指令不露确认码，原指令仍可确认和取消", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "todo-confirmation-display-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tasks = createJsonTaskStore(join(dir, "tasks.json"));
  const parent = tasks.create("准备出行");
  tasks.create("订车票", { parentId: parent.id });
  const confirmation = createDeletionConfirmation(tasks, () => new Date());
  for (const action of ["取消删除", "确认删除"]) {
    const prompt = confirmation.finish([parent.id]);
    const code = confirmation.peek()!.code;
    const command = action + " " + code;
    const messages: ChatMessage[] = [
      { role: "assistant", content: prompt },
      { role: "user", content: command },
    ];
    const before = JSON.stringify(messages);
    const html = render(messages);
    assert.ok(!html.includes(code), "聊天中不应显示内部确认码");
    assert.match(html, /任务面板/u);
    assert.ok(html.includes(action));
    assert.equal(JSON.stringify(messages), before, "展示不改变用于发送、持久化和重试的消息");
    assert.match(
      confirmation.respond(command)!,
      action === "取消删除" ? /已取消删除/u : /已删除 2 项/u,
    );
  }
});

test("确认展示：普通消息、任务标识和无效确认指令保持原文", () => {
  const id = "12345678-1234-4123-8123-123456789abc";
  const messages: ChatMessage[] = [
    { role: "user", content: "检查任务 " + id },
    { role: "assistant", content: "⬜ 备份 " + id },
    { role: "user", content: "确认删除 not-a-code" },
    { role: "user", content: "备注：确认删除 " + id },
  ];
  const html = render(messages);
  for (const message of messages) assert.ok(html.includes(message.content));
});

test("确认展示：旧历史刷新后摘要、自动标题和可访问名称不露编号，原消息仍保存", () => {
  const code = "12345678-1234-4123-8123-123456789abc";
  const command = "确认删除 " + code;
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  let history = loadConversations(storage).history;
  history = updateConversationSession(history, history.activeId, {
    version: 1,
    messages: [{ role: "user", content: command }],
  });
  saveConversations(history, storage);
  history = loadConversations(storage).history;
  const props: ListProps = {
    compact: false,
    open: true,
    disabled: false,
    history,
    onClose: noop,
    onNew: noop,
    onSelect: noop,
    onRename: noop,
    onDelete: noop,
    onRestore: noop,
  };
  const html = renderToStaticMarkup(React.createElement(ConversationList, props));
  assert.ok(!html.includes(code) && !html.includes(code.slice(0, 20)));
  assert.match(html, /aria-label="打开会话：确认删除"/u);
  assert.equal(history.conversations[0].session.messages[0].content, command);
  history.conversations[0] = {
    ...history.conversations[0],
    customTitle: true,
    title: "保留编号 " + code,
  };
  const named = renderToStaticMarkup(React.createElement(ConversationList, { ...props, history }));
  assert.ok(named.includes("保留编号 " + code), "用户自定义标题中的编号不应被修改");
  history.conversations[0] = {
    ...history.conversations[0],
    customTitle: false,
    title: "确认删除 deadbeef-cafe",
  };
  const ordinary = renderToStaticMarkup(
    React.createElement(ConversationList, { ...props, history }),
  );
  assert.ok(
    ordinary.includes("确认删除 deadbeef-cafe"),
    "不完整的普通编号不能被当成有效确认码隐藏",
  );
});
