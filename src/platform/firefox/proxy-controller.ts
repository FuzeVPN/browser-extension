// SPDX-License-Identifier: MPL-2.0

import type { ProxySession } from "../../core/api/types";
import { API_BASE_URL } from "../../core/shared/config";
import { validateSiteExclusionPolicy, type SiteExclusion } from "../../core/shared/site-exclusions";

export const PROXY_BYPASS_LIST = [`${API_BASE_URL}:443`] as const;
const PAC_PREFIX = "data:application/x-ns-proxy-autoconfig;charset=utf-8,";
const PAC_MARKER = "// FuzeVPN Firefox PAC 1\n// ";

export { ProxyControlError } from "../contracts/proxy";
export type { ProxyControlLevel, ProxyChallenger, ProxyService } from "../contracts/proxy";
import {
  ProxyControlError,
  type ProxyControlLevel,
  type ProxyChallenger,
  type ProxyService,
} from "../contracts/proxy";

export interface FirefoxProxyConfiguration {
  endpoint: ProxyChallenger;
  exclusions: SiteExclusion[];
}

export interface ProxySettingsResult {
  value: browser.proxy.ProxyConfig;
  levelOfControl: ProxyControlLevel;
  incognitoSpecific?: boolean;
}

/** Privacy settings can be inspected in both contexts; Firefox proxy settings are global. */
export async function protectedBrowserContexts(): Promise<boolean[]> {
  return (await browser.extension.isAllowedIncognitoAccess()) ? [false, true] : [false];
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

  private matchesExclusionConfiguration(current: ProxySettingsResult): boolean {
    if (current.levelOfControl === "controllable_by_this_extension") return true;
    if (current.levelOfControl !== "controlled_by_this_extension") return false;
    const configuration = readProxyConfiguration(current.value);
    return !!configuration && matches(current.value, configuration.endpoint, this.exclusions);
  }

  /** Updates only a proxy already owned by FuzeVPN; never creates a session or changes its node. */
  async updateExistingExclusions(previous: SiteExclusion[], next: SiteExclusion[]): Promise<void> {
    assertExclusions(previous);
    assertExclusions(next);
    await this.assertControllable();
    const current = await browser.proxy.settings.get({});
    if (current.levelOfControl !== "controlled_by_this_extension") {
      if (current.levelOfControl === "controllable_by_this_extension") return;
      throw new ProxyControlError(current.levelOfControl);
    }
    const configuration = readProxyConfiguration(current.value);
    if (!configuration) {
      throw new ProxyControlError("configuration_rejected");
    }
    const { endpoint } = configuration;
    // A worker may have stopped after writing the target configuration.
    if (matches(current.value, endpoint, next)) {
      await this.verifyExclusions(endpoint, next);
      return;
    }
    if (!matches(current.value, endpoint, previous)) {
      throw new ProxyControlError("configuration_rejected");
    }
    await browser.proxy.settings.set({
      scope: "regular",
      value: proxyConfig(endpoint, next),
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
    if (!(await browser.extension.isAllowedIncognitoAccess())) {
      throw new ProxyControlError("private_browsing_required");
    }
    if (!(await browser.permissions.contains({ origins: ["<all_urls>"] }))) {
      throw new ProxyControlError("host_permissions_required");
    }
    const level = await this.getControlLevel();
    if (level !== "controllable_by_this_extension" && level !== "controlled_by_this_extension") {
      throw new ProxyControlError(level);
    }
  }

  async apply(session: ProxySession): Promise<void> {
    const value = proxyConfig(session, this.exclusions);
    await this.assertControllable();
    // A request may receive its first 407 after this proxy is cleared. Keep only
    // its endpoint (never credentials) for canceling those late challenges.
    await this.rememberEndpoint(session);
    await browser.proxy.settings.set({
      scope: "regular",
      value,
    });
    if (!(await this.isActiveConfiguration(session))) {
      throw new ProxyControlError("configuration_rejected");
    }
  }

  async clear(): Promise<void> {
    const current = await browser.proxy.settings.get({}).catch(() => null);
    const configuration = current && readProxyConfiguration(current.value);
    if (current?.levelOfControl === "controlled_by_this_extension" && configuration) {
      // Also covers a configuration created before endpoint tracking existed.
      // Failure to persist this cancel-only history must not prevent disconnect.
      await this.rememberEndpoint(configuration.endpoint).catch(() => undefined);
    }
    await browser.proxy.settings.clear({ scope: "regular" });
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

  private async readSettings(): Promise<ProxySettingsResult[]> {
    return [await browser.proxy.settings.get({})];
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
      // Memory-backed session storage survives background suspension, never a browser restart.
      await browser.storage.session.set({
        [PROXY_ENDPOINTS_KEY]: [...this.usedEndpoints.values()],
      });
    });
  }

  private async loadEndpoints(): Promise<void> {
    const stored = await browser.storage.session.get(PROXY_ENDPOINTS_KEY);
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
): browser.proxy.ProxyConfig {
  if (!validEndpoint(session)) throw new ProxyControlError("configuration_rejected");
  assertExclusions(exclusions);
  const configuration = {
    endpoint: { host: session.host.toLowerCase(), port: session.port },
    exclusions: exclusions.map(({ domain, includeSubdomains }) => ({ domain, includeSubdomains })),
  };
  return {
    proxyType: "autoConfig",
    autoConfigUrl: PAC_PREFIX + encodeURIComponent(pacScript(configuration)),
    passthrough: "",
    autoLogin: false,
  };
}

/** Parse only the exact locally generated template, without executing PAC code. */
export function readProxyConfiguration(value: unknown): FirefoxProxyConfiguration | null {
  if (!value || typeof value !== "object") return null;
  const config = value as browser.proxy.ProxyConfig;
  if (
    config.proxyType !== "autoConfig" ||
    typeof config.autoConfigUrl !== "string" ||
    config.autoConfigUrl.length > 300_000 ||
    !config.autoConfigUrl.startsWith(PAC_PREFIX) ||
    config.passthrough !== "" ||
    config.autoLogin !== false
  )
    return null;
  try {
    const script = decodeURIComponent(config.autoConfigUrl.slice(PAC_PREFIX.length));
    if (!script.startsWith(PAC_MARKER)) return null;
    const metadataEnd = script.indexOf("\n", PAC_MARKER.length);
    if (metadataEnd < 0) return null;
    const metadata: unknown = JSON.parse(script.slice(PAC_MARKER.length, metadataEnd));
    if (!metadata || typeof metadata !== "object") return null;
    const candidate = metadata as FirefoxProxyConfiguration;
    if (!validEndpoint(candidate.endpoint)) return null;
    assertExclusions(candidate.exclusions);
    const expected = proxyConfig(candidate.endpoint, candidate.exclusions);
    if (config.autoConfigUrl !== expected.autoConfigUrl) return null;
    return {
      endpoint: { ...candidate.endpoint },
      exclusions: candidate.exclusions.map((entry) => ({ ...entry })),
    };
  } catch {
    return null;
  }
}

/** Inspect Firefox's effective request route instead of merely its configured PAC URL. */
export function requestUsesProxy(proxyInfo: unknown, endpoint: ProxyChallenger): boolean {
  if (!proxyInfo || typeof proxyInfo !== "object") return false;
  const route = proxyInfo as { type?: unknown; host?: unknown; port?: unknown };
  return route.type === "https" && validEndpoint(route) && sameEndpoint(route, endpoint);
}

function pacScript(configuration: FirefoxProxyConfiguration): string {
  // URL/host comparisons avoid PAC functions which trigger local DNS queries.
  // DIRECT is limited to the exact HTTPS control API and the user's excluded destinations.
  const apiHost = new URL(API_BASE_URL).hostname.replaceAll(".", "\\.");
  return (
    `${PAC_MARKER}${JSON.stringify(configuration)}\n` +
    `function FindProxyForURL(url, host) {\n` +
    `  if (/^https:\\/\\/${apiHost}(?::443)?\\//i.test(url)) return "DIRECT";\n` +
    `  host = host.toLowerCase().replace(/\\.$/, "");\n` +
    `  var entries = ${JSON.stringify(configuration.exclusions)};\n` +
    `  for (var i = 0; i < entries.length; i++) {\n` +
    `    var domain = entries[i].domain;\n` +
    `    if (host === domain || (entries[i].includeSubdomains && host.slice(-(domain.length + 1)) === "." + domain)) return "DIRECT";\n` +
    `  }\n` +
    `  return ${JSON.stringify(`HTTPS ${configuration.endpoint.host}:${String(configuration.endpoint.port)}`)};\n` +
    `}\n`
  );
}

function matches(value: unknown, session: ProxyChallenger, exclusions: SiteExclusion[]): boolean {
  const parsed = readProxyConfiguration(value);
  return (
    !!parsed &&
    sameEndpoint(parsed.endpoint, session) &&
    (value as browser.proxy.ProxyConfig).autoConfigUrl ===
      proxyConfig(session, exclusions).autoConfigUrl
  );
}

function assertExclusions(entries: SiteExclusion[]): void {
  if (!validateSiteExclusionPolicy({ revision: 0, enabled: true, entries })) {
    throw new ProxyControlError("configuration_rejected");
  }
}

function validEndpoint(value: unknown): value is ProxyChallenger {
  if (!value || typeof value !== "object") return false;
  const endpoint = value as ProxyChallenger;
  return (
    typeof endpoint.host === "string" &&
    endpoint.host.length <= 253 &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(endpoint.host) &&
    !endpoint.host.includes("..") &&
    Number.isInteger(endpoint.port) &&
    endpoint.port >= 1 &&
    endpoint.port <= 65535
  );
}

function matchesChallenger(value: browser.proxy.ProxyConfig, challenger: ProxyChallenger): boolean {
  const configuration = readProxyConfiguration(value);
  return !!configuration && sameEndpoint(configuration.endpoint, challenger);
}

function sameEndpoint(left: ProxyChallenger, right: ProxyChallenger): boolean {
  return left.host.toLowerCase() === right.host.toLowerCase() && left.port === right.port;
}
