import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { edits } from "./edits";
import { requestEditSync } from "./editSync";

const editApi = vi.hoisted(() => ({
  list: vi.fn(),
  capabilities: vi.fn(),
  enqueue: vi.fn(),
  resolve: vi.fn(),
  sync: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("./edits", () => ({ edits: editApi }));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("edit sync wake coalescing", () => {
  it("shares only an in-flight request for the same owner", async () => {
    let finish!: () => void;
    vi.mocked(edits.sync)
      .mockImplementationOnce(() =>
        new Promise((resolve) => {
          finish = resolve;
        })
      )
      .mockResolvedValueOnce(undefined);
    const first = requestEditSync("owner-a");
    const duplicate = requestEditSync("owner-a");
    expect(edits.sync).toHaveBeenCalledTimes(1);
    expect(first).toBe(duplicate);
    finish();
    await first;
    await requestEditSync("owner-a");
    expect(edits.sync).toHaveBeenCalledTimes(2);
  });

  it("releases a failed in-flight marker so retry can run", async () => {
    vi.mocked(edits.sync).mockRejectedValueOnce(new Error("Temporary error"))
      .mockResolvedValue(undefined);
    await expect(requestEditSync("owner-b")).rejects.toThrow("Temporary error");
    await expect(requestEditSync("owner-b")).resolves.toBeUndefined();
    expect(edits.sync).toHaveBeenCalledTimes(2);
  });
});
