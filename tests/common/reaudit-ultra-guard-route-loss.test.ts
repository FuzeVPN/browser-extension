// SPDX-License-Identifier: MPL-2.0

import { ApiError } from "../../src/core/api/client";
import { AppController } from "../../src/core/background/state-machine";
import { DEFAULT_SECURITY_STATE } from "../../src/core/shared/security";
import {
  emptySiteExclusionRecord,
  type SiteExclusionRecord,
  type SiteExclusionStorage,
} from "../../src/core/storage/site-exclusion-storage";
import { PlatformNetworkSafetyService as ChromiumSafety } from "../../src/platform/chromium/network-safety";
import { PlatformProxyService as ChromiumProxy } from "../../src/platform/chromium/proxy-controller";
import { PlatformNetworkSafetyService as FirefoxSafety } from "../../src/platform/firefox/network-safety";
import { PlatformProxyService as FirefoxProxy } from "../../src/platform/firefox/proxy-controller";
import { authenticatedState, createHarness, NOW } from "./helpers";

type Platform = "chromium" | "firefox";
type Scenario = "pending exclusions" | "kill switch outage";

// Startup schedules background account work that publishes on its own.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Setting {
  value: unknown;
  levelOfControl: string;
}

interface NativeRule {
  id: number;
}

interface RuleUpdate {
  removeRuleIds?: number[];
  addRules?: NativeRule[];
}

class Policies implements SiteExclusionStorage {
  record: SiteExclusionRecord = emptySiteExclusionRecord();
  rejectCommit = false;

  async read() {
    return structuredClone(this.record);
  }

  async write(record: SiteExclusionRecord) {
    if (this.rejectCommit && !record.pending) throw new Error("exclusion commit unavailable");
    this.record = structuredClone(record);
  }
}

/** Native settings and rule stores shared by the real platform adapters. */
function installNative(platform: Platform) {
  const native = {
    proxy: { value: {}, levelOfControl: "controllable_by_this_extension" } as Setting,
    privacy: { value: "default", levelOfControl: "controllable_by_this_extension" } as Setting,
    prediction: { value: true, levelOfControl: "controllable_by_this_extension" } as Setting,
    dynamic: [] as NativeRule[],
    session: [] as NativeRule[],
    sessionStore: {} as Record<string, unknown>,
    proxyWrites: 0,
  };
  const update = (rules: NativeRule[], { removeRuleIds = [], addRules = [] }: RuleUpdate) => [
    ...rules.filter((rule) => !removeRuleIds.includes(rule.id)),
    ...structuredClone(addRules),
  ];
  const setting = (key: "privacy" | "prediction", underlying: unknown) => ({
    get: async () => structuredClone(native[key]),
    set: async ({ value }: { value: unknown }) => {
      native[key] = { value, levelOfControl: "controlled_by_this_extension" };
    },
    clear: async () => {
      native[key] = { value: underlying, levelOfControl: "controllable_by_this_extension" };
    },
  });
  vi.stubGlobal(platform === "chromium" ? "chrome" : "browser", {
    runtime: {
      id:
        platform === "chromium"
          ? "abcdefghijklmnopabcdefghijklmnop"
          : "fuzevpn-firefox@vpn1euro.com",
      getURL: () => "moz-extension://bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/",
    },
    extension: { isAllowedIncognitoAccess: async () => platform === "firefox" },
    permissions: { contains: async () => true },
    storage: {
      session: {
        get: async () => structuredClone(native.sessionStore),
        set: async (value: Record<string, unknown>) => {
          Object.assign(native.sessionStore, structuredClone(value));
        },
      },
    },
    proxy: {
      settings: {
        get: async () => structuredClone(native.proxy),
        set: async ({ value }: { value: unknown }) => {
          native.proxyWrites += 1;
          native.proxy = {
            value: structuredClone(value),
            levelOfControl: "controlled_by_this_extension",
          };
        },
        clear: async () => {
          native.proxy = { value: {}, levelOfControl: "controllable_by_this_extension" };
        },
      },
    },
    declarativeNetRequest: {
      isRegexSupported: async () => ({ isSupported: true }),
      getDynamicRules: async () => structuredClone(native.dynamic),
      getSessionRules: async () => structuredClone(native.session),
      updateDynamicRules: async (options: RuleUpdate) => {
        native.dynamic = update(native.dynamic, options);
      },
      updateSessionRules: async (options: RuleUpdate) => {
        native.session = update(native.session, options);
      },
    },
    privacy: {
      network: {
        webRTCIPHandlingPolicy: setting("privacy", "default"),
        networkPredictionEnabled: setting("prediction", true),
      },
    },
  });
  return native;
}

function realHarness(platform: Platform) {
  const native = installNative(platform);
  const policies = new Policies();
  const h = createHarness({
    persisted: authenticatedState(),
    security: { ...DEFAULT_SECURITY_STATE, webRtcProtectionEnabled: false },
  });
  const proxy = platform === "chromium" ? new ChromiumProxy() : new FirefoxProxy();
  const safety = platform === "chromium" ? new ChromiumSafety() : new FirefoxSafety();
  const controller = new AppController({
    api: h.api,
    storage: h.storage,
    identity: h.identity,
    alarms: h.alarms,
    securityStorage: h.securityStorage,
    proxy,
    safety,
    siteExclusionStorage: policies,
    now: () => NOW,
    onStateChanged: (snapshot) => h.snapshots.push(snapshot),
  });
  return { ...h, native, policies, proxy, safety, controller };
}

/** Leaves a blocking guard without any session that could be restored. */
async function blockWithoutSession(h: ReturnType<typeof realHarness>, scenario: Scenario) {
  await h.controller.initialize();
  if (scenario === "pending exclusions") {
    h.policies.rejectCommit = true;
    await expect(
      h.controller.updateSiteExclusions(0, true, [
        { domain: "example.com", includeSubdomains: false },
      ]),
    ).rejects.toThrow("exclusion commit unavailable");
  } else {
    h.api.createError = new ApiError("device_limit", 409);
    expect(await h.controller.connect("frankfurt-01")).toMatchObject({ ok: false });
  }
  expect(await h.controller.getActiveSession()).toBeNull();
  expect(await h.proxy.isGuardedConfiguration()).toBe(true);
  expect(h.controller.getSnapshot()).toMatchObject({ trafficBlocked: true, blockingScope: "all" });
}

describe("guard route lost while no proxy session exists", () => {
  afterEach(() => vi.unstubAllGlobals());

  for (const platform of ["chromium", "firefox"] as const) {
    for (const scenario of ["pending exclusions", "kill switch outage"] as const) {
      it(`${platform} ${scenario}: withdraws the blocking claim while another extension routes`, async () => {
        const h = realHarness(platform);
        await blockWithoutSession(h, scenario);
        const ours = structuredClone(h.native.proxy);
        const writes = h.native.proxyWrites;
        h.native.proxy = {
          value: platform === "chromium" ? { mode: "direct" } : { proxyType: "none" },
          levelOfControl: "controlled_by_other_extensions",
        };
        await h.controller.handleProxyControlLost(await h.proxy.getControlLevel());
        expect(await h.proxy.isGuardedConfiguration()).toBe(false);
        expect(h.native.proxyWrites).toBe(writes);
        expect(h.controller.getSnapshot()).toMatchObject({
          status: "error",
          protected: false,
          trafficBlocked: false,
          blockingScope: "unverified",
          error: "proxy_controlled_by_extension",
          protectionRequested: scenario === "kill switch outage",
        });
        // The independent request and RTC guards stay installed.
        expect(await h.safety.inspect()).toMatchObject({
          trafficBlocked: true,
          filterActive: true,
          webRtcProtected: true,
        });

        // The other extension releases the setting: our guard route is effective again.
        h.native.proxy = ours;
        await h.controller.handleProxyControlLost(await h.proxy.getControlLevel());
        expect(h.controller.getSnapshot()).toMatchObject({
          status: "blocked",
          trafficBlocked: true,
          blockingScope: "all",
        });
      });
    }
  }

  it("restores its own guard route when control permits", async () => {
    const h = createHarness({ persisted: authenticatedState() });
    await h.controller.initialize();
    h.api.createError = new ApiError("device_limit", 409);
    expect(await h.controller.connect("frankfurt-01")).toMatchObject({ ok: false });
    expect(h.proxy.blockingRoute).toBe(true);
    const calls = h.proxy.ensureBlockingCalls;
    h.proxy.blockingRoute = false;
    h.proxy.level = "controllable_by_this_extension";
    await h.controller.handleProxyControlLost("controllable_by_this_extension");
    expect(h.proxy.ensureBlockingCalls).toBe(calls + 1);
    expect(await h.proxy.isGuardedConfiguration()).toBe(true);
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "blocked",
      trafficBlocked: true,
      blockingScope: "all",
      error: "device_limit",
    });
  });

  it("leaves states without a required blocking route untouched", async () => {
    const disconnected = createHarness({ persisted: authenticatedState() });
    await disconnected.controller.initialize();
    await settle();
    const published = disconnected.snapshots.length;
    const events = [...disconnected.safety.events];
    disconnected.proxy.level = "controlled_by_other_extensions";
    await disconnected.controller.handleProxyControlLost("controlled_by_other_extensions");
    expect(disconnected.proxy.ensureBlockingCalls).toBe(0);
    expect(disconnected.snapshots).toHaveLength(published);
    expect(disconnected.safety.events).toEqual(events);

    // Without the kill switch, a failed connection keeps no blocking route to verify.
    const unguarded = createHarness({
      persisted: authenticatedState(),
      security: { ...DEFAULT_SECURITY_STATE, killSwitchEnabled: false },
    });
    await unguarded.controller.initialize();
    unguarded.api.createError = new ApiError("device_limit", 409);
    expect(await unguarded.controller.connect("frankfurt-01")).toMatchObject({ ok: false });
    await settle();
    const calls = unguarded.proxy.ensureBlockingCalls;
    const snapshots = unguarded.snapshots.length;
    unguarded.proxy.level = "controlled_by_other_extensions";
    await unguarded.controller.handleProxyControlLost("controlled_by_other_extensions");
    expect(unguarded.proxy.ensureBlockingCalls).toBe(calls);
    expect(unguarded.snapshots).toHaveLength(snapshots);
    expect(unguarded.controller.getSnapshot()).toMatchObject({
      trafficBlocked: false,
      error: "device_limit",
    });
  });
});
