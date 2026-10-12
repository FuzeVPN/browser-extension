// SPDX-License-Identifier: MPL-2.0

import type { ExtensionApi, PlatformEventHandlers } from "../contracts/extension-api";

export function hasExtensionApi(): boolean {
  return typeof browser !== "undefined";
}

/** Resolve the native API on access, including after a background restoration. */
export const extensionApi = new Proxy({} as ExtensionApi, {
  get(_target, property) {
    if (!hasExtensionApi()) throw new Error("extension_api_unavailable");
    return Reflect.get(browser, property) as unknown;
  },
});

export function configureTrustedStorage(): Promise<void> {
  // Firefox session storage is restricted to extension contexts. No content
  // scripts or injection permissions are shipped; audits enforce this boundary.
  return Promise.resolve();
}

export async function inspectWebRtc(): Promise<boolean> {
  const setting = await browser.privacy.network.webRTCIPHandlingPolicy.get({});
  return (
    setting.levelOfControl === "controlled_by_this_extension" &&
    setting.value === "disable_non_proxied_udp"
  );
}

export function registerPlatformEvents(handlers: PlatformEventHandlers): void {
  browser.proxy.settings.onChange.addListener(() => handlers.proxyChanged());
  browser.proxy.onError.addListener((details) => handlers.proxyError(details.message));
  browser.webRequest.onErrorOccurred.addListener(
    (details) => {
      if (/^(?:NS_ERROR_PROXY_|NS_ERROR_UNKNOWN_PROXY_HOST)/.test(details.error))
        handlers.proxyError(details.error);
    },
    { urls: ["<all_urls>"] },
  );
  browser.permissions.onRemoved.addListener((removed) => {
    if (removed.data_collection?.includes("technicalAndInteraction"))
      handlers.diagnosticsConsentRemoved();
    if (removed.data_collection?.length && !removed.permissions?.length && !removed.origins?.length)
      return;
    handlers.permissionsChanged();
  });
  browser.permissions.onAdded.addListener((added) => {
    if (added.data_collection?.includes("technicalAndInteraction"))
      handlers.diagnosticsConsentAdded();
  });
  browser.privacy.network.webRTCIPHandlingPolicy.onChange.addListener(() =>
    handlers.privacyChanged(),
  );
  browser.privacy.network.networkPredictionEnabled.onChange.addListener(() =>
    handlers.privacyChanged(),
  );
}
