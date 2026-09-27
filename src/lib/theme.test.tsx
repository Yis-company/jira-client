import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  readThemePreference,
  THEME_STORAGE_KEY,
  useThemePreference,
} from "./theme";

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
});

describe("theme preference", () => {
  it("defaults to system and ignores invalid stored values", () => {
    expect(readThemePreference()).toBe("system");
    localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    expect(readThemePreference()).toBe("system");
  });

  it("applies explicit and system themes to the document root", () => {
    applyTheme("dark", false);
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyTheme("light", true);
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement.dataset.theme).toBe("light");
    applyTheme("system", true);
    expect(document.documentElement).toHaveClass("dark");
  });

  it("persists only explicit preference and follows OS changes while on System", () => {
    let listener: ((event: MediaQueryListEvent) => void) | undefined;
    const media = {
      matches: false,
      addEventListener: vi.fn(
        (_type: string, callback: (event: MediaQueryListEvent) => void) => {
          listener = callback;
        },
      ),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => media),
    );
    const { result, unmount } = renderHook(() => useThemePreference());
    expect(result.current[0]).toBe("system");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement).not.toHaveClass("dark");

    media.matches = true;
    act(() => listener?.({ matches: true } as MediaQueryListEvent));
    expect(document.documentElement).toHaveClass("dark");

    act(() => result.current[1]("light"));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement).not.toHaveClass("dark");

    act(() => result.current[1]("system"));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(media.removeEventListener).toHaveBeenCalled();
    unmount();
  });
});
