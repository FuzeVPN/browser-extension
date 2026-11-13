// SPDX-License-Identifier: MPL-2.0

import { ExtensionAccountSessionStorage } from "../../src/core/storage/account-session-storage";
import { ExtensionStorageService } from "../../src/core/storage/storage";
import { AUTH, authenticatedState } from "./helpers";

function browserStorage(initial: Record<string, unknown> = {}) {
  const local = new Map<string, unknown>(Object.entries(initial));
  const events: string[] = [];
  const failing = { get: false, set: false, remove: false };
  vi.stubGlobal("browser", {
    storage: {
      local: {
        get: async (key: string) => {
          events.push(`get ${key}`);
          if (failing.get) throw new Error("storage unavailable");
          return local.has(key) ? { [key]: structuredClone(local.get(key)) } : {};
        },
        set: async (values: Record<string, unknown>) => {
          events.push(`set ${Object.keys(values).join(",")}`);
          if (failing.set) throw new Error("storage unavailable");
          for (const [key, value] of Object.entries(values)) local.set(key, structuredClone(value));
        },
        remove: async (key: string) => {
          events.push(`remove ${key}`);
          if (failing.remove) throw new Error("storage unavailable");
          local.delete(key);
        },
      },
    },
  });
  return { local, events, failing };
}

afterEach(() => vi.unstubAllGlobals());

describe("the observer of the stored account", () => {
  it("is ready before the account is read, then told which account is stored", async () => {
    const f = browserStorage({ fuzevpnState: authenticatedState() });
    const stored = vi.fn();
    const storage = new ExtensionStorageService({
      ready: async () => {
        await Promise.resolve();
        f.events.push("ready");
      },
      stored,
    });
    await expect(storage.readPersisted()).resolves.toMatchObject({ auth: AUTH });
    expect(f.events).toEqual(["ready", "get fuzevpnState"]);
    expect(stored).toHaveBeenCalledExactlyOnceWith(AUTH);
  });

  it("is told that no account is stored when the record holds none", async () => {
    const f = browserStorage({ fuzevpnState: { auth: "not a session", profile: null } });
    const stored = vi.fn();
    await new ExtensionStorageService({ stored }).readPersisted();
    expect(f.events).toEqual(["get fuzevpnState"]);
    expect(stored).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("is told of the account once it is written, and of none once it is cleared", async () => {
    browserStorage();
    const stored = vi.fn();
    const storage = new ExtensionStorageService({ stored });
    await storage.writePersisted(authenticatedState());
    expect(stored).toHaveBeenLastCalledWith(AUTH);
    await storage.writePersisted(authenticatedState({ auth: null }));
    expect(stored).toHaveBeenLastCalledWith(null);
    await storage.writePersisted(authenticatedState());
    await storage.clearPersisted();
    expect(stored).toHaveBeenLastCalledWith(null);
    expect(stored).toHaveBeenCalledTimes(4);
  });

  it("is told nothing by a read, a write or a removal which failed", async () => {
    const f = browserStorage({ fuzevpnState: authenticatedState() });
    const stored = vi.fn();
    const storage = new ExtensionStorageService({ stored });
    f.failing.get = f.failing.set = f.failing.remove = true;
    await expect(storage.readPersisted()).rejects.toThrow("storage unavailable");
    await expect(storage.writePersisted(authenticatedState({ auth: null }))).rejects.toThrow();
    await expect(storage.clearPersisted()).rejects.toThrow();
    expect(stored).not.toHaveBeenCalled();
    expect(f.local.get("fuzevpnState")).toMatchObject({ auth: AUTH });
  });

  it("does not let the account be read while it cannot be made ready", async () => {
    const f = browserStorage({ fuzevpnState: authenticatedState() });
    const storage = new ExtensionStorageService({
      ready: () => Promise.reject(new Error("sessions unavailable")),
    });
    await expect(storage.readPersisted()).rejects.toThrow("sessions unavailable");
    expect(f.events).toEqual([]);
  });

  it("is optional: the account is stored as before without it", async () => {
    const f = browserStorage();
    const storage = new ExtensionStorageService();
    await storage.writePersisted(authenticatedState());
    await expect(storage.readPersisted()).resolves.toMatchObject({ auth: AUTH });
    await storage.clearPersisted();
    expect([...f.local]).toEqual([]);
  });
});

describe("the storage of renewable sessions", () => {
  it("keeps the whole record under one key of local storage", async () => {
    const f = browserStorage();
    const storage = new ExtensionAccountSessionStorage();
    await expect(storage.read()).resolves.toBeUndefined();
    const record = { version: 1, revision: 1, sessions: [] };
    await storage.write(record);
    expect(Object.fromEntries(f.local)).toEqual({ fuzevpnAccountSessions: record });
    await expect(storage.read()).resolves.toEqual(record);
    expect(f.events).toEqual([
      "get fuzevpnAccountSessions",
      "set fuzevpnAccountSessions",
      "get fuzevpnAccountSessions",
    ]);
  });

  it("reports a failed read or write to its caller", async () => {
    const f = browserStorage();
    const storage = new ExtensionAccountSessionStorage();
    f.failing.get = f.failing.set = true;
    await expect(storage.read()).rejects.toThrow("storage unavailable");
    await expect(storage.write({})).rejects.toThrow("storage unavailable");
  });
});
