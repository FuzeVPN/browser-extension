// SPDX-License-Identifier: MPL-2.0

import type { ExtensionApi, PlatformEventHandlers } from "../contracts/extension-api";

/** Resolve at access time: imports must not capture an absent API or a test fixture. */
function nativeApi(): typeof chrome {
  if (typeof chrome === "undefined") throw new Error("Extension API unavailable");
  return chrome;
}

export const extensionApi = new Proxy({} as ExtensionApi, {
  get(_target, property) {
    const api = nativeApi();
    return Reflect.get(api, property) as unknown;
  },
});

export function hasExtensionApi(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime);
}

export async function configureTrustedStorage(): Promise<void> {
  const api = nativeApi();
  await Promise.all([
    api.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    api.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  ]);
}

export async function inspectWebRtc(): Promise<boolean> {
  const api = nativeApi();
  // A private window may hold its own override: like the safety inspection, the claim
  // covers every context this extension can reach.
  const contexts = (await api.extension.isAllowedIncognitoAccess()) ? [false, true] : [false];
  const settings = await Promise.all(
    contexts.map((incognito) => api.privacy.network.webRTCIPHandlingPolicy.get({ incognito })),
  );
  return settings.every(
    (setting) =>
      setting.levelOfControl === "controlled_by_this_extension" &&
      setting.value === "disable_non_proxied_udp",
  );
}

export function registerPlatformEvents(handlers: PlatformEventHandlers): void {
  const api = nativeApi();
  api.proxy.settings.onChange.addListener(() => handlers.proxyChanged());
  api.proxy.onProxyError.addListener((details) => handlers.proxyError(details.error));
  api.permissions.onRemoved.addListener(() => handlers.permissionsChanged());
  api.permissions.onAdded.addListener(() => handlers.permissionsChanged());
  api.privacy.network.webRTCIPHandlingPolicy.onChange.addListener(() => handlers.privacyChanged());
  api.privacy.network.networkPredictionEnabled.onChange.addListener(() =>
    handlers.privacyChanged(),
  );
}
