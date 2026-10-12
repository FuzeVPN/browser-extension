// SPDX-License-Identifier: MPL-2.0

import type { AppErrorCode, MachineState } from "./state";

export const DIAGNOSTIC_SIMPLE_MAX_BYTES = 8_192;
export const DIAGNOSTIC_FULL_MAX_BYTES = 131_072;
export const DIAGNOSTIC_MAX_EVENTS = 200;
export const DIAGNOSTIC_EVENT_WINDOW_MS = 600_000;
export const DIAGNOSTIC_MAX_CHECKS = 64;
export const DIAGNOSTIC_MAX_DURATION_MS = 604_800_000;

export const DIAGNOSTIC_CODES = [
  "invalid_credentials",
  "login_requires_disconnect",
  "storage_unavailable",
  "unauthorized",
  "email_verification_required",
  "verification_email_cooldown",
  "subscription_required",
  "device_limit",
  "device_identity_revoked",
  "device_proof_invalid",
  "device_proof_replayed",
  "invalid_device",
  "device_exists",
  "not_found",
  "invalid_location",
  "rate_limited",
  "proxy_unavailable",
  "proxy_creation_uncertain",
  "api_token_expired",
  "network_error",
  "request_timeout",
  "invalid_response",
  "proxy_certificate_invalid",
  "proxy_controlled_by_extension",
  "proxy_controlled_by_policy",
  "proxy_authentication_failed",
  "session_expired",
  "traffic_guard_failed",
  "webrtc_control_unavailable",
  "email_delivery_unavailable",
  "unknown_error",
] as const satisfies readonly AppErrorCode[];

export const DIAGNOSTIC_STAGES = [
  "unknown",
  "startup",
  "storage",
  "authentication",
  "api_request",
  "api_response",
  "enrollment",
  "profile_create",
  "profile_revoke",
  "certificate",
  "certificate_renewal",
  "driver_check",
  "service_start",
  "tunnel_start",
  "handshake",
  "adapter_create",
  "addresses_apply",
  "routes_apply",
  "dns_apply",
  "mtu_apply",
  "postconditions",
  "proxy_configuration",
  "guard_verify",
  "webrtc_check",
  "network_check",
  "disconnect",
  "cleanup",
  "recovery",
  "repair",
  "completed",
] as const;

const STATES = [
  "unknown",
  "disconnected",
  "connecting",
  "connected",
  "disconnecting",
  "error",
  "degraded",
  "recovering",
] as const;
const DOMAINS = [
  "api",
  "system",
  "tunnel",
  "storage",
  "protection",
  "proxy",
  "client",
  "unknown",
] as const;
const OPERATIONS = [
  "unknown",
  "startup",
  "authenticate",
  "register",
  "connect",
  "disconnect",
  "refresh",
  "probe",
  "restore",
  "renew",
  "update",
  "repair",
] as const;
const CHECK_IDS = [
  "unknown",
  "api_reachability",
  "service_availability",
  "driver_availability",
  "secure_storage",
  "tunnel_configuration",
  "tunnel_connection",
  "handshake",
  "routing",
  "dns",
  "ipv4",
  "ipv6",
  "kill_switch",
  "webrtc",
  "proxy_settings",
  "certificate",
  "cleanup",
  "connectivity",
  "permissions",
] as const;
const CHECK_RESULTS = ["passed", "failed", "skipped", "unknown"] as const;
const PROXY_STATES = ["none", "pending", "confirmed", "uncertain", "failed", "unknown"] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];
export type DiagnosticStage = (typeof DIAGNOSTIC_STAGES)[number];
export type DiagnosticState = (typeof STATES)[number];

export interface DiagnosticError {
  domain: (typeof DOMAINS)[number];
  code: DiagnosticCode;
  operation: (typeof OPERATIONS)[number];
  stage: DiagnosticStage;
  http_status?: number;
}

export interface DiagnosticEvent {
  source: "app" | "native" | "flutter" | "controller" | "api" | "system";
  stage: DiagnosticStage;
  event: "begin" | "end" | "error" | "waiting" | "retry" | "cancelled" | "info";
  offset_ms: number;
  duration_ms?: number;
  code?: DiagnosticCode;
  http_status?: number;
  span_id?: number;
  parent_span_id?: number;
}

export interface DiagnosticCheck {
  id: (typeof CHECK_IDS)[number];
  result: (typeof CHECK_RESULTS)[number];
  code?: DiagnosticCode;
  duration_ms?: number;
  age_ms?: number;
}

export interface DiagnosticEnvironment {
  architecture?: "x64" | "x86" | "arm64" | "armv7" | "unknown";
  os_family?: "windows" | "android" | "macos" | "linux" | "chromeos" | "unknown";
  os_major?: number;
  network_type?: "wifi" | "cellular" | "ethernet" | "none" | "unknown";
  browser_name?: "chrome" | "chromium" | "edge" | "brave" | "opera" | "unknown";
  browser_version?: string;
}

export interface DiagnosticSnapshot {
  phase?: DiagnosticStage;
  ip_families?: ("ipv4" | "ipv6")[];
  kill_switch_requested?: boolean;
  kill_switch_verified?: boolean;
  traffic_blocked?: boolean;
  webrtc_protected?: boolean;
  handshake_age_ms?: number;
  connection_duration_ms?: number;
  freshness_ms?: number;
  bytes_sent?: number;
  bytes_received?: number;
  reconnect_count?: number;
  recovery_state?: "none" | "pending" | "retrying" | "succeeded" | "failed" | "unknown";
  certificate_state?:
    "missing" | "valid" | "expiring" | "renewing" | "expired" | "revoked" | "unknown";
  cleanup_state?: "not_requested" | "pending" | "completed" | "failed" | "unknown";
}

export interface FirefoxDiagnosticDetails {
  blocking_scope?: "none" | "all" | "except_excluded" | "unverified";
  exclusions_enabled?: boolean;
  exclusions_count?: number;
  exclusions_state?: "disabled" | "pending" | "applied" | "failed" | "unknown";
  controlled_by?: "self" | "extension" | "policy" | "unknown";
  proxy_creation_state?: (typeof PROXY_STATES)[number];
  proxy_revocation_state?: (typeof PROXY_STATES)[number];
  probe_result?: "passed" | "failed" | "unknown" | "not_run";
  probe_latency_ms?: number;
  retry_after_ms?: number;
}

export interface DiagnosticReport {
  schema_version: 1;
  report_id: string;
  report_type: "simple" | "full";
  platform: "chrome_extension";
  app_version: string;
  app_build?: number;
  created_at: string;
  consent: { mode: "manual" | "automatic_opt_in"; notice_version: 1 };
  protocol?: "unknown" | "browser_proxy";
  state: DiagnosticState;
  occurrences: number;
  error?: DiagnosticError;
  duration_ms?: number;
  environment?: DiagnosticEnvironment;
  snapshot?: DiagnosticSnapshot;
  checks?: DiagnosticCheck[];
  events?: DiagnosticEvent[];
  chrome?: FirefoxDiagnosticDetails;
  truncated: boolean;
  dropped_events: number;
}

export function isDiagnosticCode(value: unknown): value is DiagnosticCode {
  return typeof value === "string" && DIAGNOSTIC_CODES.some((code) => code === value);
}

export function isDiagnosticId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) &&
    value !== "00000000-0000-0000-0000-000000000000"
  );
}

export function normalizeDiagnosticState(state: MachineState): DiagnosticState {
  switch (state) {
    case "logged_out":
      return "disconnected";
    case "refreshing":
      return "recovering";
    case "blocked":
      return "degraded";
    default:
      return state;
  }
}

type Reader = ((value: unknown) => unknown) & { empty?: "string" | "array" };
interface Field {
  read: Reader;
  required?: boolean;
  fallback?: unknown;
}
type Schema<T> = { [K in keyof T]-?: Field };

function invalid(): never {
  throw new Error("invalid_diagnostic_report");
}
function enumeration(values: readonly (string | number)[]): Reader {
  const read: Reader = (value) => {
    if (!values.some((item) => item === value)) invalid();
    return value;
  };
  if (values.every((value) => typeof value === "string")) read.empty = "string";
  return read;
}
function integer(min: number, max: number): Reader {
  return (value) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
      invalid();
    return value;
  };
}
const boolean: Reader = (value) => {
  if (typeof value !== "boolean") invalid();
  return value;
};
const code: Reader = (value) => {
  if (!isDiagnosticCode(value)) invalid();
  return value;
};
code.empty = "string";
const duration = integer(0, DIAGNOSTIC_MAX_DURATION_MS);
const httpStatus = integer(100, 599);
const stage = enumeration(DIAGNOSTIC_STAGES);
const optional = (read: Reader): Field => ({ read });
const required = (read: Reader): Field => ({ read, required: true });

function object<T>(value: unknown, schema: Schema<T>): T {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  const fields = schema as Record<string, Field>;
  for (const key of Object.keys(input)) if (!Object.hasOwn(fields, key)) invalid();
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    const current = Object.hasOwn(input, key) ? input[key] : undefined;
    if (
      current === undefined ||
      current === null ||
      (current === "" && field.read.empty === "string") ||
      (Array.isArray(current) && current.length === 0 && field.read.empty === "array")
    ) {
      if (field.required) invalid();
      if (field.fallback !== undefined) result[key] = field.fallback;
      continue;
    }
    result[key] = field.read(current);
  }
  return result as T;
}

function list(read: Reader, max: number, unique = false): Reader {
  const readList: Reader = (value) => {
    if (!Array.isArray(value) || value.length > max) invalid();
    const items = value.map((item: unknown) => read(item));
    if (unique && new Set(items).size !== items.length) invalid();
    return items;
  };
  readList.empty = "array";
  return readList;
}

const errorSchema: Schema<DiagnosticError> = {
  domain: required(enumeration(DOMAINS)),
  code: required(code),
  operation: required(enumeration(OPERATIONS)),
  stage: required(stage),
  http_status: optional(httpStatus),
};
const eventSchema: Schema<DiagnosticEvent> = {
  source: required(enumeration(["app", "native", "flutter", "controller", "api", "system"])),
  stage: required(stage),
  event: required(enumeration(["begin", "end", "error", "waiting", "retry", "cancelled", "info"])),
  offset_ms: required(integer(0, DIAGNOSTIC_EVENT_WINDOW_MS)),
  duration_ms: optional(duration),
  code: optional(code),
  http_status: optional(httpStatus),
  span_id: optional(integer(0, 2_000)),
  parent_span_id: optional(integer(0, 2_000)),
};
const checkSchema: Schema<DiagnosticCheck> = {
  id: required(enumeration(CHECK_IDS)),
  result: required(enumeration(CHECK_RESULTS)),
  code: optional(code),
  duration_ms: optional(duration),
  age_ms: optional(duration),
};
const componentVersion: Reader = (value) => {
  if (typeof value !== "string" || !/^[0-9]{1,5}(?:\.[0-9]{1,5}){0,3}$/.test(value)) invalid();
  return value;
};
componentVersion.empty = "string";
const environmentSchema: Schema<DiagnosticEnvironment> = {
  architecture: optional(enumeration(["x64", "x86", "arm64", "armv7", "unknown"])),
  os_family: optional(enumeration(["windows", "android", "macos", "linux", "chromeos", "unknown"])),
  os_major: optional(integer(1, 100)),
  network_type: optional(enumeration(["wifi", "cellular", "ethernet", "none", "unknown"])),
  browser_name: optional(enumeration(["chrome", "chromium", "edge", "brave", "opera", "unknown"])),
  browser_version: optional(componentVersion),
};
const snapshotSchema: Schema<DiagnosticSnapshot> = {
  phase: optional(stage),
  ip_families: optional(list(enumeration(["ipv4", "ipv6"]), 2, true)),
  kill_switch_requested: optional(boolean),
  kill_switch_verified: optional(boolean),
  traffic_blocked: optional(boolean),
  webrtc_protected: optional(boolean),
  handshake_age_ms: optional(duration),
  connection_duration_ms: optional(duration),
  freshness_ms: optional(duration),
  bytes_sent: optional(integer(0, Number.MAX_SAFE_INTEGER)),
  bytes_received: optional(integer(0, Number.MAX_SAFE_INTEGER)),
  reconnect_count: optional(integer(0, 1_000_000)),
  recovery_state: optional(
    enumeration(["none", "pending", "retrying", "succeeded", "failed", "unknown"]),
  ),
  certificate_state: optional(
    enumeration(["missing", "valid", "expiring", "renewing", "expired", "revoked", "unknown"]),
  ),
  cleanup_state: optional(
    enumeration(["not_requested", "pending", "completed", "failed", "unknown"]),
  ),
};
const chromeSchema: Schema<FirefoxDiagnosticDetails> = {
  blocking_scope: optional(enumeration(["none", "all", "except_excluded", "unverified"])),
  exclusions_enabled: optional(boolean),
  exclusions_count: optional(integer(0, 10_000)),
  exclusions_state: optional(enumeration(["disabled", "pending", "applied", "failed", "unknown"])),
  controlled_by: optional(enumeration(["self", "extension", "policy", "unknown"])),
  proxy_creation_state: optional(enumeration(PROXY_STATES)),
  proxy_revocation_state: optional(enumeration(PROXY_STATES)),
  probe_result: optional(enumeration(["passed", "failed", "unknown", "not_run"])),
  probe_latency_ms: optional(duration),
  retry_after_ms: optional(duration),
};

const appVersion: Reader = (value) => {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]{0,4})(?:\.(?:0|[1-9][0-9]{0,4})){2,3}(?:[-+](?:dev|beta|rc)(?:\.[0-9]{1,5})?|\+[0-9]{1,10})?$/.test(
      value,
    )
  )
    invalid();
  return value;
};

function timestamp(value: unknown): string {
  if (typeof value !== "string") invalid();
  const parts =
    /^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(?:\.([0-9]{1,9}))?(Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/.exec(
      value,
    );
  if (!parts) invalid();
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCDate() !== day) invalid();
  const normalized = new Date(value);
  if (
    !Number.isFinite(normalized.getTime()) ||
    normalized.getUTCFullYear() < 2000 ||
    normalized.getUTCFullYear() > 2100
  )
    invalid();
  const fraction = (parts[7] ?? "").replace(/0+$/, "");
  return `${normalized.toISOString().slice(0, 19)}${fraction ? `.${fraction}` : ""}Z`;
}

const reportSchema: Schema<DiagnosticReport> = {
  schema_version: required(enumeration([1])),
  report_id: required((value) => {
    if (!isDiagnosticId(value)) invalid();
    return value;
  }),
  report_type: required(enumeration(["simple", "full"])),
  platform: required(enumeration(["chrome_extension"])),
  app_version: required(appVersion),
  app_build: optional(integer(0, 2_147_483_647)),
  created_at: required(timestamp),
  consent: required((value) =>
    object<DiagnosticReport["consent"]>(value, {
      mode: required(enumeration(["manual", "automatic_opt_in"])),
      notice_version: required(enumeration([1])),
    }),
  ),
  protocol: optional(enumeration(["unknown", "browser_proxy"])),
  state: required(enumeration(STATES)),
  occurrences: required(integer(1, 1_000_000)),
  error: optional((value) => object(value, errorSchema)),
  duration_ms: optional(duration),
  environment: optional((value) => object(value, environmentSchema)),
  snapshot: optional((value) => object(value, snapshotSchema)),
  checks: optional(list((value) => object(value, checkSchema), DIAGNOSTIC_MAX_CHECKS)),
  events: optional(list((value) => object(value, eventSchema), DIAGNOSTIC_MAX_EVENTS)),
  chrome: optional((value) => object(value, chromeSchema)),
  truncated: { read: boolean, fallback: false },
  dropped_events: { read: integer(0, 1_000_000), fallback: 0 },
};

/** Validate JSON data without calling user-defined getters or toJSON methods. */
function validateJsonTree(value: unknown, depth = 0, ancestors = new Set<object>()): void {
  if (depth > 12) invalid();
  if (value === null || value === undefined || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
    return;
  }
  if (typeof value === "string") {
    // Every permitted Chrome value is ASCII vocabulary, a version, an UUID or a date.
    if (value.length > 128 || /[^\x20-\x7e]/.test(value)) invalid();
    return;
  }
  if (typeof value !== "object" || ancestors.has(value)) invalid();
  const array = Array.isArray(value);
  if (
    array
      ? value.length > 2_000
      : Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null
  )
    invalid();
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    if (typeof key !== "string" || key.length > 64 || /[^\x20-\x7e]/.test(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
    if (
      array &&
      (!/^(?:0|[1-9][0-9]*)$/.test(key) ||
        Number(key) >= value.length ||
        descriptor.value === undefined)
    )
      invalid();
    validateJsonTree(descriptor.value, depth + 1, ancestors);
  }
  if (array && Object.keys(value).length !== value.length) invalid();
  ancestors.delete(value);
}

/** JSON.parse discards duplicate keys, so check the original tokens as well. */
function rejectDuplicateKeys(text: string): void {
  const tokens =
    /"(?:[^"\\]|\\.)*"|[{}[\],:]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|\s+/gy;
  const stack: { keys: Set<string> | null; expectingKey: boolean }[] = [];
  let token: RegExpExecArray | null;
  while ((token = tokens.exec(text)) !== null) {
    const item = token[0];
    const current = stack.at(-1);
    if (item === "{" || item === "[") {
      stack.push({ keys: item === "{" ? new Set() : null, expectingKey: item === "{" });
      if (stack.length > 12) invalid();
    } else if (item === "}" || item === "]") stack.pop();
    else if (item === "," && current) current.expectingKey = current.keys !== null;
    else if (item === ":" && current) current.expectingKey = false;
    else if (item.startsWith('"') && current?.expectingKey && current.keys) {
      const key: unknown = JSON.parse(item);
      if (typeof key !== "string" || current.keys.has(key)) invalid();
      current.keys.add(key);
      current.expectingKey = false;
    }
  }
}

/** Closed Chrome subset: never sanitizes unknown fields into a sendable report. */
export function parseDiagnosticReport(value: unknown): DiagnosticReport {
  try {
    let input: unknown = value;
    let original: string;
    if (typeof value === "string") {
      if (new TextEncoder().encode(value).byteLength > DIAGNOSTIC_FULL_MAX_BYTES) invalid();
      input = JSON.parse(value) as unknown;
      rejectDuplicateKeys(value);
      original = value;
    } else {
      validateJsonTree(input);
      original = JSON.stringify(input);
    }
    validateJsonTree(input);
    const report = object(input, reportSchema);
    if (report.report_type === "simple") {
      if (!report.error || report.truncated || report.dropped_events !== 0) invalid();
      for (const key of ["snapshot", "checks", "events", "chrome"]) {
        if (Object.hasOwn(input as object, key)) invalid();
      }
    } else if (report.consent.mode !== "manual") invalid();
    if (report.dropped_events > 0 && !report.truncated) invalid();
    const limit =
      report.report_type === "simple" ? DIAGNOSTIC_SIMPLE_MAX_BYTES : DIAGNOSTIC_FULL_MAX_BYTES;
    const encoder = new TextEncoder();
    // ASCII-only emitted fields avoid a size mismatch with the server's canonical escaping.
    if (
      encoder.encode(original).byteLength > limit ||
      encoder.encode(JSON.stringify(report)).byteLength > limit
    )
      invalid();
    return report;
  } catch {
    return invalid();
  }
}

export function serializeDiagnosticReport(value: unknown): string {
  return JSON.stringify(parseDiagnosticReport(value));
}
