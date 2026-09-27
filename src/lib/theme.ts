import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";
export const THEME_STORAGE_KEY = "jira-client.theme";

export function readThemePreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(preference: ThemePreference, systemDark?: boolean) {
  if (typeof document === "undefined") return;
  const prefersDark =
    systemDark ??
    (typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches === true);
  const dark =
    preference === "dark" || (preference === "system" && prefersDark);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function useThemePreference() {
  const [theme, setThemeState] = useState<ThemePreference>(readThemePreference);
  const setTheme = useCallback((next: ThemePreference) => {
    try {
      if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // The in-memory preference still applies when browser storage is unavailable.
    }
    setThemeState(next);
    applyTheme(next);
  }, []);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyTheme("system", media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, [theme]);

  return [theme, setTheme] as const;
}

// Apply the persisted theme as soon as this module loads, before React paints.
applyTheme(readThemePreference());
