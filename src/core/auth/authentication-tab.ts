// SPDX-License-Identifier: MPL-2.0

import type { AuthenticationTab } from "../../platform/contracts/web-auth";

interface Tab {
  id?: number;
  url?: string;
  pendingUrl?: string;
}

/**
 * What finding and closing the tab of a web authentication needs of a browser, and
 * nothing more: no list of the open tabs, and no reading of a tab which was not created
 * while an attempt was being watched.
 */
export interface CreatedTabs {
  /** Calls `listener` for each tab the browser creates, until `offCreated`. */
  onCreated(listener: (tab: Tab) => void): void;
  offCreated(listener: (tab: Tab) => void): void;
  /** Reads one tab again, by its identifier. */
  get(tabId: number): Promise<Tab>;
  remove(tabId: number): Promise<void>;
}

/** Tabs created during one attempt which showed no address yet: a user opens few. */
const MAX_UNKNOWN_TABS = 16;

/**
 * Finds the tab which a web authentication opens, so that the extension can close it
 * when the attempt is given up from the popup. The browsers give no handle on that
 * window, and leave it open: the page it shows keeps offering a sign-in which nothing
 * waits for any more, and a browser may refuse to open another one beside it.
 *
 * The tab is recognised by the address the attempt opens and by its `state`, a value
 * drawn at random for this attempt alone: no other tab can carry it. Only tabs created
 * while the attempt is watched are looked at, and their address is only compared, with
 * the host permissions the extension already has. Where the browser shows no address,
 * nothing is found and the window stays, as before.
 */
export function watchAuthenticationTab(tabs: CreatedTabs, url: string): AuthenticationTab {
  const expected = new URL(url);
  const state = expected.searchParams.get("state");
  let tabId: number | null = null;
  /** Created during the attempt without an address: read again when it is given up. */
  const unknown: number[] = [];
  let watching = true;

  const shows = (tab: Tab): boolean =>
    [tab.url, tab.pendingUrl].some((address) => {
      if (!address || !state) return false;
      try {
        const shown = new URL(address);
        // The page may add or drop parameters of its own while it loads.
        return (
          shown.origin === expected.origin &&
          shown.pathname === expected.pathname &&
          shown.searchParams.get("state") === state
        );
      } catch {
        return false;
      }
    });
  const created = (tab: Tab): void => {
    if (tabId !== null || tab.id === undefined) return;
    if (shows(tab)) tabId = tab.id;
    else if (!tab.url && !tab.pendingUrl && unknown.length < MAX_UNKNOWN_TABS) unknown.push(tab.id);
  };
  const release = (): void => {
    if (!watching) return;
    watching = false;
    tabs.offCreated(created);
  };
  tabs.onCreated(created);

  return {
    release,
    async close(): Promise<void> {
      release();
      try {
        let found = tabId;
        tabId = null;
        for (const candidate of unknown.splice(0)) {
          if (found !== null) break;
          const tab = await tabs.get(candidate).catch(() => null);
          if (tab && shows(tab)) found = candidate;
        }
        if (found !== null) await tabs.remove(found);
      } catch {
        // The tab is already closed, or the browser does not let it be: it stays, as before.
      }
    },
  };
}
