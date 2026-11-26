import { useEffect, useState } from "react";
import {
  loadThemePreference,
  saveThemePreference,
  themeKey,
  type ThemePreference,
} from "./theme.ts";

export function ThemeSelector() {
  const [preference, setPreference] = useState(loadThemePreference);
  const [warning, setWarning] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.theme = preference;
    const updateBrowserColor = () => {
      const color = getComputedStyle(document.documentElement).getPropertyValue("--page-bg").trim();
      if (color) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
    };
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    updateBrowserColor();
    media.addEventListener("change", updateBrowserColor);
    return () => media.removeEventListener("change", updateBrowserColor);
  }, [preference]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === themeKey || event.key === null) {
        setPreference(loadThemePreference());
        setWarning(false);
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return (
    <>
      <select
        className="theme-select"
        aria-label="外观模式"
        title="外观模式"
        value={preference}
        onChange={(event) => {
          const next = event.target.value as ThemePreference;
          document.documentElement.dataset.theme = next;
          setPreference(next);
          setWarning(!saveThemePreference(next));
        }}
      >
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
      {warning && (
        <output role="status" className="theme-notice">
          外观已切换，浏览器未能保存本次选择。
        </output>
      )}
    </>
  );
}
