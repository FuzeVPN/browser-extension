// SPDX-License-Identifier: MPL-2.0

import {
  DIAGNOSTIC_STAGES,
  isDiagnosticCode,
  type DiagnosticEvent,
} from "../shared/diagnostic-report";

interface HistoryItem {
  at: number;
  event: DiagnosticEvent;
}
interface HistoryData {
  owner: string | null;
  /** Replaced on every reset; state derived from this history is bound to it. */
  id: string;
  items: HistoryItem[];
  losses: { at: number; count: number }[];
}

const HISTORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class DiagnosticHistory {
  private data: HistoryData = { owner: null, id: crypto.randomUUID(), items: [], losses: [] };
  private writes: Promise<void> = Promise.resolve();
  private revision = 0;
  private persistedRevision = -1;
  constructor(
    private readonly dependencies: {
      read(): Promise<unknown>;
      write(value: unknown): Promise<void>;
      now(): number;
    },
  ) {}

  async initialize(owner: string | null): Promise<void> {
    const raw = await this.dependencies.read();
    this.data = { owner, id: crypto.randomUUID(), items: [], losses: [] };
    this.revision++;
    if (!raw || typeof raw !== "object") return this.persist();
    const stored = raw as Partial<HistoryData>;
    if (stored.owner !== owner || !Array.isArray(stored.items)) return this.persist();
    if (typeof stored.id === "string" && HISTORY_ID.test(stored.id)) this.data.id = stored.id;
    this.data.items = stored.items.slice(-200).flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Partial<HistoryItem>;
      if (typeof candidate.at !== "number" || !Number.isFinite(candidate.at)) return [];
      const event = safeEvent(candidate.event);
      return event ? [{ at: candidate.at, event }] : [];
    });
    if (Array.isArray(stored.losses))
      this.data.losses = stored.losses.slice(-601).flatMap((item: unknown) => {
        if (!item || typeof item !== "object") return [];
        const value = item as { at?: unknown; count?: unknown };
        return typeof value.at === "number" &&
          Number.isSafeInteger(value.at) &&
          value.at % 1000 === 0 &&
          typeof value.count === "number" &&
          Number.isSafeInteger(value.count) &&
          value.count > 0 &&
          value.count <= 1_000_000
          ? [{ at: value.at, count: value.count }]
          : [];
      });
    this.prune();
    await this.persist();
  }

  clear(owner: string | null): Promise<void> {
    // A new id durably invalidates derived state whose own purge failed to persist.
    this.data = { owner, id: crypto.randomUUID(), items: [], losses: [] };
    this.revision++;
    return this.persist();
  }

  /** Identifies the current history window until its next reset. */
  id(): string {
    return this.data.id;
  }

  record(event: DiagnosticEvent): Promise<void> {
    const safe = safeEvent(event);
    if (!safe) return Promise.resolve();
    this.prune();
    this.data.items.push({ at: this.dependencies.now(), event: safe });
    this.revision++;
    if (this.data.items.length > 200) {
      const removed = this.data.items.shift();
      if (!removed) return this.persist();
      const at = Math.floor(removed.at / 1000) * 1000;
      const bucket = this.data.losses.find((loss) => loss.at === at);
      if (bucket) bucket.count = Math.min(1_000_000, bucket.count + 1);
      else this.data.losses.push({ at, count: 1 });
    }
    return this.persist();
  }

  snapshot(): { events: DiagnosticEvent[]; dropped: number } {
    if (this.prune()) void this.persist().catch(() => undefined);
    const start = this.data.items[0]?.at ?? this.dependencies.now();
    return {
      events: this.data.items.map(({ at, event }) => ({
        ...event,
        offset_ms: Math.max(0, Math.min(600_000, Math.round(at - start))),
      })),
      dropped: Math.min(
        1_000_000,
        this.data.losses.reduce((sum, loss) => sum + loss.count, 0),
      ),
    };
  }

  pruneExpired(): Promise<void> {
    this.prune();
    return this.revision === this.persistedRevision ? this.writes : this.persist();
  }

  /** Read-only deadline, including a bounded retry for an unpersisted purge. */
  nextExpiry(): number | null {
    const deadlines = [...this.data.items, ...this.data.losses].map(
      (item) => Math.floor(item.at / 1000) * 1000 + 600_001,
    );
    if (this.revision !== this.persistedRevision) deadlines.push(this.dependencies.now() + 60_000);
    return deadlines.length ? Math.min(...deadlines) : null;
  }

  private prune(): boolean {
    const now = this.dependencies.now();
    // Whole-second window boundaries keep loss counts exact with at most 601 buckets.
    const cutoff = Math.ceil((now - 600_000) / 1000) * 1000;
    const items = this.data.items.filter((item) => item.at >= cutoff && item.at <= now);
    const losses = this.data.losses.filter((loss) => loss.at >= cutoff && loss.at <= now);
    if (items.length === this.data.items.length && losses.length === this.data.losses.length)
      return false;
    this.data.items = items;
    this.data.losses = losses;
    this.revision++;
    return true;
  }

  private persist(): Promise<void> {
    this.writes = this.writes
      .catch(() => undefined)
      .then(async () => {
        const revision = this.revision;
        await this.dependencies.write(structuredClone(this.data));
        this.persistedRevision = revision;
      });
    return this.writes;
  }
}

function safeEvent(value: unknown): DiagnosticEvent | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.stage !== "string" || !DIAGNOSTIC_STAGES.some((stage) => stage === item.stage))
    return null;
  if (
    typeof item.event !== "string" ||
    !["begin", "end", "error", "waiting", "retry", "cancelled", "info"].includes(item.event)
  )
    return null;
  const result: DiagnosticEvent = {
    source: "controller",
    stage: item.stage as DiagnosticEvent["stage"],
    event: item.event as DiagnosticEvent["event"],
    offset_ms: 0,
  };
  if (isDiagnosticCode(item.code)) result.code = item.code;
  if (
    typeof item.duration_ms === "number" &&
    Number.isSafeInteger(item.duration_ms) &&
    item.duration_ms >= 0 &&
    item.duration_ms <= 604_800_000
  )
    result.duration_ms = item.duration_ms;
  if (
    typeof item.http_status === "number" &&
    Number.isInteger(item.http_status) &&
    item.http_status >= 100 &&
    item.http_status <= 599
  )
    result.http_status = item.http_status;
  return result;
}
