// SPDX-License-Identifier: MPL-2.0

import { API_BASE_URL } from "../../core/shared/config";
import type { SecurityStatus } from "../../core/shared/security";
import { protectedBrowserContexts } from "./proxy-controller";
import {
  MAX_SITE_EXCLUSIONS,
  normalizeSiteExclusion,
  type SiteExclusion,
} from "../../core/shared/site-exclusions";

import { SafetyError, type NetworkSafetyService } from "../contracts/network-safety";
export { SafetyError, type NetworkSafetyService } from "../contracts/network-safety";

// Every resource type is explicit: omitting this field would exclude main_frame.
export const GUARDED_RESOURCE_TYPES: NonNullable<
  chrome.declarativeNetRequest.RuleCondition["resourceTypes"]
> = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other",
];

export const SAFETY_RULE_IDS = {
  baseline: 2000,
  sessionAllow: 2001,
  apiBlock: 2002,
  apiAllow: 2003,
  localNames: 2010,
  localIpv4: 2011,
  localIpv6: 2012,
  mappedIpv4: 2013,
  privateIpv4: 2014,
  sharedIpv4: 2015,
} as const;

export const SAFETY_EXCLUSION_RULE_IDS = Array.from(
  // Intersecting two 100-entry policies can produce up to 198 narrower entries.
  { length: MAX_SITE_EXCLUSIONS * 2 },
  (_, index) => 2100 + index,
);
export const SAFETY_EXCLUSION_GUARD_ID = 2400;
export const SAFETY_EXCLUSION_GUARD_ALLOW_IDS = Array.from(
  { length: MAX_SITE_EXCLUSIONS * 2 },
  (_, index) => 2401 + index,
);
const EXCLUSION_GUARD_IDS = [SAFETY_EXCLUSION_GUARD_ID, ...SAFETY_EXCLUSION_GUARD_ALLOW_IDS];
const FILTER_IDS = Object.values(SAFETY_RULE_IDS).filter(
  (id) => id !== SAFETY_RULE_IDS.sessionAllow && id !== SAFETY_RULE_IDS.baseline,
);
const DYNAMIC_IDS = [
  SAFETY_RULE_IDS.baseline,
  ...FILTER_IDS,
  ...SAFETY_EXCLUSION_RULE_IDS,
  ...EXCLUSION_GUARD_IDS,
];
const ALL_OWNED_IDS = [...DYNAMIC_IDS, SAFETY_RULE_IDS.sessionAllow];
const BASELINE_PRIORITY = 10;
const EXCLUSION_PRIORITY = 15;
const EXCLUSION_GUARD_PRIORITY = 17;
const EXCLUSION_GUARD_ALLOW_PRIORITY = 18;
const SESSION_PRIORITY = 20;
const FILTER_PRIORITY = 30;
const API_PRIORITY = 40;
const WEBRTC_POLICY = "disable_non_proxied_udp";

const AUTHORITY_START = "^(?:https?|wss?)://(?:[^/?#@]*@)?";
const HOST_END = "(?::[0-9]+)?(?:/|$)";
// Chrome normalizes numeric IPv4 (including integer/octal/hex input) to dotted decimal.
// Keep ranges in small RE2 expressions: Chrome limits each compiled regex to 2KB.
// IPv4-mapped/compatible IPv6 is canonicalized into hexadecimal hextets by Chrome.
// These prefixes represent 0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 100.64/10.
const IPV4_LOCAL_HEXTET =
  "(?:[0-9a-f]{1,2}|a[0-9a-f]{2}|7f[0-9a-f]{2}|a9fe|ac1[0-9a-f]|c0a8|64[4-7][0-9a-f])";

function condition(regexFilter?: string): chrome.declarativeNetRequest.RuleCondition {
  return {
    resourceTypes: [...GUARDED_RESOURCE_TYPES],
    ...(regexFilter ? { regexFilter } : {}),
  };
}

function baselineRule(): chrome.declarativeNetRequest.Rule {
  return {
    id: SAFETY_RULE_IDS.baseline,
    priority: BASELINE_PRIORITY,
    action: { type: "block" },
    condition: condition(),
  };
}

function sessionRule(): chrome.declarativeNetRequest.Rule {
  return {
    id: SAFETY_RULE_IDS.sessionAllow,
    priority: SESSION_PRIORITY,
    action: { type: "allow" },
    condition: condition(),
  };
}

/** Destination-only allowances never exempt a page's requests to other hosts. */
export function siteExclusionRules(entries: SiteExclusion[]): chrome.declarativeNetRequest.Rule[] {
  if (entries.length > SAFETY_EXCLUSION_RULE_IDS.length) {
    throw new SafetyError("traffic_guard_failed");
  }
  return entries.map((entry, index) => {
    const host = entry.domain.replaceAll(".", "\\.");
    const subdomains = entry.includeSubdomains ? "(?:[^.:/?#@\\[\\]]+\\.)*" : "";
    return {
      id: 2100 + index,
      priority: EXCLUSION_PRIORITY,
      action: { type: "allow" },
      condition: condition(`${AUTHORITY_START}${subdomains}${host}\\.?${HOST_END}`),
    };
  });
}

function exclusionGuardRules(entries: SiteExclusion[] | null): chrome.declarativeNetRequest.Rule[] {
  if (entries === null) return [];
  return [
    {
      id: SAFETY_EXCLUSION_GUARD_ID,
      priority: EXCLUSION_GUARD_PRIORITY,
      action: { type: "block" },
      condition: condition(),
    },
    ...siteExclusionRules(entries).map((rule, index) => ({
      ...rule,
      id: 2401 + index,
      priority: EXCLUSION_GUARD_ALLOW_PRIORITY,
    })),
  ];
}

function copyExclusions(entries: SiteExclusion[]): SiteExclusion[] {
  try {
    if (!Array.isArray(entries) || entries.length > SAFETY_EXCLUSION_RULE_IDS.length) {
      throw new SafetyError("traffic_guard_failed");
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      const normalized = normalizeSiteExclusion(entry.domain, entry.includeSubdomains);
      if (normalized.domain !== entry.domain || seen.has(entry.domain)) {
        throw new SafetyError("traffic_guard_failed");
      }
      seen.add(entry.domain);
    }
    return entries.map((entry) => ({ ...entry }));
  } catch {
    throw new SafetyError("traffic_guard_failed");
  }
}

export function safetyFilterRules(extensionId: string): chrome.declarativeNetRequest.Rule[] {
  const apiHost = new URL(API_BASE_URL).hostname.replaceAll(".", "\\.");
  const apiOrigin = `^https://${apiHost}(?::443)?/`;
  const apiPageOrigin = `^https://(?:[^/?#@]*@)?${apiHost}\\.?(?::443)?/`;
  const filters = [
    {
      id: SAFETY_RULE_IDS.localNames,
      regex:
        `${AUTHORITY_START}(?:[^.:/?#@\\[\\]]+\\.?|` +
        `(?:[^.:/?#@\\[\\]]+\\.)*(?:localhost|local)\\.?)${HOST_END}`,
    },
    {
      id: SAFETY_RULE_IDS.localIpv4,
      regex: `${AUTHORITY_START}(?:0|10|127|169\\.254|192\\.168)\\.[0-9.]+${HOST_END}`,
    },
    {
      id: SAFETY_RULE_IDS.privateIpv4,
      regex: `${AUTHORITY_START}172\\.(?:1[6-9]|2[0-9]|3[01])\\.[0-9.]+${HOST_END}`,
    },
    {
      id: SAFETY_RULE_IDS.sharedIpv4,
      regex: `${AUTHORITY_START}100\\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.[0-9.]+${HOST_END}`,
    },
    {
      id: SAFETY_RULE_IDS.localIpv6,
      regex:
        `${AUTHORITY_START}\\[(?:::|::1|f[cd][0-9a-f]{2}:[0-9a-f:]*|` +
        `fe[89ab][0-9a-f]:[0-9a-f:]*)\\]${HOST_END}`,
    },
    {
      id: SAFETY_RULE_IDS.mappedIpv4,
      regex: `${AUTHORITY_START}\\[::(?:ffff:)?${IPV4_LOCAL_HEXTET}:[0-9a-f]{1,4}\\]${HOST_END}`,
    },
  ];
  return [
    ...filters.map(({ id, regex }): chrome.declarativeNetRequest.Rule => ({
      id,
      priority: FILTER_PRIORITY,
      action: { type: "block" },
      condition: condition(regex),
    })),
    {
      id: SAFETY_RULE_IDS.apiBlock,
      priority: FILTER_PRIORITY,
      action: { type: "block" },
      condition: condition(apiPageOrigin),
    },
    {
      id: SAFETY_RULE_IDS.apiAllow,
      priority: API_PRIORITY,
      action: { type: "allow" },
      condition: {
        ...condition(apiOrigin),
        initiatorDomains: [extensionId],
        // API calls are fetches. In particular, an extension-opened navigation is not exempt.
        // Web authentication must follow an explicit controller disconnect: its web view
        // has no documented tab handle to safely scope a temporary navigation allowance.
        resourceTypes: ["xmlhttprequest"],
      },
    },
  ];
}

/** Calls are serialized by the controller with proxy and storage mutations. */
export class PlatformNetworkSafetyService implements NetworkSafetyService {
  private exclusions: SiteExclusion[] = [];
  private exclusionGuard: SiteExclusion[] | null = null;

  async validateExclusions(entries: SiteExclusion[]): Promise<void> {
    const rules = siteExclusionRules(copyExclusions(entries));
    const supported = await Promise.all(
      rules.map((rule) => {
        const regex = rule.condition.regexFilter;
        if (!regex) throw new Error("invalid_site_exclusions");
        return chrome.declarativeNetRequest.isRegexSupported({
          regex,
          isCaseSensitive: false,
        });
      }),
    );
    if (supported.some((result) => !result.isSupported)) {
      throw new Error("invalid_site_exclusions");
    }
  }

  configureExclusions(entries: SiteExclusion[]): void {
    // The policy store supplies normalized entries. Clone so subsequent caller mutation
    // cannot change what this service considers an authorized persistent rule.
    this.exclusions = copyExclusions(entries);
  }

  async setExclusionGuard(entries: SiteExclusion[] | null): Promise<void> {
    this.exclusionGuard = entries === null ? null : copyExclusions(entries);
    try {
      await this.removeSessionAllowance();
      const rules = exclusionGuardRules(this.exclusionGuard);
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [...EXCLUSION_GUARD_IDS],
        addRules: rules,
      });
      const [dynamic, session] = await Promise.all([
        chrome.declarativeNetRequest.getDynamicRules(),
        chrome.declarativeNetRequest.getSessionRules(),
      ]);
      if (
        !sameOwnedRules(dynamic, rules, EXCLUSION_GUARD_IDS) ||
        session.some((rule) => ALL_OWNED_IDS.includes(rule.id))
      ) {
        throw new SafetyError("traffic_guard_failed");
      }
      if (entries !== null) {
        const apiAllow = safetyFilterRules(chrome.runtime.id).find(
          (rule) => rule.id === SAFETY_RULE_IDS.apiAllow,
        );
        const expectedAllows = new Map(
          rules.filter((rule) => rule.action.type === "allow").map((rule) => [rule.id, rule]),
        );
        if (apiAllow) expectedAllows.set(apiAllow.id, apiAllow);
        if (
          dynamic.some((rule) => {
            if (!isAllowance(rule) || (rule.priority ?? 1) < EXCLUSION_GUARD_PRIORITY) return false;
            const expected = expectedAllows.get(rule.id);
            return !expected || !sameRule(rule, expected);
          }) ||
          session.some(
            (rule) => isAllowance(rule) && (rule.priority ?? 1) >= EXCLUSION_GUARD_PRIORITY,
          )
        ) {
          throw new SafetyError("traffic_guard_failed");
        }
      }
    } catch {
      throw new SafetyError("traffic_guard_failed");
    }
  }

  async suspend(): Promise<void> {
    try {
      await this.removeSessionAllowance();
    } catch {
      throw new SafetyError("traffic_guard_failed");
    }
  }

  async block(killSwitchEnabled: boolean): Promise<void> {
    try {
      await this.removeSessionAllowance();
      const rules = [
        ...safetyFilterRules(chrome.runtime.id),
        ...siteExclusionRules(this.exclusions),
        ...exclusionGuardRules(this.exclusionGuard),
      ];
      if (killSwitchEnabled) rules.push(baselineRule());
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [...ALL_OWNED_IDS],
        addRules: rules,
      });
      const dynamic = await chrome.declarativeNetRequest.getDynamicRules();
      if (!sameOwnedRules(dynamic, rules, ALL_OWNED_IDS))
        throw new SafetyError("traffic_guard_failed");
      const status = await this.inspect();
      if (
        !status.filterActive ||
        status.blockingScope === "unverified" ||
        status.trafficBlocked !== (killSwitchEnabled || this.exclusionGuard !== null)
      ) {
        throw new SafetyError("traffic_guard_failed");
      }
    } catch {
      throw new SafetyError("traffic_guard_failed");
    }
  }

  async allow(): Promise<void> {
    try {
      if (this.exclusionGuard !== null) throw new SafetyError("traffic_guard_failed");
      if (!(await this.inspect()).filterActive) throw new SafetyError("traffic_guard_failed");
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [SAFETY_RULE_IDS.sessionAllow],
        addRules: [sessionRule()],
      });
      const session = await chrome.declarativeNetRequest.getSessionRules();
      const status = await this.inspect();
      if (
        !sameOwnedRules(session, [sessionRule()], [SAFETY_RULE_IDS.sessionAllow]) ||
        !status.filterActive ||
        status.blockingScope !== "none" ||
        status.trafficBlocked
      ) {
        throw new SafetyError("traffic_guard_failed");
      }
    } catch {
      // Never leave a newly installed allow rule behind when verification failed.
      await this.removeSessionAllowance().catch(() => undefined);
      throw new SafetyError("traffic_guard_failed");
    }
  }

  async release(): Promise<void> {
    try {
      await this.removeSessionAllowance();
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [...ALL_OWNED_IDS] });
      const dynamic = await chrome.declarativeNetRequest.getDynamicRules();
      if (!sameOwnedRules(dynamic, [], ALL_OWNED_IDS))
        throw new SafetyError("traffic_guard_failed");
      this.exclusionGuard = null;
    } catch {
      throw new SafetyError("traffic_guard_failed");
    }
  }

  async setWebRtc(enabled: boolean): Promise<void> {
    try {
      const setting = chrome.privacy.network.webRTCIPHandlingPolicy;
      if (enabled) {
        const before = await Promise.all(
          (await protectedBrowserContexts()).map((incognito) => setting.get({ incognito })),
        );
        if (
          before.some(
            (result) =>
              result.levelOfControl !== "controllable_by_this_extension" &&
              result.levelOfControl !== "controlled_by_this_extension",
          )
        ) {
          throw new SafetyError("webrtc_control_unavailable");
        }
        await setting.set({ scope: "regular", value: WEBRTC_POLICY });
      } else {
        await setting.clear({ scope: "regular" });
      }
      const after = await Promise.all(
        (await protectedBrowserContexts()).map((incognito) => setting.get({ incognito })),
      );
      if (
        after.some((result) =>
          enabled
            ? result.levelOfControl !== "controlled_by_this_extension" ||
              result.value !== WEBRTC_POLICY
            : result.levelOfControl === "controlled_by_this_extension",
        )
      ) {
        throw new SafetyError("webrtc_control_unavailable");
      }
    } catch {
      throw new SafetyError("webrtc_control_unavailable");
    }
  }

  async inspect(): Promise<SecurityStatus> {
    const status: SecurityStatus = {
      trafficBlocked: false,
      webRtcProtected: false,
      filterActive: false,
      blockingScope: "unverified",
    };
    await Promise.all([
      (async () => {
        try {
          const [dynamic, session] = await Promise.all([
            chrome.declarativeNetRequest.getDynamicRules(),
            chrome.declarativeNetRequest.getSessionRules(),
          ]);
          const filters = safetyFilterRules(chrome.runtime.id);
          const exclusions = siteExclusionRules(this.exclusions);
          const guard = exclusionGuardRules(this.exclusionGuard);
          const apiAllow = filters.find((rule) => rule.id === SAFETY_RULE_IDS.apiAllow);
          const expectedAllows = new Map(
            [...exclusions, ...guard]
              .filter((rule) => rule.action.type === "allow")
              .map((rule) => [rule.id, rule]),
          );
          if (apiAllow) expectedAllows.set(apiAllow.id, apiAllow);
          const unexpectedAllow =
            dynamic.some((rule) => {
              if (!isAllowance(rule)) return false;
              const expected = expectedAllows.get(rule.id);
              return !expected || !sameRule(rule, expected);
            }) || session.some((rule) => isAllowance(rule) && !sameRule(rule, sessionRule()));
          const exclusionRulesVerified =
            sameOwnedRules(dynamic, exclusions, SAFETY_EXCLUSION_RULE_IDS) &&
            sameOwnedRules(dynamic, guard, EXCLUSION_GUARD_IDS) &&
            !dynamic.some((rule) => rule.id === SAFETY_RULE_IDS.sessionAllow) &&
            !session.some((rule) => DYNAMIC_IDS.includes(rule.id));
          const baseline = dynamic.find((rule) => rule.id === SAFETY_RULE_IDS.baseline);
          const malformedBaseline = baseline !== undefined && !sameRule(baseline, baselineRule());
          const sessionAllowance = session.find((rule) => rule.id === SAFETY_RULE_IDS.sessionAllow);
          const malformedSession =
            sessionAllowance !== undefined &&
            (this.exclusionGuard !== null || !sameRule(sessionAllowance, sessionRule()));
          const hasOwnedRules = [...dynamic, ...session].some(
            (rule) => DYNAMIC_IDS.includes(rule.id) || rule.id === SAFETY_RULE_IDS.sessionAllow,
          );
          status.filterActive =
            sameOwnedRules(dynamic, filters, FILTER_IDS) &&
            exclusionRulesVerified &&
            !unexpectedAllow &&
            !malformedBaseline &&
            !malformedSession;
          if (!hasOwnedRules && !unexpectedAllow) {
            status.blockingScope = "none";
          } else if (status.filterActive) {
            if (this.exclusionGuard !== null) {
              status.blockingScope = this.exclusionGuard.length > 0 ? "except_excluded" : "all";
            } else {
              status.blockingScope =
                baseline && !sessionAllowance
                  ? exclusions.length > 0
                    ? "except_excluded"
                    : "all"
                  : "none";
            }
          }
          status.trafficBlocked =
            status.blockingScope === "all" || status.blockingScope === "except_excluded";
        } catch {
          // A failed read is unknown, never a verified protection claim.
        }
      })(),
      (async () => {
        try {
          const settings = await Promise.all(
            (await protectedBrowserContexts()).map((incognito) =>
              chrome.privacy.network.webRTCIPHandlingPolicy.get({ incognito }),
            ),
          );
          status.webRtcProtected = settings.every(
            (setting) =>
              setting.levelOfControl === "controlled_by_this_extension" &&
              setting.value === WEBRTC_POLICY,
          );
        } catch {
          // The traffic guard remains independently inspectable without the privacy API.
        }
      })(),
    ]);
    return status;
  }

  private async removeSessionAllowance(): Promise<void> {
    await chrome.declarativeNetRequest.updateSessionRules({
      // Also remove owned rules found in the wrong store: none of the persistent
      // guard or exclusion rules may survive as a browser-session allowance.
      removeRuleIds: [...ALL_OWNED_IDS],
    });
    const session = await chrome.declarativeNetRequest.getSessionRules();
    if (session.some((rule) => ALL_OWNED_IDS.includes(rule.id))) {
      throw new SafetyError("traffic_guard_failed");
    }
  }
}

function sameOwnedRules(
  actual: chrome.declarativeNetRequest.Rule[],
  expected: chrome.declarativeNetRequest.Rule[],
  ownedIds: readonly number[],
): boolean {
  const owned = actual.filter((rule) => ownedIds.includes(rule.id));
  const ownedById = new Map(owned.map((rule) => [rule.id, rule]));
  return (
    owned.length === expected.length &&
    ownedById.size === owned.length &&
    expected.every((rule) => {
      const item = ownedById.get(rule.id);
      return item !== undefined && sameRule(item, rule);
    })
  );
}

function isAllowance(rule: chrome.declarativeNetRequest.Rule): boolean {
  return rule.action.type === "allow" || rule.action.type === "allowAllRequests";
}

function sameRule(
  a: chrome.declarativeNetRequest.Rule,
  b: chrome.declarativeNetRequest.Rule,
): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
