// SPDX-License-Identifier: MPL-2.0

import type { ProxySession } from "../../core/api/types";
import { validateSiteExclusionPolicy, type SiteExclusion } from "../../core/shared/site-exclusions";

export const PROXY_BYPASS_LIST = ["https://api.fuzevpn.com:443", "<-loopback>"] as const;

import {
  ProxyControlError,
  type ProxyControlLevel,
  type ProxyChallenger,
  type ProxyService,
} from "../contracts/proxy";
export {
  ProxyControlError,
  type ProxyControlLevel,
  type ProxyChallenger,
  type ProxyService,
} from "../contracts/proxy";

/** Private windows may have an independent override despite a verified regular setting. */
export async function protectedBrowserContexts(): Promise<boolean[]> {
  return (await chrome.extension.isAllowedIncognitoAccess()) ? [false, true] : [false];
}

export class PlatformProxyService implements ProxyService {
  private readonly usedEndpoints = new Map<string, ProxyChallenger>();
  private endpointStorage: Promise<void> = Promise.resolve();
  private exclusions: SiteExclusion[] = [];

  configureExclusions(entries: SiteExclusion[]): void {
    assertExclusions(entries);
    this.exclusions = entries.map((entry) => ({ ...entry }));
  }

  async isExclusionConfiguration(): Promise<boolean> {
    const settings = await this.readSettings();
    return settings.every((current) => this.matchesExclusionConfiguration(current));
  }

  private matchesExclusionConfiguration(
    current: chrome.types.ChromeSettingGetResult<chrome.proxy.ProxyConfig>,
  ): boolean {
    if (current.levelOfControl === "controllable_by_this_extension") return true;
    if (current.levelOfControl !== "controlled_by_this_extension") return false;
    const proxy = current.value.rules?.singleProxy;
    if (
      !proxy ||
      typeof proxy.host !== "string" ||
      !proxy.host ||
      typeof proxy.port !== "number" ||
      !Number.isInteger(proxy.port) ||
      (proxy.port ?? 0) < 1 ||
      (proxy.port ?? 0) > 65535
    ) {
      return false;
    }
    return matches(current.value, { host: proxy.host, port: proxy.port }, this.exclusions);
  }

  /** Updates only a proxy already owned by FuzeVPN; never creates a session or changes its node. */
  async updateExistingExclusions(previous: SiteExclusion[], next: SiteExclusion[]): Promise<void> {
    assertExclusions(previous);
    assertExclusions(next);
    await this.assertControllable();
    const current = await chrome.proxy.settings.get({ incognito: false });
    if (current.levelOfControl !== "controlled_by_this_extension") {
      if (current.levelOfControl === "controllable_by_this_extension") return;
      throw new ProxyControlError(current.levelOfControl);
    }
    const proxy = current.value.rules?.singleProxy;
    if (
      !proxy ||
      typeof proxy.host !== "string" ||
      !proxy.host ||
      typeof proxy.port !== "number" ||
      !Number.isInteger(proxy.port) ||
      (proxy.port ?? 0) < 1 ||
      (proxy.port ?? 0) > 65535
    ) {
      throw new ProxyControlError("configuration_rejected");
    }
    const endpoint = { host: proxy.host, port: proxy.port };
    // A worker may have stopped after writing the target configuration.
    if (matches(current.value, endpoint, next)) {
      await this.verifyExclusions(endpoint, next);
      return;
    }
    if (!matches(current.value, endpoint, previous)) {
      throw new ProxyControlError("configuration_rejected");
    }
    await chrome.proxy.settings.set({
      scope: "regular",
      value: { ...current.value, rules: { ...current.value.rules, bypassList: bypassList(next) } },
    });
    await this.verifyExclusions(endpoint, next);
  }

  async getControlLevel(): Promise<ProxyControlLevel> {
    const levels = (await this.readSettings()).map((result) => result.levelOfControl);
    if (levels.includes("not_controllable")) return "not_controllable";
    if (levels.includes("controlled_by_other_extensions")) return "controlled_by_other_extensions";
    return levels.includes("controlled_by_this_extension")
      ? "controlled_by_this_extension"
      : "controllable_by_this_extension";
  }

  async assertControllable(): Promise<void> {
    const level = await this.getControlLevel();
    if (level !== "controllable_by_this_extension" && level !== "controlled_by_this_extension") {
      throw new ProxyControlError(level);
    }
  }

  async apply(session: ProxySession): Promise<void> {
    await this.assertControllable();
    // A request may receive its first 407 after this proxy is cleared. Keep only
    // its endpoint (never credentials) for canceling those late challenges.
    await this.rememberEndpoint(session);
    await chrome.proxy.settings.set({
      scope: "regular",
      value: proxyConfig(session, this.exclusions),
    });
    if (!(await this.isActiveConfiguration(session))) {
      throw new ProxyControlError("configuration_rejected");
    }
  }

  async clear(): Promise<void> {
    const current = await chrome.proxy.settings.get({ incognito: false }).catch(() => null);
    const endpoint = current?.value.rules?.singleProxy;
    if (
      current?.levelOfControl === "controlled_by_this_extension" &&
      current.value.mode === "fixed_servers" &&
      endpoint?.scheme === "https"
    ) {
      // Also covers a configuration created before endpoint tracking existed.
      // Failure to persist this cancel-only history must not prevent disconnect.
      await this.rememberEndpoint({ host: endpoint.host, port: endpoint.port ?? 443 }).catch(
        () => undefined,
      );
    }
    await chrome.proxy.settings.clear({ scope: "regular" });
    if (
      (await this.readSettings()).some(
        (result) => result.levelOfControl === "controlled_by_this_extension",
      )
    ) {
      throw new ProxyControlError("configuration_rejected");
    }
  }

  async isActiveConfiguration(session: ProxySession): Promise<boolean> {
    return (await this.readSettings()).every(
      (result) =>
        result.levelOfControl === "controlled_by_this_extension" &&
        matches(result.value, session, this.exclusions),
    );
  }

  async isConfiguredProxyChallenge(challenger: ProxyChallenger): Promise<boolean> {
    return (await this.readSettings()).every(
      (result) =>
        result.levelOfControl === "controlled_by_this_extension" &&
        matchesChallenger(result.value, challenger),
    );
  }

  private async readSettings(): Promise<
    chrome.types.ChromeSettingGetResult<chrome.proxy.ProxyConfig>[]
  > {
    return Promise.all(
      (await protectedBrowserContexts()).map((incognito) =>
        chrome.proxy.settings.get({ incognito }),
      ),
    );
  }

  private async verifyExclusions(
    endpoint: ProxyChallenger,
    entries: SiteExclusion[],
  ): Promise<void> {
    if (
      !(await this.readSettings()).every(
        (result) =>
          result.levelOfControl === "controlled_by_this_extension" &&
          matches(result.value, endpoint, entries),
      )
    ) {
      throw new ProxyControlError("configuration_rejected");
    }
  }

  async wasUsedProxyChallenge(challenger: ProxyChallenger): Promise<boolean> {
    const key = endpointKey(challenger);
    if (this.usedEndpoints.has(key)) return true;
    await this.withEndpointStorage(() => this.loadEndpoints()).catch(() => undefined);
    return this.usedEndpoints.has(key);
  }

  private async rememberEndpoint(endpoint: ProxyChallenger): Promise<void> {
    const safe = { host: endpoint.host.toLowerCase(), port: endpoint.port };
    this.usedEndpoints.set(endpointKey(safe), safe);
    await this.withEndpointStorage(async () => {
      await this.loadEndpoints();
      // Session storage survives worker suspension and is cleared with Chrome.
      await chrome.storage.session.set({
        [PROXY_ENDPOINTS_KEY]: [...this.usedEndpoints.values()],
      });
    });
  }

  private async loadEndpoints(): Promise<void> {
    const stored = await chrome.storage.session.get(PROXY_ENDPOINTS_KEY);
    const values: unknown = stored[PROXY_ENDPOINTS_KEY];
    if (!Array.isArray(values)) return;
    for (const value of values as unknown[]) {
      if (!value || typeof value !== "object") continue;
      const item = value as Record<string, unknown>;
      if (
        typeof item.host !== "string" ||
        !item.host ||
        item.host.length > 253 ||
        typeof item.port !== "number" ||
        !Number.isInteger(item.port) ||
        item.port < 1 ||
        item.port > 65535
      )
        continue;
      const endpoint = { host: item.host.toLowerCase(), port: item.port };
      this.usedEndpoints.set(endpointKey(endpoint), endpoint);
    }
  }

  private async withEndpointStorage(operation: () => Promise<void>): Promise<void> {
    const pending = this.endpointStorage.then(operation);
    this.endpointStorage = pending.catch(() => undefined);
    await pending;
  }
}

const PROXY_ENDPOINTS_KEY = "fuzevpnProxyEndpoints";

function endpointKey(endpoint: ProxyChallenger): string {
  return JSON.stringify([endpoint.host.toLowerCase(), endpoint.port]);
}

export function proxyConfig(
  session: ProxyChallenger,
  exclusions: SiteExclusion[] = [],
): chrome.proxy.ProxyConfig {
  return {
    mode: "fixed_servers",
    rules: {
      singleProxy: {
        scheme: "https",
        host: session.host,
        port: session.port,
      },
      bypassList: bypassList(exclusions),
    },
  };
}

function matches(
  value: chrome.proxy.ProxyConfig,
  session: ProxyChallenger,
  exclusions: SiteExclusion[],
): boolean {
  const proxy = value.rules?.singleProxy;
  const expectedBypass = bypassList(exclusions);
  return (
    value.mode === "fixed_servers" &&
    proxy?.scheme === "https" &&
    proxy.host.toLowerCase() === session.host.toLowerCase() &&
    proxy.port === session.port &&
    value.rules?.bypassList?.length === expectedBypass.length &&
    expectedBypass.every((rule) => value.rules?.bypassList?.includes(rule)) &&
    !value.pacScript &&
    !value.rules.proxyForHttp &&
    !value.rules.proxyForHttps &&
    !value.rules.proxyForFtp &&
    !value.rules.fallbackProxy
  );
}

function assertExclusions(entries: SiteExclusion[]): void {
  if (!validateSiteExclusionPolicy({ revision: 0, enabled: true, entries })) {
    throw new ProxyControlError("configuration_rejected");
  }
}

function bypassList(entries: SiteExclusion[]): string[] {
  // Chrome preserves a DNS root dot in host matching. Cover it explicitly, just
  // as the destination-only DNR rules do, without matching neighboring domains.
  return [
    ...PROXY_BYPASS_LIST,
    ...entries.flatMap(({ domain, includeSubdomains }) =>
      includeSubdomains
        ? [domain, `${domain}.`, `*.${domain}`, `*.${domain}.`]
        : [domain, `${domain}.`],
    ),
  ];
}

function matchesChallenger(value: chrome.proxy.ProxyConfig, challenger: ProxyChallenger): boolean {
  const proxy = value.rules?.singleProxy;
  return (
    value.mode === "fixed_servers" &&
    proxy?.scheme === "https" &&
    proxy.host.toLowerCase() === challenger.host.toLowerCase() &&
    proxy.port === challenger.port
  );
}
