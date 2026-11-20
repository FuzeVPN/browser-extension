// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it, vi } from "vitest";
import { watchAuthenticationTab } from "../../src/core/auth/authentication-tab";

const STATE = "s".repeat(43);
const START = `https://app.fuzevpn.com/extension/connect?client_id=fuzevpn-browser-extension&state=${STATE}&locale=fr`;

interface Tab {
  id?: number;
  url?: string;
  pendingUrl?: string;
}

/** The tabs of a browser, as the extension is allowed to see them. */
function browser(open: Tab[] = []) {
  const listeners = new Set<(tab: Tab) => void>();
  const tabs = {
    onCreated: vi.fn((listener: (tab: Tab) => void) => void listeners.add(listener)),
    offCreated: vi.fn((listener: (tab: Tab) => void) => void listeners.delete(listener)),
    get: vi.fn(async (id: number) => {
      const tab = open.find((candidate) => candidate.id === id);
      if (!tab) throw new Error("No tab with id");
      return { ...tab };
    }),
    remove: vi.fn(async (id: number) => {
      const index = open.findIndex((tab) => tab.id === id);
      if (index < 0) throw new Error("No tab with id");
      open.splice(index, 1);
    }),
  };
  return {
    tabs,
    open,
    listening: () => listeners.size,
    create(tab: Tab) {
      open.push(tab);
      for (const listener of listeners) listener({ ...tab });
    },
  };
}

describe("the tab which a web authentication opens", () => {
  it("is closed when the attempt is given up", async () => {
    const b = browser([{ id: 1, url: "https://example.org/" }]);
    const tab = watchAuthenticationTab(b.tabs, START);
    b.create({ id: 7, url: START });

    await tab.close();

    expect(b.tabs.remove).toHaveBeenCalledExactlyOnceWith(7);
    expect(b.open).toEqual([{ id: 1, url: "https://example.org/" }]);
    expect(b.listening()).toBe(0);
    // Recognised when it was created: no tab is read again.
    expect(b.tabs.get).not.toHaveBeenCalled();
  });

  it("is recognised while its address is still pending", async () => {
    const b = browser();
    const tab = watchAuthenticationTab(b.tabs, START);
    b.create({ id: 7, pendingUrl: START });
    await tab.close();
    expect(b.tabs.remove).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("is recognised once the page has changed its own parameters", async () => {
    const b = browser();
    const tab = watchAuthenticationTab(b.tabs, START);
    // The page dropped the language and added the time it started at.
    b.create({ id: 7, url: START.replace("&locale=fr", "&started_at=1790000000000") });
    await tab.close();
    expect(b.tabs.remove).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("is still closed after it has moved to another page of the sign-in", async () => {
    const b = browser();
    const tab = watchAuthenticationTab(b.tabs, START);
    b.create({ id: 7, url: START });
    b.open[0]!.url = "https://accounts.example.com/signin";
    await tab.close();
    expect(b.tabs.remove).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("is read again when its creation showed no address yet", async () => {
    const b = browser();
    const tab = watchAuthenticationTab(b.tabs, START);
    b.create({ id: 6 });
    b.create({ id: 7 });
    b.open[0]!.url = "https://example.org/opened-meanwhile";
    b.open[1]!.url = START;
    await tab.close();
    expect(b.tabs.remove).toHaveBeenCalledExactlyOnceWith(7);
    expect(b.open.map(({ id }) => id)).toEqual([6]);
  });

  it("never reads a tab which existed before the attempt, or one created after it ended", async () => {
    const b = browser([{ id: 1, url: START }]);
    const tab = watchAuthenticationTab(b.tabs, START);
    await tab.close();
    b.create({ id: 9, url: START });
    expect(b.tabs.get).not.toHaveBeenCalled();
    expect(b.tabs.remove).not.toHaveBeenCalled();
    expect(b.open).toHaveLength(2);
  });

  it.each([
    ["the same page for another attempt", START.replace(STATE, "t".repeat(43))],
    ["the same page without a state", "https://app.fuzevpn.com/extension/connect"],
    ["another page of the same site", `https://app.fuzevpn.com/login?state=${STATE}`],
    ["another site with the same state", `https://example.org/extension/connect?state=${STATE}`],
    ["an address which is none", "about:blank"],
  ])("never closes a tab which shows %s", async (_name, url) => {
    const b = browser();
    const tab = watchAuthenticationTab(b.tabs, START);
    b.create({ id: 2, url });
    b.create({ id: 3 });
    b.open[1]!.url = url;
    await tab.close();
    expect(b.tabs.remove).not.toHaveBeenCalled();
    expect(b.open).toHaveLength(2);
  });

  it("closes nothing when the browser shows no address", async () => {
    const b = browser();
    const tab = watchAuthenticationTab(b.tabs, START);
    b.create({ id: 7 });
    await tab.close();
    expect(b.tabs.remove).not.toHaveBeenCalled();
  });

  it("keeps few tabs to read again, however many are created", async () => {
    const b = browser();
    const tab = watchAuthenticationTab(b.tabs, START);
    for (let id = 1; id <= 40; id += 1) b.create({ id });
    await tab.close();
    expect(b.tabs.get.mock.calls.length).toBe(16);
  });

  it("stops watching, and closes nothing, when the attempt ends by itself", async () => {
    const b = browser();
    const tab = watchAuthenticationTab(b.tabs, START);
    b.create({ id: 7, url: START });
    tab.release();
    expect(b.listening()).toBe(0);
    expect(b.tabs.remove).not.toHaveBeenCalled();
    expect(b.tabs.get).not.toHaveBeenCalled();
  });

  it("closes its tab once, and keeps no other tab for a later call", async () => {
    const b = browser();
    const tab = watchAuthenticationTab(b.tabs, START);
    b.create({ id: 7, url: START });
    await tab.close();
    await tab.close();
    expect(b.tabs.remove).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("does not fail when the tab is already closed, or the browser refuses", async () => {
    const b = browser();
    const tab = watchAuthenticationTab(b.tabs, START);
    b.create({ id: 7, url: START });
    b.open.length = 0;
    await expect(tab.close()).resolves.toBeUndefined();

    const refusing = browser();
    const refused = watchAuthenticationTab(refusing.tabs, START);
    refusing.create({ id: 7 });
    refusing.tabs.get.mockRejectedValue(new Error("unavailable"));
    await expect(refused.close()).resolves.toBeUndefined();
  });
});
