// SPDX-License-Identifier: MPL-2.0

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

interface BrowserWaitModule {
  waitForRead<T>(
    read: () => Promise<T>,
    matches: (value: T) => boolean | Promise<boolean>,
    options?: { timeoutMs?: number; intervalMs?: number; message?: string },
  ): Promise<T>;
}

const moduleUrl = pathToFileURL(
  resolve(import.meta.dirname, "../../scripts/browser-wait.mjs"),
).href;
const { waitForRead } = (await import(moduleUrl)) as BrowserWaitModule;

describe("asynchronous browser state polling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits through false asynchronous results and returns the matching snapshot", async () => {
    const connected = { status: "connected", trafficBlocked: false };
    const blocked = { status: "blocked", trafficBlocked: true };
    const read = vi.fn(async () => blocked).mockResolvedValueOnce(connected);
    const completed = vi.fn();
    const operation = waitForRead(read, async (value) => value.trafficBlocked, {
      timeoutMs: 100,
      intervalMs: 10,
    });
    void operation.then(completed);
    await vi.advanceTimersByTimeAsync(9);
    expect(read).toHaveBeenCalledOnce();
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(operation).resolves.toBe(blocked);
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a permanently false condition at the deadline and stops polling", async () => {
    const read = vi.fn(async () => false);
    const operation = waitForRead(read, (value) => value, {
      timeoutMs: 100,
      intervalMs: 10,
      message: "Expected state never arrived",
    });
    const failure = expect(operation).rejects.toThrow("Expected state never arrived");
    await vi.advanceTimersByTimeAsync(100);
    await failure;
    const attempts = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledTimes(attempts);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also bounds an unresolved browser read", async () => {
    const read = vi.fn(() => new Promise<boolean>(() => undefined));
    const operation = waitForRead(read, (value) => value, { timeoutMs: 100 });
    const failure = expect(operation).rejects.toThrow("Timed out waiting for browser state");
    await vi.advanceTimersByTimeAsync(100);
    await failure;
    expect(read).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
