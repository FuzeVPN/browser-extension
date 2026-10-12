// SPDX-License-Identifier: MPL-2.0

import {
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_EVENT_WINDOW_MS,
  DIAGNOSTIC_FULL_MAX_BYTES,
  DIAGNOSTIC_MAX_DURATION_MS,
  DIAGNOSTIC_SIMPLE_MAX_BYTES,
  isDiagnosticCode,
  isDiagnosticId,
  normalizeDiagnosticState,
  parseDiagnosticReport,
  serializeDiagnosticReport,
  type DiagnosticEvent,
  type DiagnosticReport,
} from "../../src/core/shared/diagnostic-report";

function report(type: "simple" | "full" = "simple"): DiagnosticReport {
  return {
    schema_version: 1,
    report_id: "a1000000-0000-4000-8000-000000000001",
    report_type: type,
    platform: "chrome_extension",
    app_version: "0.5.5",
    created_at: "2026-09-16T12:00:00Z",
    consent: { mode: "manual", notice_version: 1 },
    protocol: "browser_proxy",
    state: "degraded",
    occurrences: 1,
    error: {
      domain: "proxy",
      code: "proxy_creation_uncertain",
      operation: "connect",
      stage: "api_response",
    },
    truncated: false,
    dropped_events: 0,
  };
}

function event(offset_ms = 0): DiagnosticEvent {
  return { source: "controller", stage: "guard_verify", event: "end", offset_ms };
}

describe("closed Chrome diagnostic vocabulary", () => {
  it("contains exactly the 31 wire codes and no UI, transport or foreign platform code", () => {
    expect(DIAGNOSTIC_CODES).toHaveLength(31);
    expect(new Set(DIAGNOSTIC_CODES).size).toBe(31);
    for (const value of DIAGNOSTIC_CODES) expect(isDiagnosticCode(value)).toBe(true);
    for (const value of [
      null,
      0,
      "NETWORK_ERROR",
      "invalid_diagnostic",
      "openvpn_connection_failed",
      "secret-value",
      "device_revoked_limit",
    ])
      expect(isDiagnosticCode(value)).toBe(false);
  });

  it.each(["error", "events", "checks"])("rejects a raw UI quota alias in %s", (field) => {
    const value: unknown = {
      ...report("full"),
      ...(field === "error" ? { error: { ...report().error, code: "device_revoked_limit" } } : {}),
      ...(field === "events" ? { events: [{ ...event(), code: "device_revoked_limit" }] } : {}),
      ...(field === "checks"
        ? { checks: [{ id: "connectivity", result: "failed", code: "device_revoked_limit" }] }
        : {}),
    };
    expect(() => parseDiagnosticReport(value)).toThrow("invalid_diagnostic_report");
  });

  it.each([
    ["logged_out", "disconnected"],
    ["disconnected", "disconnected"],
    ["connecting", "connecting"],
    ["connected", "connected"],
    ["refreshing", "recovering"],
    ["disconnecting", "disconnecting"],
    ["blocked", "degraded"],
    ["error", "error"],
  ] as const)("maps observed application state %s to %s", (input, expected) => {
    expect(normalizeDiagnosticState(input)).toBe(expected);
  });

  it.each([
    "00000000-0000-0000-0000-000000000000",
    "A1000000-0000-4000-8000-000000000001",
    "a1000000000040008000000000000001",
    "../synthetic",
    "",
    null,
    42,
  ])("rejects noncanonical or nil report id %j", (value) =>
    expect(isDiagnosticId(value)).toBe(false),
  );

  it("accepts canonical nonzero UUIDs without treating them as device identifiers", () => {
    expect(isDiagnosticId(report().report_id)).toBe(true);
    expect(parseDiagnosticReport(report())).toEqual(report());
  });
});

describe("diagnostic normalization without invented observations", () => {
  it("preserves independent false and zero observations, including Chrome blocking scope", () => {
    const value = {
      ...report("full"),
      app_build: 0,
      duration_ms: 0,
      snapshot: {
        kill_switch_requested: true,
        kill_switch_verified: false,
        traffic_blocked: true,
        webrtc_protected: false,
        bytes_sent: 0,
        bytes_received: Number.MAX_SAFE_INTEGER,
        freshness_ms: 0,
        reconnect_count: 0,
        ip_families: ["ipv4", "ipv6"],
      },
      chrome: {
        blocking_scope: "except_excluded",
        exclusions_enabled: false,
        exclusions_count: 0,
        probe_latency_ms: 0,
        retry_after_ms: 0,
        proxy_creation_state: "uncertain",
        proxy_revocation_state: "pending",
      },
      checks: [{ id: "webrtc", result: "failed", duration_ms: 0, age_ms: 0 }],
      events: [{ ...event(), span_id: 0, parent_span_id: 0, duration_ms: 0 }],
    };
    const encoded = serializeDiagnosticReport(value);
    expect(JSON.parse(encoded)).toEqual(value);
    expect(encoded).not.toContain("\n");
    expect(parseDiagnosticReport(encoded)).toEqual(value);
  });

  it("normalizes only the documented optional empty forms and keeps valid empty objects", () => {
    const value = {
      ...report("full"),
      app_build: null,
      protocol: "",
      duration_ms: null,
      error: null,
      environment: { browser_version: "", os_major: null },
      snapshot: { phase: null, ip_families: [], kill_switch_verified: null },
      chrome: {},
      checks: [],
      events: null,
      truncated: undefined,
      dropped_events: undefined,
    };
    const parsed = parseDiagnosticReport(value);
    expect(parsed).toMatchObject({
      environment: {},
      snapshot: {},
      chrome: {},
      truncated: false,
      dropped_events: 0,
    });
    for (const key of ["app_build", "protocol", "duration_ms", "error", "checks", "events"])
      expect(Object.hasOwn(parsed, key)).toBe(false);
    expect(Object.hasOwn(parsed.snapshot!, "kill_switch_verified")).toBe(false);
  });

  it.each([
    { duration_ms: "" },
    { app_build: [] },
    { truncated: "" },
    { dropped_events: "" },
    { environment: [] },
    { chrome: [] },
    { checks: "" },
    { events: "" },
    { snapshot: { traffic_blocked: "" } },
    { snapshot: { bytes_sent: [] } },
  ])("rejects empty values of the wrong type %j", (fields) => {
    expect(() => parseDiagnosticReport({ ...report("full"), ...fields })).toThrow(
      "invalid_diagnostic_report",
    );
  });

  it("reconstructs reports without retaining mutable input references", () => {
    const value = { ...report("full"), events: [event()], snapshot: { ip_families: ["ipv4"] } };
    const parsed = parseDiagnosticReport(value);
    value.events[0]!.stage = "cleanup";
    value.snapshot.ip_families.push("ipv6");
    expect(parsed.events![0]!.stage).toBe("guard_verify");
    expect(parsed.snapshot!.ip_families).toEqual(["ipv4"]);
  });
});

describe("diagnostic authorization and platform boundaries", () => {
  it("requires an error for simple and manual consent for full", () => {
    expect(() => parseDiagnosticReport({ ...report(), error: undefined })).toThrow(
      "invalid_diagnostic_report",
    );
    expect(() =>
      parseDiagnosticReport({
        ...report("full"),
        consent: { mode: "automatic_opt_in", notice_version: 1 },
      }),
    ).toThrow("invalid_diagnostic_report");
    expect(
      parseDiagnosticReport({
        ...report(),
        consent: { mode: "automatic_opt_in", notice_version: 1 },
      }).consent.mode,
    ).toBe("automatic_opt_in");
    expect(parseDiagnosticReport({ ...report("full"), error: null }).error).toBeUndefined();
  });

  it.each(["snapshot", "checks", "events", "chrome", "repairs", "windows"])(
    "rejects %s in simple even when represented as null or empty",
    (key) => {
      for (const value of [null, [], {}])
        expect(() => parseDiagnosticReport({ ...report(), [key]: value })).toThrow(
          "invalid_diagnostic_report",
        );
    },
  );

  it.each([
    { platform: "windows" },
    { protocol: "wireguard" },
    { protocol: "openvpn" },
    { windows: null },
    { repairs: [] },
    { environment: { windows_build: 1 } },
    { environment: { android_sdk: 35 } },
    { snapshot: { always_on: false } },
    { snapshot: { lockdown: false } },
    { snapshot: { owned_by_another_user: false } },
    { error: { ...report().error, native: { domain: "errno", code: 0 } } },
  ])("rejects foreign platform fields %j", (fields) => {
    expect(() => parseDiagnosticReport({ ...report("full"), ...fields })).toThrow(
      "invalid_diagnostic_report",
    );
  });

  it("requires consistent truncation flags without inventing dropped events", () => {
    expect(() => parseDiagnosticReport({ ...report(), truncated: true })).toThrow(
      "invalid_diagnostic_report",
    );
    expect(() => parseDiagnosticReport({ ...report("full"), dropped_events: 1 })).toThrow(
      "invalid_diagnostic_report",
    );
    expect(
      parseDiagnosticReport({ ...report("full"), truncated: true, dropped_events: 0 }).truncated,
    ).toBe(true);
    expect(
      parseDiagnosticReport({ ...report("full"), truncated: true, dropped_events: 1 })
        .dropped_events,
    ).toBe(1);
  });
});

describe("bounded diagnostic events and measurements", () => {
  it("accepts 200 events and ten-minute boundary offsets, rejects larger collections and windows", () => {
    const events = Array.from({ length: 200 }, (_, index) =>
      event(index === 199 ? DIAGNOSTIC_EVENT_WINDOW_MS : index),
    );
    expect(parseDiagnosticReport({ ...report("full"), events }).events).toHaveLength(200);
    expect(() =>
      parseDiagnosticReport({ ...report("full"), events: [...events, event()] }),
    ).toThrow("invalid_diagnostic_report");
    for (const offset of [-1, 600_001, 0.1, "0", null, undefined])
      expect(() =>
        parseDiagnosticReport({ ...report("full"), events: [{ ...event(), offset_ms: offset }] }),
      ).toThrow("invalid_diagnostic_report");
  });

  it("accepts 64 checks but never a 65th check", () => {
    const checks = Array.from({ length: 64 }, () => ({ id: "connectivity", result: "skipped" }));
    expect(parseDiagnosticReport({ ...report("full"), checks }).checks).toHaveLength(64);
    expect(() =>
      parseDiagnosticReport({ ...report("full"), checks: [...checks, checks[0]] }),
    ).toThrow("invalid_diagnostic_report");
  });

  it.each([
    { occurrences: 0 },
    { occurrences: 1_000_001 },
    { occurrences: 1.1 },
    { app_build: 2_147_483_648 },
    { duration_ms: DIAGNOSTIC_MAX_DURATION_MS + 1 },
    { duration_ms: -1 },
    { duration_ms: NaN },
    { snapshot: { bytes_received: Number.MAX_SAFE_INTEGER + 1 } },
    { snapshot: { bytes_sent: -1 } },
    { snapshot: { reconnect_count: 1_000_001 } },
    { snapshot: { ip_families: ["ipv4", "ipv4"] } },
    { snapshot: { ip_families: ["192.0.2.1"] } },
    { chrome: { exclusions_count: 10_001 } },
    { environment: { os_major: 0 } },
    { events: [{ ...event(), span_id: 2001 }] },
    { error: { ...report().error, http_status: 99 } },
    { error: { ...report().error, http_status: 600 } },
  ])("rejects invalid numeric or list observation %j", (fields) => {
    expect(() => parseDiagnosticReport({ ...report("full"), ...fields })).toThrow(
      "invalid_diagnostic_report",
    );
  });

  it.each(["simple", "full"] as const)(
    "bounds received JSON bytes for %s independently of normalized size",
    (type) => {
      const compact = serializeDiagnosticReport(report(type));
      const limit = type === "simple" ? DIAGNOSTIC_SIMPLE_MAX_BYTES : DIAGNOSTIC_FULL_MAX_BYTES;
      const exact = compact + " ".repeat(limit - compact.length);
      expect(parseDiagnosticReport(exact)).toEqual(report(type));
      expect(() => parseDiagnosticReport(exact + " ")).toThrow("invalid_diagnostic_report");
    },
  );

  it("rejects a large raw simple body even if optional nulls normalize away", () => {
    const compact = JSON.stringify({ ...report(), environment: null });
    expect(() => parseDiagnosticReport(compact + " ".repeat(DIAGNOSTIC_SIMPLE_MAX_BYTES))).toThrow(
      "invalid_diagnostic_report",
    );
  });
});

describe("technical version and timestamp grammar", () => {
  it.each([
    "1.2.3",
    "1.2.3.4",
    "1.2.3-beta.2",
    "1.2.3+123",
    "0.0.0+rc.00001",
    "99999.99999.99999-dev",
  ])("accepts technical application version %s", (app_version) =>
    expect(parseDiagnosticReport({ ...report(), app_version }).app_version).toBe(app_version),
  );

  it.each([
    "01.2.3",
    "1.2",
    "1.2.3.4.5",
    "1.2.3-client",
    "1.2.3+12345678901",
    "Fuze 1.2.3",
    "1.2.3@example.invalid",
    "1.2.3\u0000",
    "é.2.3",
  ])("rejects nontechnical application version %j", (app_version) =>
    expect(() => parseDiagnosticReport({ ...report(), app_version })).toThrow(
      "invalid_diagnostic_report",
    ),
  );

  it("uses the separate numeric component version grammar", () => {
    for (const browser_version of ["141", "141.0", "141.0.0.0", "00001.0"])
      expect(
        parseDiagnosticReport({ ...report(), environment: { browser_version } }).environment!
          .browser_version,
      ).toBe(browser_version);
    for (const browser_version of ["Chrome 141", "141-beta", "141.0.0.0.0", "100000"])
      expect(() =>
        parseDiagnosticReport({ ...report(), environment: { browser_version } }),
      ).toThrow("invalid_diagnostic_report");
  });

  it("normalizes timezone and fractional seconds without discarding submillisecond precision", () => {
    expect(
      parseDiagnosticReport({ ...report(), created_at: "2026-09-16T14:00:00.123456700+02:00" })
        .created_at,
    ).toBe("2026-09-16T12:00:00.1234567Z");
    expect(
      parseDiagnosticReport({ ...report(), created_at: "2024-02-29T12:00:00.000Z" }).created_at,
    ).toBe("2024-02-29T12:00:00Z");
  });

  it.each([
    "2026-02-29T12:00:00Z",
    "2026-04-31T12:00:00Z",
    "2026-09-16",
    "2026-09-16T12:00:00",
    "2026-09-16T24:00:00Z",
    "1999-12-31T23:59:59Z",
    "2101-01-01T00:00:00Z",
    "2026-09-16T12:00:00+24:00",
  ])("rejects invalid or unbounded collection timestamp %s", (created_at) =>
    expect(() => parseDiagnosticReport({ ...report(), created_at })).toThrow(
      "invalid_diagnostic_report",
    ),
  );
});

describe("diagnostic secret and malformed data rejection", () => {
  it.each([
    { access_token: "synthetic" },
    { profile: { email: "client@example.invalid" } },
    { chrome: { exclusions: ["example.invalid"] } },
    { chrome: { controlled_by: "named-extension" } },
    { environment: { hostname: "workstation" } },
    { snapshot: { ip_address: "192.0.2.1" } },
    { error: { ...report().error, message: "synthetic stack" } },
    { events: [{ ...event(), message: "synthetic log" }] },
    { checks: [{ id: "connectivity", result: "passed", path: "C:/synthetic" }] },
    { consent: { mode: "manual", notice_version: 1, account: "synthetic" } },
    { Error: report().error },
    { reportId: report().report_id },
  ])("rejects the whole report containing forbidden data %j", (fields) => {
    expect(() => serializeDiagnosticReport({ ...report("full"), ...fields })).toThrow(
      "invalid_diagnostic_report",
    );
  });

  it("rejects duplicate keys even when escaped or nested", () => {
    const compact = serializeDiagnosticReport(report());
    for (const text of [
      compact.replace('"schema_version":1', '"schema_version":1,"schema_version":1'),
      compact.replace('"schema_version":1', '"schema_version":1,"schema_versio\\u006e":1'),
      compact.replace('"notice_version":1', '"notice_version":1,"notice_version":1'),
    ])
      expect(() => parseDiagnosticReport(text)).toThrow("invalid_diagnostic_report");
  });

  it("allows repeated key names in different array elements", () => {
    const input = { ...report("full"), events: [event(), event(1)] };
    expect(parseDiagnosticReport(JSON.stringify(input))).toEqual(input);
  });

  it("never calls getters or custom serializers and reports only a fixed safe error", () => {
    const getter = vi.fn(() => "sensitive-value");
    const input = report();
    Object.defineProperty(input, "app_version", { enumerable: true, get: getter });
    expect(() => parseDiagnosticReport(input)).toThrow(new Error("invalid_diagnostic_report"));
    expect(getter).not.toHaveBeenCalled();
    const toJSON = vi.fn(() => report());
    expect(() => parseDiagnosticReport({ ...report(), toJSON })).toThrow(
      "invalid_diagnostic_report",
    );
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("rejects non-JSON values, prototype extras, malformed JSON, holes and cycles", () => {
    const cyclic: Record<string, unknown> = { ...report() };
    cyclic.self = cyclic;
    const inherited: unknown = Object.assign(Object.create({ secret: "synthetic" }), report());
    for (const input of [
      undefined,
      null,
      [],
      new Date(),
      inherited,
      cyclic,
      "{}{}",
      "{",
      "null",
      JSON.stringify(report()) + "{}",
      { ...report(), [Symbol("secret")]: "synthetic" },
      { ...report("full"), events: new Array(2) },
    ])
      expect(() => parseDiagnosticReport(input)).toThrow("invalid_diagnostic_report");
  });
});
