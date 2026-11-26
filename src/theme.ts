export type ThemePreference = "system" | "light" | "dark";
export const themeKey = "xiaoming.theme.v1";
export function loadThemePreference(storage?: Pick<Storage, "getItem">): ThemePreference {
  try {
    const value = (storage ?? localStorage).getItem(themeKey);
    if (value === "light" || value === "dark") return value;
  } catch {
    /* 存储被禁用时仍可跟随系统。 */
  }
  return "system";
}
export function saveThemePreference(
  preference: ThemePreference,
  storage?: Pick<Storage, "setItem">,
): boolean {
  try {
    (storage ?? localStorage).setItem(themeKey, preference);
    return true;
  } catch {
    return false;
  }
}
