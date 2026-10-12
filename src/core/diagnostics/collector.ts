// SPDX-License-Identifier: MPL-2.0

import { detectBrowserEnvironment } from "../shared/browser-environment";
import { extensionApi } from "@platform/bridge";
import type { AppSnapshot } from "../shared/state";
import type { SecurityStatus } from "../shared/security";
import type { NetworkObservation } from "../shared/network";
import type { ProxyControlLevel } from "../background/proxy-controller";
import {
  isDiagnosticCode,
  normalizeDiagnosticState,
  parseDiagnosticReport,
  type DiagnosticCheck,
  type DiagnosticError,
  type DiagnosticEnvironment,
  type DiagnosticEvent,
  type DiagnosticReport,
  type DiagnosticSnapshot,
  type FirefoxDiagnosticDetails,
} from "../shared/diagnostic-report";

export interface DiagnosticReadModel {
  snapshot: AppSnapshot;
  safety: SecurityStatus;
  reconnectAttempts: number;
  proxyCreationUncertain: boolean;
  proxyCleanupUncertain: boolean;
}

export function diagnosticError(
  code: unknown,
  operation: DiagnosticError["operation"] = "unknown",
): DiagnosticError {
  // UI-only hints stay local; the API keeps its existing closed vocabulary.
  const normalized =
    code === "private_browsing_required" || code === "host_permissions_required"
      ? "proxy_controlled_by_policy"
      : code === "device_revoked_limit"
        ? "device_limit"
        : code === "server_full"
          ? "invalid_location"
          : code === "capacity_unavailable"
            ? "proxy_unavailable"
            : code;
  const safe = isDiagnosticCode(normalized) ? normalized : "unknown_error";
  let domain: DiagnosticError["domain"] = "client";
  let stage: DiagnosticError["stage"] = "unknown";
  if (safe === "storage_unavailable") {
    domain = "storage";
    stage = "storage";
  } else if (safe === "traffic_guard_failed") {
    domain = "protection";
    stage = "guard_verify";
  } else if (safe === "webrtc_control_unavailable") {
    domain = "protection";
    stage = "webrtc_check";
  } else if (safe.startsWith("proxy_")) {
    domain = "proxy";
    stage = safe === "proxy_certificate_invalid" ? "certificate" : "proxy_configuration";
  } else if (
    ["network_error", "request_timeout", "invalid_response", "rate_limited"].includes(safe)
  ) {
    domain = "api";
    stage = safe === "invalid_response" ? "api_response" : "api_request";
  } else if (safe !== "unknown_error") {
    domain = "api";
    stage = "authentication";
  }
  return { domain, code: safe, operation, stage };
}

export function diagnosticOperation(command: string): DiagnosticError["operation"] {
  if (command === "login" || command === "web_login") return "authenticate";
  if (["connect", "change_location", "retry_connection"].includes(command)) return "connect";
  if (["disconnect", "logout"].includes(command)) return "disconnect";
  if (["initialize", "runtime.onStartup", "runtime.onInstalled"].includes(command))
    return "startup";
  if (command === "refresh_network") return "probe";
  if (command === "proxy_authentication") return "connect";
  if (command.startsWith("refresh_") || command === "alarms.onAlarm") return "refresh";
  if (command.startsWith("update_") || command.startsWith("retry_site")) return "update";
  return "unknown";
}

export function operationStage(operation: DiagnosticError["operation"]): DiagnosticError["stage"] {
  switch (operation) {
    case "authenticate":
      return "authentication";
    case "connect":
      return "proxy_configuration";
    case "disconnect":
      return "disconnect";
    case "startup":
      return "startup";
    case "probe":
      return "network_check";
    case "refresh":
      return "recovery";
    default:
      return "unknown";
  }
}

export function reportBase(
  id: string,
  now: number,
  version: string,
  state: AppSnapshot["status"],
  type: "simple" | "full",
  environment: DiagnosticEnvironment,
): DiagnosticReport {
  return {
    schema_version: 1,
    report_id: id,
    report_type: type,
    platform: "chrome_extension",
    app_version: version,
    created_at: new Date(now).toISOString(),
    consent: { mode: type === "full" ? "manual" : "automatic_opt_in", notice_version: 1 },
    protocol: "browser_proxy",
    state: normalizeDiagnosticState(state),
    occurrences: 1,
    environment,
    truncated: false,
    dropped_events: 0,
  };
}

export interface CollectorDependencies {
  read(): DiagnosticReadModel;
  inspectSafety(): Promise<SecurityStatus>;
  inspectWebRtc(): Promise<boolean>;
  getProxyControl(): Promise<ProxyControlLevel>;
  verifyProxy(): Promise<boolean | null>;
  probe(): Promise<NetworkObservation>;
  now(): number;
}

/** Manual checks are reads and the existing bounded network probe only. */
export async function collectDiagnostic(
  dependencies: CollectorDependencies,
  base: DiagnosticReport,
  history: { events: DiagnosticEvent[]; dropped: number },
): Promise<DiagnosticReport> {
  const started = dependencies.now();
  const initial = dependencies.read();
  const [guardResult, webRtcResult, controlResult, proxyResult] = await Promise.allSettled([
    dependencies.inspectSafety(),
    dependencies.inspectWebRtc(),
    dependencies.getProxyControl(),
    dependencies.verifyProxy(),
  ]);
  const checks: DiagnosticCheck[] = [];
  const snapshot: DiagnosticSnapshot = {};
  const details: FirefoxDiagnosticDetails = {};
  const guard = guardResult.status === "fulfilled" ? guardResult.value : null;
  if (guard?.blockingScope) details.blocking_scope = guard.blockingScope;
  if (guard && guard.blockingScope !== "unverified" && guard.blockingScope !== undefined) {
    snapshot.kill_switch_verified = guard.filterActive;
    snapshot.traffic_blocked = guard.trafficBlocked;
    checks.push({
      id: "kill_switch",
      result:
        !initial.snapshot.protectionRequested ||
        !initial.snapshot.securityPreferences.killSwitchEnabled
          ? "skipped"
          : guard.filterActive
            ? "passed"
            : "failed",
    });
  } else checks.push({ id: "kill_switch", result: "unknown" });
  if (webRtcResult.status === "fulfilled") {
    snapshot.webrtc_protected = webRtcResult.value;
    checks.push({
      id: "webrtc",
      result:
        !initial.snapshot.protectionRequested ||
        !initial.snapshot.securityPreferences.webRtcProtectionEnabled
          ? "skipped"
          : webRtcResult.value
            ? "passed"
            : "failed",
    });
  } else checks.push({ id: "webrtc", result: "unknown" });
  const verifiedProxy = proxyResult.status === "fulfilled" ? proxyResult.value : null;
  checks.push({
    id: "proxy_settings",
    result: verifiedProxy === null ? "unknown" : verifiedProxy ? "passed" : "failed",
  });
  if (controlResult.status === "fulfilled") {
    const level = controlResult.value;
    details.controlled_by =
      level === "controlled_by_this_extension"
        ? "self"
        : level === "controlled_by_other_extensions"
          ? "extension"
          : level === "not_controllable"
            ? "policy"
            : "unknown";
  }

  const probe = await dependencies.probe().then(
    (value) => ({ value, failed: false }),
    () => ({ value: null, failed: true }),
  );
  const network = probe.value;
  const model = dependencies.read();
  const current = model.snapshot;
  // Do not combine fresh checks with a different route/configuration observed meanwhile.
  const sameRoute =
    initial.snapshot.status === current.status &&
    initial.snapshot.protected === current.protected &&
    initial.snapshot.trafficBlocked === current.trafficBlocked &&
    initial.snapshot.profile?.userId === current.profile?.userId &&
    initial.snapshot.activeLocationId === current.activeLocationId &&
    initial.snapshot.protectionRequested === current.protectionRequested &&
    initial.snapshot.siteExclusions.applied.revision === current.siteExclusions.applied.revision &&
    initial.snapshot.siteExclusions.pending === current.siteExclusions.pending &&
    initial.snapshot.siteExclusions.error === current.siteExclusions.error &&
    initial.snapshot.securityPreferences.killSwitchEnabled ===
      current.securityPreferences.killSwitchEnabled &&
    initial.snapshot.securityPreferences.webRtcProtectionEnabled ===
      current.securityPreferences.webRtcProtectionEnabled;
  if (!sameRoute) {
    delete snapshot.kill_switch_verified;
    delete snapshot.traffic_blocked;
    delete snapshot.webrtc_protected;
    delete details.controlled_by;
    details.blocking_scope = "unverified";
    for (const check of checks) check.result = "unknown";
  }
  snapshot.kill_switch_requested =
    current.protectionRequested && current.securityPreferences.killSwitchEnabled;
  if (
    Number.isSafeInteger(model.reconnectAttempts) &&
    model.reconnectAttempts >= 0 &&
    model.reconnectAttempts <= 1_000_000
  )
    snapshot.reconnect_count = model.reconnectAttempts;
  snapshot.recovery_state =
    current.nextRetryAt !== null
      ? "pending"
      : current.status === "refreshing"
        ? "retrying"
        : "none";
  const exclusions = current.siteExclusions;
  details.exclusions_enabled = exclusions.saved.enabled;
  details.exclusions_count = exclusions.saved.entries.length;
  details.exclusions_state = exclusions.error
    ? "failed"
    : exclusions.pending
      ? "pending"
      : exclusions.applied.enabled
        ? "applied"
        : "disabled";
  details.proxy_creation_state = model.proxyCreationUncertain
    ? "uncertain"
    : verifiedProxy === true && sameRoute
      ? "confirmed"
      : "unknown";
  details.proxy_revocation_state = model.proxyCleanupUncertain
    ? "uncertain"
    : current.logoutOutcome?.proxySessions === "confirmed"
      ? "confirmed"
      : current.logoutOutcome?.proxySessions === "unconfirmed"
        ? "uncertain"
        : current.logoutOutcome?.proxySessions === "pending"
          ? "pending"
          : "none";
  if (current.nextRetryAt !== null)
    details.retry_after_ms = duration(current.nextRetryAt - dependencies.now());
  const observation = sameRoute ? network : null;
  details.probe_result = !sameRoute
    ? "unknown"
    : probe.failed
      ? "failed"
      : observation?.status === "ready"
        ? "passed"
        : observation?.status === "unavailable"
          ? "failed"
          : observation?.status === "checking"
            ? "unknown"
            : "not_run";
  const probeCheck: DiagnosticCheck = {
    id: "connectivity",
    result: details.probe_result === "not_run" ? "skipped" : details.probe_result,
  };
  if (observation?.checkedAt !== null && observation?.checkedAt !== undefined) {
    probeCheck.age_ms = duration(dependencies.now() - observation.checkedAt);
  }
  if (observation?.latencyMs !== null && observation?.latencyMs !== undefined) {
    details.probe_latency_ms = duration(observation.latencyMs);
    probeCheck.duration_ms = duration(observation.latencyMs);
  }
  checks.push(probeCheck);
  const report: DiagnosticReport = {
    ...base,
    state: normalizeDiagnosticState(current.status),
    ...(current.error ? { error: diagnosticError(current.error, "probe") } : {}),
    duration_ms: duration(dependencies.now() - started),
    snapshot,
    chrome: details,
    checks,
    events: history.events.slice(-200),
    truncated: history.dropped > 0,
    dropped_events: Math.min(1_000_000, history.dropped),
  };
  return parseDiagnosticReport(report);
}

function duration(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 && value <= 604_800_000
    ? Math.round(value)
    : undefined;
}

export async function diagnosticEnvironment(): Promise<DiagnosticEnvironment> {
  const browserEnvironment = await detectBrowserEnvironment();
  const environment: DiagnosticEnvironment = {
    browser_name: browserEnvironment.browserName,
    ...(browserEnvironment.browserVersion
      ? { browser_version: browserEnvironment.browserVersion }
      : {}),
  };
  try {
    const platform = await extensionApi.runtime.getPlatformInfo();
    const systems: Record<string, NonNullable<DiagnosticEnvironment["os_family"]>> = {
      win: "windows",
      mac: "macos",
      linux: "linux",
      cros: "chromeos",
      android: "android",
    };
    environment.os_family = systems[platform.os] ?? "unknown";
    const architectures: Record<string, NonNullable<DiagnosticEnvironment["architecture"]>> = {
      "x86-64": "x64",
      "x86-32": "x86",
      arm: "armv7",
      arm64: "arm64",
    };
    environment.architecture = architectures[platform.arch] ?? "unknown";
  } catch {
    /* Optional environment data remains absent. */
  }
  return environment;
}
