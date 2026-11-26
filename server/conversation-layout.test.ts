import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { transformSync } from "esbuild";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

type Props = React.ComponentProps<typeof import("../src/ConversationList.tsx").ConversationList> & {
  compact: boolean;
};
const { code } = transformSync(
  readFileSync(new URL("../src/ConversationList.tsx", import.meta.url), "utf8"),
  { loader: "tsx", format: "cjs", jsx: "transform" },
);
const compiled = { exports: {} as { ConversationList: React.ComponentType<Props> } };
new Function("require", "module", "exports", "React", code)(
  createRequire(new URL("../src/ConversationList.tsx", import.meta.url)),
  compiled,
  compiled.exports,
  React,
);
const noop = () => {};
function render(compact: boolean) {
  return renderToStaticMarkup(
    React.createElement(compiled.exports.ConversationList, {
      compact,
      open: true,
      disabled: false,
      history: {
        version: 2,
        activeId: "saved",
        conversations: [
          {
            id: "saved",
            title: "出行计划",
            customTitle: true,
            createdAt: 1,
            updatedAt: 1,
            session: { version: 1, messages: [{ role: "user", content: "买车票" }] },
          },
        ],
      },
      onClose: noop,
      onNew: noop,
      onSelect: noop,
      onRename: noop,
      onDelete: noop,
      onRestore: noop,
    }),
  );
}
test("历史布局：桌面使用非模态侧栏，窄屏保留可访问的对话框与会话操作", () => {
  const desktop = render(false);
  assert.match(desktop, /^<aside\b/u);
  assert.doesNotMatch(desktop, /<dialog\b/u);
  const mobile = render(true);
  assert.match(mobile, /^<dialog\b/u);
  for (const html of [desktop, mobile]) {
    assert.match(html, /aria-labelledby="history-title"/u);
    assert.match(html, /aria-label="搜索会话标题"/u);
    assert.match(html, /aria-label="打开会话：出行计划"/u);
    assert.match(html, /aria-current="true"/u);
    assert.match(html, /aria-label="重命名会话：出行计划"/u);
    assert.match(html, /aria-label="删除会话：出行计划"/u);
  }
});
