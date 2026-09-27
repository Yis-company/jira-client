import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { edits, type WorkspaceChangeEvent } from "../lib/edits";
import { ownerKey, useEditRuntime } from "./useEditRuntime";
import type { Session } from "../lib/bridge";

const editApi = vi.hoisted(() => ({
  list: vi.fn(),
  capabilities: vi.fn(),
  enqueue: vi.fn(),
  resolve: vi.fn(),
  sync: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("../lib/edits", () => ({ edits: editApi }));
const session: Session = {
  siteUrl: "https://jira.test/",
  email: " Yi@Example.com ",
  accountName: "Yi",
};
const accountKey = ownerKey(session);

function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useEditRuntime(session, accountKey), {
    wrapper,
  });
  return { client, ...hook };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
  vi.mocked(edits.sync).mockResolvedValue(undefined);
  vi.mocked(edits.subscribe).mockResolvedValue(() => undefined);
});
afterEach(cleanup);

describe("edit runtime ownership", () => {
  it("starts the worker and unsubscribes on unmount", async () => {
    const stop = vi.fn();
    vi.mocked(edits.subscribe).mockResolvedValue(stop);
    const hook = harness();
    await waitFor(() => expect(edits.sync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(edits.subscribe).toHaveBeenCalledTimes(1));
    hook.unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes if the async listener resolves after unmount", async () => {
    let resolveSubscribe!: (stop: () => void) => void;
    vi.mocked(edits.subscribe).mockImplementation(() =>
      new Promise((resolve) => {
        resolveSubscribe = resolve;
      })
    );
    const hook = harness();
    await waitFor(() => expect(edits.subscribe).toHaveBeenCalledTimes(1));
    hook.unmount();
    const stop = vi.fn();
    await act(async () => resolveSubscribe(stop));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("ignores events from other owners and invalidates all owner-scoped read surfaces", async () => {
    let receive!: (event: WorkspaceChangeEvent) => void;
    vi.mocked(edits.subscribe).mockImplementation(async (handler) => {
      receive = handler;
      return () => undefined;
    });
    const hook = harness();
    await waitFor(() => expect(receive).toBeTypeOf("function"));
    await waitFor(() => expect(edits.sync).toHaveBeenCalledTimes(1));
    const invalidate = vi.spyOn(hook.client, "invalidateQueries");
    const event = (siteUrl: string, email: string): WorkspaceChangeEvent => ({
      owner: { siteUrl, email },
      revision: 1,
      issueId: "100",
    });
    receive(event("https://other.atlassian.net", "yi@example.com"));
    expect(invalidate).not.toHaveBeenCalled();
    receive(event("HTTPS://JIRA.TEST", "YI@example.com"));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["changes", accountKey],
      })
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["cached-issues", accountKey],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["cached-issue", accountKey],
    });
  });
});
