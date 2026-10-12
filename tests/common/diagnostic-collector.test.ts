// SPDX-License-Identifier: MPL-2.0

import {
  collectDiagnostic,
  diagnosticEnvironment,
  diagnosticError,
  reportBase,
  type CollectorDependencies,
  type DiagnosticReadModel,
} from "../../src/core/diagnostics/collector";
import { EMPTY_SNAPSHOT, type AppSnapshot } from "../../src/core/shared/state";
import { EMPTY_NETWORK_OBSERVATION, type NetworkObservation } from "../../src/core/shared/network";
import type { SecurityStatus } from "../../src/core/shared/security";
import type { ProxyControlLevel } from "../../src/core/background/proxy-controller";
import {
  DIAGNOSTIC_MAX_DURATION_MS,
  serializeDiagnosticReport,
  type DiagnosticReport,
} from "../../src/core/shared/diagnostic-report";

const NOW = Date.parse("2026-09-16T12:00:00Z");
const ID = "a1000000-0000-4000-8000-000000000001";

function fixture() {
  let now = NOW;
  const snapshot: AppSnapshot = {
    ...structuredClone(EMPTY_SNAPSHOT),
    status: "connected",
    protected: true,
    protectionRequested: true,
    activeLocationId: "sensitive-node",
    selectedLocationId: "sensitive-node",
    profile: {
      userId: "sensitive-user",
      email: "person@example.invalid",
      firstName: "SensitiveFirst",
      lastName: "SensitiveLast",
      countryCode: "FR",
    },
    locations: [
      {
        id: "sensitive-node",
        city: "SensitiveCity",
        countryCode: "FR",
        displayName: "SensitiveDisplay",
        supportedProtocols: ["browser_proxy"],
      },
    ],
    devices: [
      {
        deviceId: "sensitive-device",
        name: "SensitiveMachine",
        kind: "browser_extension",
        profiles: [],
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
    currentDeviceId: "sensitive-device",
  };
  snapshot.siteExclusions.saved = {
    revision: 1,
    enabled: true,
    entries: [{ domain: "private.example.invalid", includeSubdomains: true }],
  };
  snapshot.siteExclusions.applied = structuredClone(snapshot.siteExclusions.saved);
  const model: DiagnosticReadModel = {
    snapshot,
    safety: {
      trafficBlocked: false,
      filterActive: true,
      webRtcProtected: true,
      blockingScope: "none",
    },
    reconnectAttempts: 0,
    proxyCreationUncertain: false,
    proxyCleanupUncertain: false,
  };
  const network: NetworkObservation = {
    ...EMPTY_NETWORK_OBSERVATION,
    status: "ready",
    mode: "vpn",
    ip: "192.0.2.55",
    locationId: "sensitive-node",
    checkedAt: NOW - 250,
    latencyMs: 0,
  };
  const dependencies = {
    read: vi.fn(() => structuredClone(model)),
    inspectSafety: vi.fn(async (): Promise<SecurityStatus> => structuredClone(model.safety)),
    inspectWebRtc: vi.fn(async () => true),
    getProxyControl: vi.fn(async (): Promise<ProxyControlLevel> => "controlled_by_this_extension"),
    verifyProxy: vi.fn(async (): Promise<boolean | null> => true),
    probe: vi.fn(async () => structuredClone(network)),
    now: () => now,
  } satisfies CollectorDependencies;
  const collect = () =>
    collectDiagnostic(dependencies, reportBase(ID, NOW, "0.5.5", snapshot.status, "full", {}), {
      events: [],
      dropped: 0,
    });
  return {
    model,
    network,
    dependencies,
    collect,
    setNow: (value: number) => {
      now = value;
    },
  };
}

function check(report: DiagnosticReport, id: string) {
  return report.checks?.find((entry) => entry.id === id);
}

describe("diagnostic collector observations", () => {
  it("excludes identifying application data and retains counts and safe observations only", async () => {
    const f = fixture();
    const report = await f.collect();
    const encoded = serializeDiagnosticReport(report);
    for (const secret of [
      "sensitive-node",
      "sensitive-user",
      "person@example.invalid",
      "SensitiveFirst",
      "SensitiveLast",
      "SensitiveCity",
      "SensitiveDisplay",
      "sensitive-device",
      "SensitiveMachine",
      "private.example.invalid",
      "192.0.2.55",
    ])
      expect(encoded).not.toContain(secret);
    expect(report.chrome).toMatchObject({
      exclusions_count: 1,
      exclusions_enabled: true,
      exclusions_state: "applied",
      proxy_creation_state: "confirmed",
      controlled_by: "self",
    });
    expect(f.dependencies.probe).toHaveBeenCalledOnce();
    expect(f.dependencies.inspectSafety).toHaveBeenCalledOnce();
  });

  it.each([
    ["none", false, false],
    ["all", true, true],
    ["except_excluded", true, true],
    ["unverified", false, false],
  ] as const)(
    "preserves blocking scope %s independently of requested protection",
    async (blockingScope, filterActive, trafficBlocked) => {
      const f = fixture();
      f.model.safety = { blockingScope, filterActive, trafficBlocked, webRtcProtected: false };
      const report = await f.collect();
      expect(report.chrome!.blocking_scope).toBe(blockingScope);
      expect(report.snapshot!.kill_switch_requested).toBe(true);
      if (blockingScope === "unverified") {
        expect(report.snapshot).not.toHaveProperty("kill_switch_verified");
        expect(report.snapshot).not.toHaveProperty("traffic_blocked");
        expect(check(report, "kill_switch")?.result).toBe("unknown");
      } else {
        expect(report.snapshot!.kill_switch_verified).toBe(filterActive);
        expect(report.snapshot!.traffic_blocked).toBe(trafficBlocked);
        expect(check(report, "kill_switch")?.result).toBe(filterActive ? "passed" : "failed");
      }
    },
  );

  it("keeps verified guard observations even when the kill switch was not requested", async () => {
    const f = fixture();
    f.model.snapshot.securityPreferences.killSwitchEnabled = false;
    f.model.safety = {
      blockingScope: "none",
      filterActive: true,
      trafficBlocked: false,
      webRtcProtected: false,
    };
    const report = await f.collect();
    expect(report.snapshot).toMatchObject({
      kill_switch_requested: false,
      kill_switch_verified: true,
      traffic_blocked: false,
    });
    expect(check(report, "kill_switch")?.result).toBe("skipped");
  });

  it("skips judging disabled WebRTC protection while preserving the actual false observation", async () => {
    const f = fixture();
    f.model.snapshot.securityPreferences.webRtcProtectionEnabled = false;
    f.dependencies.inspectWebRtc.mockResolvedValue(false);
    const report = await f.collect();
    expect(report.snapshot!.webrtc_protected).toBe(false);
    expect(check(report, "webrtc")?.result).toBe("skipped");
  });

  it("does not claim failure or success when a safety or WebRTC read failed", async () => {
    const f = fixture();
    f.dependencies.inspectSafety.mockRejectedValue(new Error("sensitive-native-error"));
    f.dependencies.inspectWebRtc.mockRejectedValue(new Error("sensitive-native-error"));
    const report = await f.collect();
    expect(report.snapshot).not.toHaveProperty("kill_switch_verified");
    expect(report.snapshot).not.toHaveProperty("traffic_blocked");
    expect(report.snapshot).not.toHaveProperty("webrtc_protected");
    expect(report.chrome).not.toHaveProperty("blocking_scope");
    expect(check(report, "kill_switch")?.result).toBe("unknown");
    expect(check(report, "webrtc")?.result).toBe("unknown");
    expect(serializeDiagnosticReport(report)).not.toContain("sensitive-native-error");
  });

  it("preserves a measured false WebRTC result", async () => {
    const f = fixture();
    f.dependencies.inspectWebRtc.mockResolvedValue(false);
    const report = await f.collect();
    expect(report.snapshot!.webrtc_protected).toBe(false);
    expect(check(report, "webrtc")?.result).toBe("failed");
  });

  it.each([
    ["idle", "not_run", "skipped"],
    ["checking", "unknown", "unknown"],
    ["ready", "passed", "passed"],
    ["unavailable", "failed", "failed"],
  ] as const)(
    "reports probe status %s without inventing success",
    async (status, result, checkResult) => {
      const f = fixture();
      Object.assign(f.network, { status, checkedAt: null, latencyMs: null });
      const report = await f.collect();
      expect(report.chrome!.probe_result).toBe(result);
      expect(check(report, "connectivity")?.result).toBe(checkResult);
      expect(check(report, "connectivity")).not.toHaveProperty("age_ms");
      expect(report.chrome).not.toHaveProperty("probe_latency_ms");
    },
  );

  it("retains measured zero latency and independently measured observation age", async () => {
    const report = await fixture().collect();
    expect(report.chrome!.probe_latency_ms).toBe(0);
    expect(check(report, "connectivity")).toMatchObject({ duration_ms: 0, age_ms: 250 });
  });

  it("marks an executed rejected probe as failed", async () => {
    const f = fixture();
    f.dependencies.probe.mockRejectedValue(new Error("sensitive-probe-error"));
    const report = await f.collect();
    expect(report.chrome!.probe_result).toBe("failed");
    expect(check(report, "connectivity")?.result).toBe("failed");
    expect(report.chrome).not.toHaveProperty("probe_latency_ms");
  });

  it.each([
    "location",
    "protected",
    "trafficBlocked",
    "exclusionError",
    "exclusionRevision",
    "account",
  ])("invalidates all observations when %s changes during collection", async (change) => {
    const f = fixture();
    f.dependencies.probe.mockImplementation(async () => {
      if (change === "location") f.model.snapshot.activeLocationId = "other-sensitive-node";
      if (change === "protected") f.model.snapshot.protected = false;
      if (change === "trafficBlocked") f.model.snapshot.trafficBlocked = true;
      if (change === "exclusionError") f.model.snapshot.siteExclusions.error = true;
      if (change === "exclusionRevision") f.model.snapshot.siteExclusions.applied.revision += 1;
      if (change === "account") f.model.snapshot.profile!.userId = "other-sensitive-user";
      return structuredClone(f.network);
    });
    const report = await f.collect();
    expect(report.chrome).toMatchObject({
      blocking_scope: "unverified",
      probe_result: "unknown",
      proxy_creation_state: "unknown",
    });
    expect(report.snapshot).not.toHaveProperty("kill_switch_verified");
    expect(report.snapshot).not.toHaveProperty("traffic_blocked");
    expect(report.snapshot).not.toHaveProperty("webrtc_protected");
    expect(report.chrome).not.toHaveProperty("probe_latency_ms");
    expect(check(report, "connectivity")).not.toHaveProperty("age_ms");
    expect(report.checks!.every((item) => item.result === "unknown")).toBe(true);
  });

  it.each([-1, NaN, Infinity, DIAGNOSTIC_MAX_DURATION_MS + 1])(
    "omits invalid latency %s instead of turning it into zero or a clamped success",
    async (latencyMs) => {
      const f = fixture();
      f.network.latencyMs = latencyMs;
      const report = await f.collect();
      expect(report.chrome).not.toHaveProperty("probe_latency_ms");
      expect(check(report, "connectivity")).not.toHaveProperty("duration_ms");
    },
  );

  it.each([NOW + 1, NOW - DIAGNOSTIC_MAX_DURATION_MS - 1, NaN])(
    "omits an unrepresentable observation age for timestamp %s",
    async (checkedAt) => {
      const f = fixture();
      f.network.checkedAt = checkedAt;
      const report = await f.collect();
      expect(check(report, "connectivity")).not.toHaveProperty("age_ms");
    },
  );

  it("retains uncertainty rather than confirmation for pending proxy operations", async () => {
    const f = fixture();
    f.model.proxyCreationUncertain = true;
    f.model.proxyCleanupUncertain = true;
    const report = await f.collect();
    expect(report.chrome).toMatchObject({
      proxy_creation_state: "uncertain",
      proxy_revocation_state: "uncertain",
    });
  });

  it("maps arbitrary exception text to the closed unknown code", () => {
    expect(diagnosticError("synthetic token and stack")).toEqual({
      domain: "client",
      code: "unknown_error",
      operation: "unknown",
      stage: "unknown",
    });
  });
});

describe("Firefox UI-only diagnostic codes", () => {
  it.each([
    ["device_revoked_limit", "device_limit"],
    ["server_full", "invalid_location"],
    ["capacity_unavailable", "proxy_unavailable"],
    ["private_browsing_required", "proxy_controlled_by_policy"],
    ["host_permissions_required", "proxy_controlled_by_policy"],
  ])("normalizes %s to the existing server code %s", (code, normalized) => {
    expect(diagnosticError(code, "connect")).toEqual(diagnosticError(normalized, "connect"));
  });
});

describe("diagnostic environment selection", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("extracts technical browser and platform vocabulary without retaining the user agent", async () => {
    vi.stubGlobal("navigator", {
      userAgent: "SensitiveMachine private.example.invalid Firefox/157.0.1",
    });
    vi.stubGlobal("browser", {
      runtime: {
        getPlatformInfo: async () => ({ os: "win", arch: "x86-64", nacl_arch: "sensitive" }),
      },
    });
    expect(await diagnosticEnvironment()).toEqual({
      browser_name: "unknown",
      browser_version: "157.0.1",
      os_family: "windows",
      architecture: "x64",
    });
  });
  it("omits unavailable platform data", async () => {
    vi.stubGlobal("navigator", { userAgent: "SensitiveMachine" });
    vi.stubGlobal("browser", {
      runtime: {
        getPlatformInfo: async () => {
          throw new Error("sensitive");
        },
      },
    });
    expect(await diagnosticEnvironment()).toEqual({ browser_name: "unknown" });
  });
});
