// SPDX-License-Identifier: MPL-2.0

import type { AppErrorCode, MachineState } from "../shared/state";

const ACTIONS = [
  "connect",
  "disconnect",
  "retry_connection",
  "change_location",
  "select_location",
  "select_automatic_location",
  "refresh_account",
  "refresh_locations",
  "get_snapshot",
] as const;
const STATES = [
  "logged_out",
  "disconnected",
  "connecting",
  "connected",
  "refreshing",
  "disconnecting",
  "blocked",
  "error",
] as const satisfies readonly MachineState[];
const ERRORS = [
  "invalid_credentials",
  "login_requires_disconnect",
  "web_login_cancelled",
  "web_login_timeout",
  "web_login_unavailable",
  "web_login_invalid_callback",
  "web_login_denied",
  "web_login_busy",
  "storage_unavailable",
  "unauthorized",
  "email_verification_required",
  "verification_email_cooldown",
  "subscription_required",
  "device_limit",
  "device_revoked_limit",
  "device_identity_revoked",
  "device_proof_invalid",
  "device_proof_replayed",
  "invalid_device",
  "device_exists",
  "not_found",
  "invalid_location",
  "server_full",
  "capacity_unavailable",
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
  "private_browsing_required",
  "host_permissions_required",
  "proxy_authentication_failed",
  "session_expired",
  "traffic_guard_failed",
  "webrtc_control_unavailable",
  "email_delivery_unavailable",
  "unknown_error",
] as const satisfies readonly AppErrorCode[];

export interface ConnectionTrace {
  event: "command" | "state" | "catalog" | "target" | "failure";
  phase?: "start" | "end";
  action?: (typeof ACTIONS)[number];
  operation?: number;
  source?: "automatic" | "requested" | "security" | "persisted" | "local" | "api";
  reason?: "no_target" | "catalog_missing" | "select_missing" | "automatic_empty";
  status?: MachineState;
  error?: AppErrorCode | null;
  httpStatus?: number | null;
  count?: number;
  selectedPresent?: boolean;
  requestedPresent?: boolean;
  protected?: boolean;
  protectionRequested?: boolean;
  trafficBlocked?: boolean;
}

export interface ConnectionEvent extends ConnectionTrace {
  at: number;
  sequence: number;
}

const LIMIT = 200;
const WINDOW_MS = 600_000;
const MAX_SEQUENCE = 1_000_000_000;

/** Local, bounded observations only. Storage failures never reach VPN operations. */
export class ConnectionJournal {
  private events: ConnectionEvent[] = [];
  private pending: Omit<ConnectionEvent, "sequence">[] = [];
  private sequence = 0;
  private initialized = false;
  private cleared = false;
  private writes: Promise<void> = Promise.resolve();
  private writeQueued = false;
  private revision = 0;
  private persistedRevision = -1;
  private generation = 0;
  private readonly ready: Promise<void>;

  constructor(
    private readonly options: {
      storage: {
        read(): Promise<unknown>;
        write(events: ConnectionEvent[]): Promise<void>;
      };
      now(): number;
      onChanged?(): void;
    },
  ) {
    this.ready = this.restore();
  }

  initialize(): Promise<void> {
    return this.ready;
  }

  /** Bind asynchronous work to the history that existed before it started. */
  capture(): (event: ConnectionTrace) => void {
    const generation = this.generation;
    return (event) => {
      try {
        this.record(event, generation);
      } catch {
        /* Even a failing observer implementation cannot affect a command. */
      }
    };
  }

  record(event: ConnectionTrace, generation = this.generation): void {
    try {
      if (generation !== this.generation) return;
      const safe = sanitize(event);
      if (!safe) return;
      const entry = { ...safe, at: this.options.now() };
      if (!integer(entry.at, 0, 8_640_000_000_000_000)) return;
      if (!this.initialized) {
        this.pending.push(entry);
        this.pending = this.pending.slice(-LIMIT);
        this.changed();
        return;
      }
      this.append(entry);
      this.persist();
      this.changed();
    } catch {
      /* Logging is optional, including malformed runtime input. */
    }
  }

  async snapshot(): Promise<ConnectionEvent[]> {
    await this.ready;
    if (this.prune()) this.persist();
    return structuredClone(this.events);
  }

  clear(): void {
    this.generation++;
    this.cleared = true;
    this.events = [];
    this.pending = [];
    this.revision++;
    if (this.initialized) this.persist();
    this.changed();
  }

  count(): number {
    if (this.prune()) this.persist();
    return this.events.length + this.pending.length;
  }

  /** Maintenance is separate from VPN commands and also retries a failed durable purge. */
  async pruneExpired(): Promise<void> {
    await this.ready;
    this.prune();
    if (this.revision !== this.persistedRevision) this.persist();
    await this.writes;
  }

  nextExpiry(): number | null {
    const deadlines = [...this.events, ...this.pending].map((event) => event.at + WINDOW_MS + 1);
    if (this.revision !== this.persistedRevision) deadlines.push(this.options.now() + 60_000);
    return deadlines.length ? Math.min(...deadlines) : null;
  }

  private async restore(): Promise<void> {
    try {
      const stored = await this.options.storage.read();
      if (!this.cleared && Array.isArray(stored)) {
        const now = this.options.now();
        for (const candidate of stored.slice(-LIMIT) as unknown[]) {
          try {
            const safe = sanitize(candidate);
            const value = candidate as Record<string, unknown>;
            if (
              !safe ||
              !integer(value.at, 0, 8_640_000_000_000_000) ||
              value.at < now - WINDOW_MS ||
              value.at > now ||
              !integer(value.sequence, 1, MAX_SEQUENCE) ||
              value.sequence <= this.sequence
            )
              continue;
            this.events.push({ ...safe, at: value.at, sequence: value.sequence });
            this.sequence = value.sequence;
          } catch {
            /* Ignore corrupt stored entries. */
          }
        }
      }
    } catch {
      /* In-memory recording and export still work without session storage. */
    }
    this.initialized = true;
    for (const entry of this.pending) this.append(entry);
    this.pending = [];
    this.prune();
    this.revision++;
    this.persist();
    this.changed();
  }

  private append(entry: Omit<ConnectionEvent, "sequence">): void {
    if (this.sequence >= MAX_SEQUENCE) {
      this.events = this.events.map((event, index) => ({ ...event, sequence: index + 1 }));
      this.sequence = this.events.length;
    }
    this.events.push({ ...entry, sequence: ++this.sequence });
    this.revision++;
    this.prune();
  }

  private prune(): boolean {
    const now = this.options.now();
    const retained = this.events
      .filter((event) => event.at >= now - WINDOW_MS && event.at <= now)
      .slice(-LIMIT);
    const changed = retained.length !== this.events.length;
    this.events = retained;
    if (changed) this.revision++;
    return changed;
  }

  private persist(): void {
    // Coalesce waiting writes and take their snapshot when they start. An old
    // queued snapshot must never repopulate storage after an account/history purge.
    if (this.writeQueued) return;
    this.writeQueued = true;
    this.writes = this.writes
      .then(async () => {
        this.writeQueued = false;
        const revision = this.revision;
        await this.options.storage.write(structuredClone(this.events));
        this.persistedRevision = revision;
      })
      .catch(() => undefined)
      .finally(() => this.changed());
  }

  private changed(): void {
    try {
      this.options.onChanged?.();
    } catch {
      /* Maintenance and observers cannot interrupt VPN operations. */
    }
  }
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function sanitize(value: unknown): ConnectionTrace | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    typeof input.event !== "string" ||
    !["command", "state", "catalog", "target", "failure"].includes(input.event)
  )
    return null;
  const output: Record<string, unknown> = { event: input.event };
  const vocabulary = {
    phase: ["start", "end"],
    action: ACTIONS,
    source: ["automatic", "requested", "security", "persisted", "local", "api"],
    reason: ["no_target", "catalog_missing", "select_missing", "automatic_empty"],
    status: STATES,
    error: ERRORS,
  };
  for (const [key, allowed] of Object.entries(vocabulary))
    if (typeof input[key] === "string" && allowed.some((item) => item === input[key]))
      output[key] = input[key];
  if (input.error === null) output.error = null;
  if (input.httpStatus === null || integer(input.httpStatus, 100, 599))
    output.httpStatus = input.httpStatus;
  if (integer(input.operation, 0, 1_000_000_000)) output.operation = input.operation;
  if (integer(input.count, 0, 1_000_000)) output.count = input.count;
  for (const key of [
    "selectedPresent",
    "requestedPresent",
    "protected",
    "protectionRequested",
    "trafficBlocked",
  ])
    if (typeof input[key] === "boolean") output[key] = input[key];
  return output as unknown as ConnectionTrace;
}
