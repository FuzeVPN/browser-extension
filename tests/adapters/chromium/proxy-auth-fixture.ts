// SPDX-License-Identifier: MPL-2.0

import { vi } from "vitest";
import type { ProxySession } from "../../../src/core/api/types";
import type { ProxyAuthHandler } from "../../../src/platform/chromium/proxy-auth";
import { proxyConfig } from "../../../src/platform/chromium/proxy-controller";
import { proxySession } from "./helpers";

export async function captureProxyAuthRequest(
  handler: ProxyAuthHandler,
  requestId: string,
  session: ProxySession = proxySession(),
) {
  type AuthListener = Parameters<typeof chrome.webRequest.onAuthRequired.addListener>[0];
  let authListener: AuthListener | undefined;
  let beforeListener: ((details: { requestId: string; tabId: number }) => unknown) | undefined;
  let changeListener: (() => unknown) | undefined;
  vi.stubGlobal("chrome", {
    extension: { isAllowedIncognitoAccess: async () => false },
    proxy: {
      settings: {
        get: async () => ({
          value: proxyConfig(session),
          levelOfControl: "controlled_by_this_extension",
        }),
        onChange: { addListener: (value: () => unknown) => (changeListener = value) },
      },
    },
    webRequest: {
      onBeforeRequest: {
        addListener: (value: typeof beforeListener) => (beforeListener = value),
      },
      onAuthRequired: { addListener: (value: AuthListener) => (authListener = value) },
      onCompleted: { addListener: () => undefined },
      onErrorOccurred: { addListener: () => undefined },
    },
  });
  handler.register();
  await new Promise<void>((resolve) => setImmediate(resolve));
  beforeListener?.({ requestId, tabId: 1 });
  return {
    authListener,
    change: () => changeListener?.(),
    start: (id: string) => beforeListener?.({ requestId: id, tabId: 1 }),
  };
}
