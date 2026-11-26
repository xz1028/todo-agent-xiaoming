import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { loadThemePreference, saveThemePreference, themeKey } from "../src/theme.ts";

test("外观偏好：默认和无效值跟随系统，三种选择分别持久化", () => {
  let value: string | null = null;
  const storage = {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
  assert.equal(loadThemePreference(storage), "system");
  for (const preference of ["light", "dark", "system"] as const) {
    assert.equal(saveThemePreference(preference, storage), true);
    assert.equal(loadThemePreference(storage), preference);
  }
  for (const invalid of ["", "Dark", "invalid"]) {
    value = invalid;
    assert.equal(loadThemePreference(storage), "system");
  }
});

test("外观偏好：浏览器存储不可用时安全降级", () => {
  const blocked = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  assert.equal(loadThemePreference(blocked), "system");
  assert.equal(saveThemePreference("dark", blocked), false);
});

test("首屏外观：样式表加载前读取偏好，存储异常也能显示页面", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const match = html.match(/<script>([\s\S]*?)<\/script>/u);
  assert.ok(match, "应有首屏主题引导");
  assert.ok(html.indexOf(match[0]) < html.indexOf('rel="stylesheet"'));
  for (const [saved, expected] of [
    ["dark", "dark"],
    ["light", "light"],
    ["system", "system"],
    ["invalid", "system"],
    [null, "system"],
  ]) {
    const document = { documentElement: { dataset: {} as Record<string, string> } };
    runInNewContext(match[1], {
      document,
      localStorage: {
        getItem(key: string) {
          assert.equal(key, themeKey);
          return saved;
        },
      },
    });
    assert.equal(document.documentElement.dataset.theme, expected);
  }
  const document = { documentElement: { dataset: {} as Record<string, string> } };
  runInNewContext(match[1], {
    document,
    localStorage: {
      getItem() {
        throw new Error("blocked");
      },
    },
  });
  assert.equal(document.documentElement.dataset.theme, "system");
});
