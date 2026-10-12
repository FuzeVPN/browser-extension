// SPDX-License-Identifier: MPL-2.0

import {
  PlatformNetworkSafetyService,
  GUARDED_RESOURCE_TYPES,
  SAFETY_EXCLUSION_RULE_IDS,
  SAFETY_EXCLUSION_GUARD_ID,
  SAFETY_EXCLUSION_GUARD_ALLOW_IDS,
  SAFETY_RULE_IDS,
  SafetyError,
} from "../../../src/core/background/network-safety";

type Rule = browser.declarativeNetRequest.Rule;
type RequestType = NonNullable<
  browser.declarativeNetRequest.Rule["condition"]["resourceTypes"]
>[number];
const EXTENSION_ID = "bca3eea0-32d4-497c-bd3b-4ae589202204";

class FakeFirefoxSafety {
  dynamic: Rule[] = [];
  session: Rule[] = [];
  events: string[] = [];
  privacy = { value: "default", levelOfControl: "controllable_by_this_extension" };
  underlyingPrivacy = {
    value: "default_public_interface_only",
    levelOfControl: "controllable_by_this_extension",
  };
  prediction = { value: true, levelOfControl: "controllable_by_this_extension" };
  underlyingPrediction = { value: true, levelOfControl: "controllable_by_this_extension" };
  ignorePredictionSet = false;
  ignorePredictionClear = false;
  firefoxNullReadback = false;
  rejectDynamic = false;
  ignoreDynamic = false;
  rejectSession = false;
  ignoreSession = false;
  rejectRead = false;
  rejectPrivacyRead = false;
  ignorePrivacySet = false;
  ignorePrivacyClear = false;
  mutateSessionRead: (() => void) | null = null;

  install(): void {
    vi.stubGlobal("browser", {
      extension: { isAllowedIncognitoAccess: async () => false },
      runtime: {
        id: "fuzevpn-firefox@vpn1euro.com",
        getURL: () => `moz-extension://${EXTENSION_ID}/`,
      },
      declarativeNetRequest: {
        getDynamicRules: async () => {
          if (this.rejectRead) throw new Error("read unavailable");
          return this.readRules(this.dynamic);
        },
        getSessionRules: async () => {
          if (this.rejectRead) throw new Error("read unavailable");
          this.mutateSessionRead?.();
          return this.readRules(this.session);
        },
        updateDynamicRules: async (
          update: Parameters<typeof browser.declarativeNetRequest.updateDynamicRules>[0],
        ) => {
          this.events.push("dynamic");
          if (this.rejectDynamic) throw new Error("rule capacity exhausted");
          if (!this.ignoreDynamic) this.dynamic = applyUpdate(this.dynamic, update);
        },
        updateSessionRules: async (
          update: Parameters<typeof browser.declarativeNetRequest.updateDynamicRules>[0],
        ) => {
          this.events.push(update.addRules?.length ? "session-allow" : "session-remove");
          if (this.rejectSession) throw new Error("session rules unavailable");
          if (!this.ignoreSession) this.session = applyUpdate(this.session, update);
        },
      },
      privacy: {
        network: {
          networkPredictionEnabled: {
            get: async (query: Record<string, unknown>) => {
              expect(query).toEqual({});
              return { ...this.prediction };
            },
            set: async ({ value }: { value: boolean }) => {
              if (!this.ignorePredictionSet)
                this.prediction = { value, levelOfControl: "controlled_by_this_extension" };
            },
            clear: async () => {
              if (!this.ignorePredictionClear) this.prediction = { ...this.underlyingPrediction };
            },
          },
          webRTCIPHandlingPolicy: {
            get: async () => {
              if (this.rejectPrivacyRead) throw new Error("privacy unavailable");
              return { ...this.privacy };
            },
            set: async ({ value, scope }: { value: string; scope: string }) => {
              expect(scope).toBe("regular");
              if (!this.ignorePrivacySet)
                this.privacy = { value, levelOfControl: "controlled_by_this_extension" };
            },
            clear: async ({ scope }: { scope: string }) => {
              expect(scope).toBe("regular");
              if (!this.ignorePrivacyClear) this.privacy = { ...this.underlyingPrivacy };
            },
          },
        },
      },
    });
  }

  private readRules(rules: Rule[]): Rule[] {
    return structuredClone(rules).map((rule) =>
      this.firefoxNullReadback
        ? ({
            ...rule,
            action: { redirect: null, requestHeaders: null, responseHeaders: null, ...rule.action },
            condition: {
              domainType: null,
              excludedInitiatorDomains: null,
              excludedRequestDomains: null,
              excludedRequestMethods: null,
              excludedResourceTypes: null,
              excludedTabIds: null,
              initiatorDomains: null,
              isUrlFilterCaseSensitive: null,
              regexFilter: null,
              requestDomains: null,
              requestMethods: null,
              resourceTypes: null,
              tabIds: null,
              urlFilter: null,
              ...rule.condition,
            },
          } as unknown as Rule)
        : rule,
    );
  }

  decision(input: string, type: RequestType = "main_frame", initiator?: string): string {
    const url = new URL(input).href;
    const rules = [...this.dynamic, ...this.session].filter(({ condition }) => {
      if (condition.resourceTypes && !condition.resourceTypes.includes(type)) return false;
      if (condition.regexFilter && !new RegExp(condition.regexFilter, "i").test(url)) return false;
      if (condition.initiatorDomains && !condition.initiatorDomains.includes(initiator ?? ""))
        return false;
      return true;
    });
    rules.sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1));
    return rules[0]?.action.type ?? "unmatched";
  }
}

function applyUpdate(
  rules: Rule[],
  update: Parameters<typeof browser.declarativeNetRequest.updateDynamicRules>[0],
): Rule[] {
  return [
    ...rules.filter((rule) => !update.removeRuleIds?.includes(rule.id)),
    ...structuredClone(update.addRules ?? []),
  ];
}

describe("persistent Firefox traffic guard", () => {
  let fake: FakeFirefoxSafety;
  let safety: PlatformNetworkSafetyService;

  beforeEach(() => {
    fake = new FakeFirefoxSafety();
    fake.install();
    safety = new PlatformNetworkSafetyService();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("accepts Firefox's null optional schema fields throughout the DNR lifecycle", async () => {
    fake.firefoxNullReadback = true;
    safety.configureExclusions([{ domain: "example.com", includeSubdomains: true }]);
    await safety.block(true);
    await expect(safety.inspect()).resolves.toMatchObject({
      filterActive: true,
      blockingScope: "except_excluded",
    });
    await safety.allow();
    await expect(safety.inspect()).resolves.toMatchObject({
      filterActive: true,
      blockingScope: "none",
    });
    await safety.setExclusionGuard([{ domain: "shop.example.com", includeSubdomains: false }]);
    await safety.block(true);
    await expect(safety.inspect()).resolves.toMatchObject({
      filterActive: true,
      blockingScope: "except_excluded",
    });
    await safety.setExclusionGuard(null);
    await safety.allow();
    await safety.release();
    await expect(safety.inspect()).resolves.toMatchObject({
      filterActive: false,
      blockingScope: "none",
    });
  });

  it.each([
    "initiator-null",
    "resources-null",
    "case-sensitive",
    "headers",
    "unknown-null",
    "type-null",
  ])("preserves policy differences while normalizing null optionals: %s", async (change) => {
    fake.firefoxNullReadback = true;
    await safety.block(true);
    const apiAllow = fake.dynamic.find((rule) => rule.id === SAFETY_RULE_IDS.apiAllow)!;
    if (change === "initiator-null") Object.assign(apiAllow.condition, { initiatorDomains: null });
    if (change === "resources-null") Object.assign(apiAllow.condition, { resourceTypes: null });
    if (change === "case-sensitive") apiAllow.condition.isUrlFilterCaseSensitive = true;
    if (change === "headers") Object.assign(apiAllow.action, { requestHeaders: [] });
    if (change === "unknown-null") Object.assign(apiAllow.condition, { futurePolicyField: null });
    if (change === "type-null") Object.assign(apiAllow.action, { type: null });
    await expect(safety.inspect()).resolves.toMatchObject({
      filterActive: false,
      blockingScope: "unverified",
    });
    await expect(safety.allow()).rejects.toThrow("traffic_guard_failed");
    expect(fake.session).toEqual([]);
  });

  it("checks Firefox regex compilation without mutating any installed rule", async () => {
    const isRegexSupported = vi.fn(
      async (query: Parameters<typeof browser.declarativeNetRequest.isRegexSupported>[0]) => ({
        isSupported: query.regex.length < 300,
        reason: "memoryLimitExceeded",
      }),
    );
    Object.assign(browser.declarativeNetRequest, { isRegexSupported });
    const domain = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`;
    await expect(safety.validateExclusions([{ domain, includeSubdomains: true }])).rejects.toThrow(
      "invalid_site_exclusions",
    );
    expect(isRegexSupported).toHaveBeenCalledOnce();
    expect(isRegexSupported.mock.calls[0]?.[0].isCaseSensitive).toBe(false);
    expect(isRegexSupported.mock.calls[0]?.[0].regex.length).toBeGreaterThan(domain.length);
    expect(fake.events).toEqual([]);
    expect(fake.dynamic).toEqual([]);
    expect(fake.session).toEqual([]);
  });

  it("blocks every explicit request type including navigation, WebSocket, speculative connections and JSON", async () => {
    await safety.block(true);
    for (const type of GUARDED_RESOURCE_TYPES) {
      expect(fake.decision("https://example.com/", type), type).toBe("block");
    }
    expect(fake.decision("wss://example.com/socket", "websocket")).toBe("block");
    await expect(safety.inspect()).resolves.toEqual({
      trafficBlocked: true,
      filterActive: true,
      webRtcProtected: false,
      blockingScope: "all",
    });
  });

  it("allows valid navigation only for this browser session and reblocks before any dynamic mutation", async () => {
    await safety.block(true);
    await safety.allow();
    expect(fake.decision("https://example.com/")).toBe("allow");
    expect(fake.dynamic.some((rule) => rule.id === SAFETY_RULE_IDS.baseline)).toBe(true);
    fake.events = [];
    await safety.block(true);
    expect(fake.events).toEqual(["session-remove", "dynamic"]);
    expect(fake.decision("https://example.com/")).toBe("block");
  });

  it("retains the blocking baseline across a full browser restart", async () => {
    await safety.block(true);
    await safety.allow();
    fake.session = [];
    const restarted = new PlatformNetworkSafetyService();
    await expect(restarted.inspect()).resolves.toMatchObject({
      trafficBlocked: true,
      filterActive: true,
    });
    expect(fake.decision("https://example.com/")).toBe("block");
  });

  it("suspends the surviving browser-session allowance before worker restoration reads", async () => {
    await safety.block(true);
    await safety.allow();
    const originalDynamic = structuredClone(fake.dynamic);
    await new PlatformNetworkSafetyService().suspend();
    expect(fake.dynamic).toEqual(originalDynamic);
    expect(fake.decision("https://example.com/")).toBe("block");
  });

  it("does not newly arm an unprotected installation when suspending startup", async () => {
    await safety.suspend();
    expect(fake.dynamic).toEqual([]);
    expect(fake.session).toEqual([]);
    await expect(safety.inspect()).resolves.toMatchObject({ trafficBlocked: false });
  });

  it("reports a failed startup suspension without claiming blocking", async () => {
    await safety.block(true);
    await safety.allow();
    fake.rejectSession = true;
    await expect(safety.suspend()).rejects.toEqual(new SafetyError("traffic_guard_failed"));
    await expect(safety.inspect()).resolves.toMatchObject({ trafficBlocked: false });
  });

  it("keeps IPv4/IPv6 and API page filters when the kill switch is disabled", async () => {
    await safety.block(true);
    await safety.allow();
    await safety.block(false);
    expect(fake.decision("https://example.com/")).toBe("unmatched");
    expect(fake.decision("https://192.168.1.1/")).toBe("block");
    expect(fake.decision("https://api.fuzevpn.com/")).toBe("block");
    await expect(safety.inspect()).resolves.toMatchObject({
      trafficBlocked: false,
      filterActive: true,
    });
  });

  it.each([
    "http://router/",
    "http://router./",
    "https://localhost/",
    "http://foo.localhost./",
    "http://printer.local/",
    "http://foo.bar.local./",
    "http://user:pass@localhost:8080/",
    "http://127.0.0.1/",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://%31%32%37.0.0.1/",
    "http://0/",
    "http://0.1.2.3/",
    "https://10.255.255.255/",
    "https://172.16.0.1/",
    "https://172.31.255.255/",
    "https://192.168.1.1/",
    "https://169.254.169.254/",
    "https://100.64.0.1/",
    "https://100.127.255.255/",
    "https://[::]/",
    "https://[::1]/",
    "https://[0:0:0:0:0:0:0:1]/",
    "https://[fc00::1]/",
    "https://[fdff:ffff::1]/",
    "https://[fe80::1]/",
    "https://[febf::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://[0:0:0:0:0:ffff:7f00:1]/",
    "https://[::ffff:10.1.2.3]/",
    "https://[::ffff:172.16.0.1]/",
    "https://[::ffff:172.31.0.1]/",
    "https://[::ffff:192.168.1.1]/",
    "https://[::ffff:169.254.1.1]/",
    "https://[::ffff:0.1.2.3]/",
    "https://[::ffff:100.64.0.1]/",
    "https://[::127.0.0.1]/",
    "https://[::192.168.0.1]/",
    "ws://127.0.0.1:9090/",
    "wss://[fe80::1]/",
  ])(
    "blocks local URL after canonicalization while ordinary navigation is authorized: %s",
    async (url) => {
      await safety.block(true);
      await safety.allow();
      expect(fake.decision(url)).toBe("block");
      expect(fake.decision(url, "xmlhttprequest", EXTENSION_ID)).toBe("block");
    },
  );

  it.each([
    "https://example.com/",
    "https://localhost.example.com/",
    "https://local.example.com/",
    "https://172.15.255.255/",
    "https://172.32.0.1/",
    "https://100.63.255.255/",
    "https://100.128.0.1/",
    "https://169.253.1.1/",
    "https://192.169.1.1/",
    "https://[2001:db8::1]/",
    "https://[2606:4700:4700::1111]/",
    "https://[::ffff:8.8.8.8]/",
    "https://example.com/?url=http://localhost/",
    "https://api.fuzevpn.com.evil.example/",
  ])("allows public targets and avoids partial-host false positives: %s", async (url) => {
    await safety.block(true);
    await safety.allow();
    expect(fake.decision(url)).toBe("allow");
  });

  it("reserves the exact HTTPS API exception for extension-internal fetches", async () => {
    await safety.block(true);
    for (const url of ["https://api.fuzevpn.com/login", "https://api.fuzevpn.com:443/login"]) {
      expect(fake.decision(url, "xmlhttprequest", EXTENSION_ID)).toBe("allow");
      expect(fake.decision(url, "xmlhttprequest", "example.com")).toBe("block");
      expect(fake.decision(url, "main_frame", EXTENSION_ID)).toBe("block");
      expect(fake.decision(url, "websocket", EXTENSION_ID)).toBe("block");
    }
    for (const url of [
      "http://api.fuzevpn.com/",
      "https://api.fuzevpn.com:444/",
      "https://sub.api.fuzevpn.com/",
      "https://api.fuzevpn.com.evil.example/",
      "https://api.fuzevpn.com./",
    ]) {
      expect(fake.decision(url, "xmlhttprequest", EXTENSION_ID)).toBe("block");
    }
    await safety.allow();
    expect(fake.decision("https://user:pass@api.fuzevpn.com/")).toBe("block");
    expect(fake.decision("https://api.fuzevpn.com./")).toBe("block");
  });

  it("releases only owned rules and leaves WebRTC management independent", async () => {
    const unrelated: Rule = {
      id: 999,
      priority: 1,
      action: { type: "block" },
      condition: { urlFilter: "unrelated" },
    };
    fake.dynamic.push(unrelated);
    fake.session.push({ ...unrelated, id: 998 });
    await safety.block(true);
    await safety.allow();
    await safety.setWebRtc(true);
    await safety.release();
    expect(fake.dynamic).toEqual([unrelated]);
    expect(fake.session).toEqual([{ ...unrelated, id: 998 }]);
    await expect(safety.inspect()).resolves.toEqual({
      trafficBlocked: false,
      filterActive: false,
      webRtcProtected: true,
      blockingScope: "none",
    });
  });

  it("never authorizes navigation before the local and API filters are verified", async () => {
    await expect(safety.allow()).rejects.toEqual(new SafetyError("traffic_guard_failed"));
    expect(fake.session).toEqual([]);
  });

  it("removes the session exception even if updating persistent rules fails", async () => {
    await safety.block(true);
    await safety.allow();
    fake.rejectDynamic = true;
    await expect(safety.block(true)).rejects.toEqual(new SafetyError("traffic_guard_failed"));
    expect(fake.decision("https://example.com/")).toBe("block");
  });

  it("rejects silently ignored dynamic writes without claiming protection", async () => {
    fake.ignoreDynamic = true;
    await expect(safety.block(true)).rejects.toEqual(new SafetyError("traffic_guard_failed"));
    await expect(safety.inspect()).resolves.toMatchObject({
      trafficBlocked: false,
      filterActive: false,
    });
  });

  it("rejects a failed removal before mutating the baseline", async () => {
    await safety.block(true);
    await safety.allow();
    fake.ignoreSession = true;
    fake.events = [];
    await expect(safety.block(false)).rejects.toEqual(new SafetyError("traffic_guard_failed"));
    expect(fake.events).toEqual(["session-remove"]);
    await expect(safety.inspect()).resolves.toMatchObject({
      trafficBlocked: false,
      filterActive: true,
    });
  });

  it("rolls back a session allow when read-back detects altered content", async () => {
    await safety.block(true);
    fake.mutateSessionRead = () => {
      const allow = fake.session.find((rule) => rule.id === SAFETY_RULE_IDS.sessionAllow);
      if (allow) allow.condition = { resourceTypes: ["main_frame"] };
    };
    await expect(safety.allow()).rejects.toEqual(new SafetyError("traffic_guard_failed"));
    expect(fake.session).toEqual([]);
    expect(fake.decision("https://example.com/")).toBe("block");
  });

  it("does not report blocking when another owned-extension allow could override it", async () => {
    await safety.block(true);
    fake.session.push({ id: 3000, priority: 99, action: { type: "allow" }, condition: {} });
    await expect(safety.inspect()).resolves.toMatchObject({
      trafficBlocked: false,
      filterActive: false,
    });
  });

  it("does not report unknown DNR status as verified protection", async () => {
    await safety.block(true);
    await safety.setWebRtc(true);
    fake.rejectRead = true;
    await expect(safety.inspect()).resolves.toEqual({
      trafficBlocked: false,
      filterActive: false,
      webRtcProtected: true,
      blockingScope: "unverified",
    });
  });

  it("permits only the exact excluded destination while blocking every other request", async () => {
    safety.configureExclusions([{ domain: "example.com", includeSubdomains: false }]);
    await safety.block(true);
    for (const type of GUARDED_RESOURCE_TYPES) {
      expect(fake.decision("https://example.com/path", type), type).toBe("allow");
      expect(fake.decision("https://other.com/", type), type).toBe("block");
    }
    for (const url of [
      "http://example.com:8080/",
      "https://EXAMPLE.com./",
      "https://user:pass@example.com:8443/path",
      "ws://example.com/socket",
      "wss://example.com./socket",
    ]) {
      expect(fake.decision(url), url).toBe("allow");
    }
    for (const url of [
      "https://www.example.com/",
      "https://otherexample.com/",
      "https://example.com.other.com/",
      "https://example.com@other.com/",
      "https://other.com/example.com/",
      "https://other.com/?next=https://example.com/",
    ]) {
      expect(fake.decision(url), url).toBe("block");
    }
    await expect(safety.inspect()).resolves.toMatchObject({
      trafficBlocked: true,
      filterActive: true,
      blockingScope: "except_excluded",
    });
  });

  it("includes only genuine subdomains, with the same optional terminal dot as the proxy", async () => {
    safety.configureExclusions([{ domain: "example.com", includeSubdomains: true }]);
    await safety.block(true);
    for (const url of [
      "https://example.com/",
      "https://www.example.com/",
      "https://a.b.example.com./",
      "https://service_name.example.com/",
      "https://localhost.example.com/",
      "https://user:pass@a.example.com:8443/",
    ]) {
      expect(fake.decision(url), url).toBe("allow");
    }
    for (const url of [
      "https://otherexample.com/",
      "https://example.com.other.com/",
      "https://sub.example.com@other.com/",
      "https://sub.example.com..other.com/",
    ]) {
      expect(fake.decision(url), url).toBe("block");
    }
  });

  it("supports normalized international domains without authorizing their neighbours", async () => {
    safety.configureExclusions([{ domain: "xn--bcher-kva.de", includeSubdomains: true }]);
    await safety.block(true);
    expect(fake.decision("https://bücher.de/")).toBe("allow");
    expect(fake.decision("https://shop.bücher.de./")).toBe("allow");
    expect(fake.decision("https://otherbücher.de/")).toBe("block");
  });

  it("does not exempt third-party resources requested by an excluded page", async () => {
    safety.configureExclusions([{ domain: "example.com", includeSubdomains: true }]);
    await safety.block(true);
    expect(fake.decision("https://example.com/", "main_frame")).toBe("allow");
    expect(fake.decision("https://cdn.other.com/app.js", "script", "example.com")).toBe("block");
    expect(fake.decision("https://other.com/api", "xmlhttprequest", "example.com")).toBe("block");
    const exception = fake.dynamic.find((rule) => SAFETY_EXCLUSION_RULE_IDS.includes(rule.id))!;
    expect(exception.action.type).toBe("allow");
    expect(exception.priority).toBe(15);
    expect(exception.condition.initiatorDomains).toBeUndefined();
    expect(exception.condition.resourceTypes).toEqual(GUARDED_RESOURCE_TYPES);
  });

  it("keeps destination exceptions persistent across browser restart and worker suspension", async () => {
    const entries = [{ domain: "example.com", includeSubdomains: true }];
    safety.configureExclusions(entries);
    await safety.block(true);
    await safety.allow();
    await expect(safety.inspect()).resolves.toMatchObject({ blockingScope: "none" });
    const original = structuredClone(fake.dynamic);
    fake.session = [];
    const restarted = new PlatformNetworkSafetyService();
    await expect(restarted.inspect()).resolves.toMatchObject({ blockingScope: "unverified" });
    restarted.configureExclusions(entries);
    await restarted.suspend();
    expect(fake.dynamic).toEqual(original);
    await expect(restarted.inspect()).resolves.toMatchObject({
      blockingScope: "except_excluded",
      trafficBlocked: true,
      filterActive: true,
    });
    expect(fake.decision("https://example.com/")).toBe("allow");
    expect(fake.decision("https://other.com/")).toBe("block");
  });

  it("replaces and removes stale destination rules while navigation is suspended", async () => {
    safety.configureExclusions([
      { domain: "example.com", includeSubdomains: true },
      { domain: "other.com", includeSubdomains: false },
    ]);
    await safety.block(true);
    await safety.allow();
    safety.configureExclusions([{ domain: "new.com", includeSubdomains: false }]);
    await safety.block(true);
    expect(fake.dynamic.filter((rule) => SAFETY_EXCLUSION_RULE_IDS.includes(rule.id))).toHaveLength(
      1,
    );
    expect(fake.decision("https://example.com/")).toBe("block");
    expect(fake.decision("https://other.com/")).toBe("block");
    expect(fake.decision("https://new.com/")).toBe("allow");
    safety.configureExclusions([]);
    await safety.block(true);
    expect(fake.dynamic.some((rule) => SAFETY_EXCLUSION_RULE_IDS.includes(rule.id))).toBe(false);
    await expect(safety.inspect()).resolves.toMatchObject({ blockingScope: "all" });
  });

  it("retains the configured exclusions when the kill switch is disabled without claiming blocking", async () => {
    safety.configureExclusions([{ domain: "example.com", includeSubdomains: false }]);
    await safety.block(false);
    expect(fake.decision("https://example.com/")).toBe("allow");
    expect(fake.decision("https://other.com/")).toBe("unmatched");
    expect(fake.decision("http://router/")).toBe("block");
    await expect(safety.inspect()).resolves.toMatchObject({
      filterActive: true,
      trafficBlocked: false,
      blockingScope: "none",
    });
  });

  it("clones configured entries and does not write Firefox settings during configuration", async () => {
    const entries = [{ domain: "example.com", includeSubdomains: false }];
    safety.configureExclusions(entries);
    entries[0]!.domain = "other.com";
    expect(fake.events).toEqual([]);
    await safety.block(true);
    expect(fake.decision("https://example.com/")).toBe("allow");
    expect(fake.decision("https://other.com/")).toBe("block");
  });

  it("rejects a missing destination rule before authorizing navigation", async () => {
    safety.configureExclusions([{ domain: "example.com", includeSubdomains: false }]);
    await safety.block(true);
    fake.dynamic = fake.dynamic.filter((rule) => !SAFETY_EXCLUSION_RULE_IDS.includes(rule.id));
    await expect(safety.inspect()).resolves.toMatchObject({
      filterActive: false,
      trafficBlocked: false,
      blockingScope: "unverified",
    });
    await expect(safety.allow()).rejects.toEqual(new SafetyError("traffic_guard_failed"));
    expect(fake.session).toEqual([]);
  });

  it.each(["unscoped", "priority", "page", "initiator", "resourceTypes"])(
    "refuses a destination allowance with altered %s privileges",
    async (change) => {
      safety.configureExclusions([{ domain: "example.com", includeSubdomains: true }]);
      await safety.block(true);
      const exception = fake.dynamic.find((rule) => SAFETY_EXCLUSION_RULE_IDS.includes(rule.id))!;
      if (change === "unscoped") delete exception.condition.regexFilter;
      if (change === "priority") exception.priority = 40;
      if (change === "page") exception.action.type = "allowAllRequests";
      if (change === "initiator") exception.condition.initiatorDomains = ["example.com"];
      if (change === "resourceTypes") exception.condition.resourceTypes = ["main_frame"];
      await expect(safety.inspect()).resolves.toMatchObject({
        filterActive: false,
        trafficBlocked: false,
        blockingScope: "unverified",
      });
      await expect(safety.allow()).rejects.toEqual(new SafetyError("traffic_guard_failed"));
    },
  );

  it("does not treat a copied session-only exception as verified persistent policy", async () => {
    safety.configureExclusions([{ domain: "example.com", includeSubdomains: false }]);
    await safety.block(true);
    const exception = fake.dynamic.find((rule) => SAFETY_EXCLUSION_RULE_IDS.includes(rule.id))!;
    fake.dynamic = fake.dynamic.filter((rule) => rule.id !== exception.id);
    fake.session.push(exception);
    await expect(safety.inspect()).resolves.toMatchObject({ blockingScope: "unverified" });
    await expect(safety.allow()).rejects.toEqual(new SafetyError("traffic_guard_failed"));
  });

  it("does not trust a persistent copy of the global browser-session allowance", async () => {
    await safety.block(true);
    await safety.allow();
    fake.dynamic.push(fake.session[0]!);
    fake.session = [];
    await expect(safety.inspect()).resolves.toMatchObject({
      filterActive: false,
      trafficBlocked: false,
      blockingScope: "unverified",
    });
  });

  it("reports unknown allowances as unverified even below the baseline priority", async () => {
    await safety.block(true);
    fake.dynamic.push({ id: 999, priority: 1, action: { type: "allow" }, condition: {} });
    await expect(safety.inspect()).resolves.toMatchObject({
      filterActive: false,
      trafficBlocked: false,
      blockingScope: "unverified",
    });
  });

  it("does not claim a blocking scope when a local protection filter is missing", async () => {
    await safety.block(true);
    fake.dynamic = fake.dynamic.filter((rule) => rule.id !== SAFETY_RULE_IDS.localNames);
    await expect(safety.inspect()).resolves.toMatchObject({
      filterActive: false,
      trafficBlocked: false,
      blockingScope: "unverified",
    });
  });

  it("releases every owned exclusion while preserving the in-memory expected preference", async () => {
    safety.configureExclusions([{ domain: "example.com", includeSubdomains: true }]);
    await safety.block(true);
    await safety.allow();
    await safety.release();
    expect(fake.dynamic).toEqual([]);
    expect(fake.session).toEqual([]);
    await expect(safety.inspect()).resolves.toMatchObject({ blockingScope: "none" });
    await safety.block(true);
    expect(fake.decision("https://example.com/")).toBe("allow");
  });

  it("releases owned rules even if they were placed in the wrong Firefox rule store", async () => {
    safety.configureExclusions([{ domain: "example.com", includeSubdomains: true }]);
    await safety.block(true);
    await safety.allow();
    const persistent = structuredClone(fake.dynamic);
    fake.dynamic.push(...fake.session);
    fake.session.push(...persistent);
    await expect(safety.inspect()).resolves.toMatchObject({ blockingScope: "unverified" });
    await safety.release();
    expect(fake.dynamic).toEqual([]);
    expect(fake.session).toEqual([]);
    await expect(safety.inspect()).resolves.toMatchObject({ blockingScope: "none" });
  });

  it("removes global permission and reports stale policy if a replacement write fails", async () => {
    safety.configureExclusions([{ domain: "example.com", includeSubdomains: true }]);
    await safety.block(true);
    await safety.allow();
    safety.configureExclusions([{ domain: "other.com", includeSubdomains: true }]);
    fake.rejectDynamic = true;
    await expect(safety.block(true)).rejects.toEqual(new SafetyError("traffic_guard_failed"));
    expect(fake.session).toEqual([]);
    await expect(safety.inspect()).resolves.toMatchObject({ blockingScope: "unverified" });
    expect(fake.decision("https://other.com/")).toBe("block");
  });

  it("cannot allocate exceptions beyond the owned persistent rule range", () => {
    expect(() =>
      safety.configureExclusions(
        Array.from({ length: 201 }, (_, index) => ({
          domain: `site${String(index)}.com`,
          includeSubdomains: false,
        })),
      ),
    ).toThrow(new SafetyError("traffic_guard_failed"));
    expect(fake.events).toEqual([]);
  });

  it("can persist a temporary intersection larger than either 100-entry policy", async () => {
    safety.configureExclusions(
      Array.from({ length: 198 }, (_, index) => ({
        domain: `site${String(index)}.com`,
        includeSubdomains: false,
      })),
    );
    await safety.block(true);
    expect(fake.dynamic.filter((rule) => SAFETY_EXCLUSION_RULE_IDS.includes(rule.id))).toHaveLength(
      198,
    );
    expect(fake.decision("https://site197.com/")).toBe("allow");
    expect(fake.decision("https://site198.com/")).toBe("block");
    await expect(safety.inspect()).resolves.toMatchObject({ blockingScope: "except_excluded" });
  });

  it("keeps target-only destinations blocked until the durable intersection guard is removed", async () => {
    safety.configureExclusions([{ domain: "example.com", includeSubdomains: true }]);
    await safety.block(true);
    await safety.allow();
    fake.events = [];
    await safety.setExclusionGuard([{ domain: "shop.example.com", includeSubdomains: false }]);
    expect(fake.events).toEqual(["session-remove", "dynamic"]);
    expect(fake.decision("https://shop.example.com/")).toBe("allow");
    expect(fake.decision("https://example.com/")).toBe("block");
    expect(fake.decision("https://child.shop.example.com/")).toBe("block");
    safety.configureExclusions([
      { domain: "shop.example.com", includeSubdomains: false },
      { domain: "other.com", includeSubdomains: true },
    ]);
    await safety.block(true);
    expect(fake.dynamic.some((rule) => rule.id === 2101 && rule.priority === 15)).toBe(true);
    expect(fake.decision("https://other.com/")).toBe("block");
    expect(fake.decision("https://shop.example.com/")).toBe("allow");
    await expect(safety.inspect()).resolves.toMatchObject({
      filterActive: true,
      trafficBlocked: true,
      blockingScope: "except_excluded",
    });
    await expect(safety.allow()).rejects.toEqual(new SafetyError("traffic_guard_failed"));
    expect(fake.session).toEqual([]);
    await safety.setExclusionGuard(null);
    expect(fake.decision("https://other.com/")).toBe("allow");
    expect(fake.dynamic.some((rule) => rule.id === SAFETY_EXCLUSION_GUARD_ID)).toBe(false);
    await safety.allow();
    await expect(safety.inspect()).resolves.toMatchObject({ blockingScope: "none" });
  });

  it("an empty intersection guard blocks everything even when the usual kill switch is disabled", async () => {
    safety.configureExclusions([{ domain: "example.com", includeSubdomains: true }]);
    await safety.block(false);
    await safety.setExclusionGuard([]);
    await safety.block(false);
    expect(fake.decision("https://example.com/")).toBe("block");
    expect(fake.decision("https://other.com/")).toBe("block");
    expect(fake.decision("http://localhost/")).toBe("block");
    expect(fake.decision("https://api.fuzevpn.com/v1/me", "xmlhttprequest", EXTENSION_ID)).toBe(
      "allow",
    );
    await expect(safety.inspect()).resolves.toMatchObject({
      filterActive: true,
      trafficBlocked: true,
      blockingScope: "all",
    });
    await safety.setExclusionGuard(null);
    await expect(safety.inspect()).resolves.toMatchObject({ blockingScope: "none" });
  });

  it("does not trust a surviving transaction guard until the worker restores its expected coverage", async () => {
    const target = [
      { domain: "example.com", includeSubdomains: false },
      { domain: "other.com", includeSubdomains: true },
    ];
    const common = [{ domain: "example.com", includeSubdomains: false }];
    safety.configureExclusions(target);
    await safety.block(true);
    await safety.setExclusionGuard(common);
    const restarted = new PlatformNetworkSafetyService();
    restarted.configureExclusions(target);
    await restarted.suspend();
    await expect(restarted.inspect()).resolves.toMatchObject({ blockingScope: "unverified" });
    expect(fake.decision("https://other.com/")).toBe("block");
    await restarted.setExclusionGuard(common);
    await expect(restarted.inspect()).resolves.toMatchObject({ blockingScope: "except_excluded" });
    await restarted.setExclusionGuard(null);
    expect(fake.decision("https://other.com/")).toBe("allow");
  });

  it("verifies a newly installed intersection guard independently of a changing normal policy", async () => {
    safety.configureExclusions([{ domain: "example.com", includeSubdomains: true }]);
    await safety.block(true);
    safety.configureExclusions([{ domain: "shop.example.com", includeSubdomains: false }]);
    await safety.setExclusionGuard([{ domain: "shop.example.com", includeSubdomains: false }]);
    expect(fake.decision("https://example.com/")).toBe("block");
    expect(fake.decision("https://shop.example.com/")).toBe("allow");
    await expect(safety.inspect()).resolves.toMatchObject({ blockingScope: "unverified" });
    await safety.block(true);
    await expect(safety.inspect()).resolves.toMatchObject({ blockingScope: "except_excluded" });
  });

  it.each(["missing-baseline", "missing-allow", "broad-allow", "priority"])(
    "does not claim protection for a transaction guard with %s",
    async (change) => {
      safety.configureExclusions([{ domain: "example.com", includeSubdomains: false }]);
      await safety.block(true);
      await safety.setExclusionGuard([{ domain: "example.com", includeSubdomains: false }]);
      if (change === "missing-baseline")
        fake.dynamic = fake.dynamic.filter((rule) => rule.id !== SAFETY_EXCLUSION_GUARD_ID);
      if (change === "missing-allow")
        fake.dynamic = fake.dynamic.filter(
          (rule) => !SAFETY_EXCLUSION_GUARD_ALLOW_IDS.includes(rule.id),
        );
      const exception = fake.dynamic.find((rule) =>
        SAFETY_EXCLUSION_GUARD_ALLOW_IDS.includes(rule.id),
      );
      if (change === "broad-allow" && exception) delete exception.condition.regexFilter;
      if (change === "priority" && exception) exception.priority = 40;
      await expect(safety.inspect()).resolves.toMatchObject({
        filterActive: false,
        trafficBlocked: false,
        blockingScope: "unverified",
      });
    },
  );

  it("refuses an unexpected higher-priority allowance when installing a transaction guard", async () => {
    await safety.block(true);
    fake.dynamic.push({ id: 999, priority: 19, action: { type: "allow" }, condition: {} });
    await expect(safety.setExclusionGuard([])).rejects.toEqual(
      new SafetyError("traffic_guard_failed"),
    );
    await expect(safety.inspect()).resolves.toMatchObject({ blockingScope: "unverified" });
    expect(fake.session).toEqual([]);
  });

  it("keeps the restrictive guard intact when writing the target rules fails", async () => {
    safety.configureExclusions([{ domain: "example.com", includeSubdomains: true }]);
    await safety.block(true);
    await safety.setExclusionGuard([{ domain: "shop.example.com", includeSubdomains: false }]);
    safety.configureExclusions([{ domain: "other.com", includeSubdomains: true }]);
    fake.rejectDynamic = true;
    await expect(safety.block(true)).rejects.toEqual(new SafetyError("traffic_guard_failed"));
    expect(fake.decision("https://example.com/")).toBe("block");
    expect(fake.decision("https://other.com/")).toBe("block");
    expect(fake.decision("https://shop.example.com/")).toBe("allow");
  });

  it("verifies actual guard removal and reports an ignored removal as unknown", async () => {
    await safety.block(true);
    await safety.setExclusionGuard([]);
    fake.ignoreDynamic = true;
    await expect(safety.setExclusionGuard(null)).rejects.toEqual(
      new SafetyError("traffic_guard_failed"),
    );
    expect(fake.decision("https://example.com/")).toBe("block");
    await expect(safety.inspect()).resolves.toMatchObject({ blockingScope: "unverified" });
  });

  it("does not re-arm an old transaction guard after an explicit release", async () => {
    await safety.block(true);
    await safety.setExclusionGuard([]);
    await safety.release();
    expect(fake.dynamic).toEqual([]);
    expect(fake.session).toEqual([]);
    await safety.block(false);
    expect(fake.dynamic.some((rule) => rule.id === SAFETY_EXCLUSION_GUARD_ID)).toBe(false);
    await expect(safety.inspect()).resolves.toMatchObject({ blockingScope: "none" });
  });

  it.each([
    "example.com|.*",
    "127.0.0.1",
    "router.local",
    "com",
    "api.fuzevpn.com",
    "fuzevpn.com",
    "ipify.org",
  ])("refuses unvalidated or reserved entries before compiling DNR rules: %s", (domain) => {
    expect(() => safety.configureExclusions([{ domain, includeSubdomains: true }])).toThrow(
      new SafetyError("traffic_guard_failed"),
    );
    expect(fake.events).toEqual([]);
  });

  it("reports a failed guard release without deleting unrelated rules", async () => {
    await safety.block(true);
    fake.ignoreDynamic = true;
    await expect(safety.release()).rejects.toEqual(new SafetyError("traffic_guard_failed"));
    await expect(safety.inspect()).resolves.toMatchObject({ trafficBlocked: true });
  });

  it("uses the runtime UUID for API requests rather than the Firefox add-on identifier", async () => {
    await safety.block(true);
    const apiRule = fake.dynamic.find((rule) => rule.id === SAFETY_RULE_IDS.apiAllow)!;
    expect(apiRule.condition.initiatorDomains).toEqual([EXTENSION_ID]);
    expect(
      fake.decision(
        "https://api.fuzevpn.com/v1/me",
        "xmlhttprequest",
        "fuzevpn-firefox@vpn1euro.com",
      ),
    ).toBe("block");
  });

  it("exposes cloned route exclusions and the narrower pending intersection", async () => {
    safety.configureExclusions([{ domain: "example.com", includeSubdomains: true }]);
    const first = safety.getRouteExclusions();
    first[0]!.domain = "other.com";
    expect(safety.getRouteExclusions()).toEqual([
      { domain: "example.com", includeSubdomains: true },
    ]);
    await safety.block(true);
    await safety.setExclusionGuard([{ domain: "shop.example.com", includeSubdomains: false }]);
    expect(safety.hasExclusionGuard()).toBe(true);
    expect(safety.getRouteExclusions()).toEqual([
      { domain: "shop.example.com", includeSubdomains: false },
    ]);
    await safety.setExclusionGuard(null);
    expect(safety.hasExclusionGuard()).toBe(false);
    expect(safety.getRouteExclusions()).toEqual([
      { domain: "example.com", includeSubdomains: true },
    ]);
  });

  it("disables speculative DNS and connections independently of the WebRTC preference", async () => {
    await safety.block(true);
    expect(fake.prediction).toEqual({
      value: false,
      levelOfControl: "controlled_by_this_extension",
    });
    await safety.setWebRtc(false);
    expect(fake.prediction.value).toBe(false);
    await safety.allow();
    await safety.release();
    expect(fake.prediction).toEqual(fake.underlyingPrediction);
  });

  it("does not claim verified protection when speculative networking is restored externally", async () => {
    await safety.block(true);
    await safety.allow();
    fake.prediction = { value: true, levelOfControl: "controlled_by_other_extensions" };
    await expect(safety.inspect()).resolves.toMatchObject({
      filterActive: false,
      blockingScope: "unverified",
    });
    await expect(safety.allow()).rejects.toThrow("traffic_guard_failed");
    expect(fake.session).toEqual([]);
  });

  it("retains blocking rules if Firefox ignores the network prediction override", async () => {
    fake.ignorePredictionSet = true;
    await expect(safety.block(true)).rejects.toThrow("traffic_guard_failed");
    expect(fake.decision("https://example.com/")).toBe("block");
    expect(fake.session).toEqual([]);
  });

  it("reports a failed release if Firefox retains our network prediction override", async () => {
    await safety.block(true);
    fake.ignorePredictionClear = true;
    await expect(safety.release()).rejects.toThrow("traffic_guard_failed");
    expect(fake.prediction.levelOfControl).toBe("controlled_by_this_extension");
  });

  it("sets and verifies restricted WebRTC, then restores the underlying Firefox setting", async () => {
    await safety.setWebRtc(true);
    expect(fake.privacy.value).toBe("disable_non_proxied_udp");
    await expect(safety.inspect()).resolves.toMatchObject({ webRtcProtected: true });
    await safety.setWebRtc(false);
    expect(fake.privacy).toEqual(fake.underlyingPrivacy);
    await expect(safety.inspect()).resolves.toMatchObject({ webRtcProtected: false });
  });

  it.each(["not_controllable", "controlled_by_other_extensions"])(
    "refuses a WebRTC control conflict: %s",
    async (level) => {
      fake.privacy.levelOfControl = level;
      await expect(safety.setWebRtc(true)).rejects.toEqual(
        new SafetyError("webrtc_control_unavailable"),
      );
      expect(fake.privacy.value).toBe("default");
      await expect(safety.inspect()).resolves.toMatchObject({ webRtcProtected: false });
    },
  );

  it("rejects an ignored WebRTC setting and failed read-back", async () => {
    fake.ignorePrivacySet = true;
    await expect(safety.setWebRtc(true)).rejects.toEqual(
      new SafetyError("webrtc_control_unavailable"),
    );
    fake.rejectPrivacyRead = true;
    await expect(safety.inspect()).resolves.toMatchObject({ webRtcProtected: false });
  });

  it("does not claim a WebRTC setting was released when Firefox ignored the clear", async () => {
    await safety.setWebRtc(true);
    fake.ignorePrivacyClear = true;
    await expect(safety.setWebRtc(false)).rejects.toEqual(
      new SafetyError("webrtc_control_unavailable"),
    );
    await expect(safety.inspect()).resolves.toMatchObject({ webRtcProtected: true });
  });
});
