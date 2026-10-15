// SPDX-License-Identifier: MPL-2.0

export interface IpJournalEntry {
  at: number;
  event: "ready" | "failure" | "browser_error";
  code?:
    | "transport"
    | "http_error"
    | "timeout"
    | "route_unverified"
    | "invalid_response"
    | "rate_limited";
  mode?: "vpn" | "direct";
  durationMs?: number;
  httpStatus?: number | null;
  netError?: string;
}

/** Local-only, bounded, and rebuilt from allowlisted fields before export. */
export class IpJournal {
  private entries: IpJournalEntry[] = [];
  private writes = Promise.resolve();
  readonly ready: Promise<void>;
  constructor(
    private readonly store: {
      read(): Promise<unknown>;
      write(entries: IpJournalEntry[]): Promise<void>;
      now(): number;
    },
  ) {
    this.ready = store
      .read()
      .then((raw) => {
        if (Array.isArray(raw)) {
          this.entries = [...raw.slice(-80).flatMap((value) => this.safe(value)), ...this.entries];
          this.prune();
        }
      })
      .catch(() => undefined);
  }
  record(input: Omit<IpJournalEntry, "at">): void {
    this.entries.push(...this.safe({ ...input, at: this.store.now() }));
    this.prune();
    this.writes = this.writes
      .catch(() => undefined)
      .then(async () => {
        await this.ready;
        this.prune();
        await this.store.write(structuredClone(this.entries));
      })
      .catch(() => undefined);
  }
  async snapshot(): Promise<{ schemaVersion: 1; entries: IpJournalEntry[] }> {
    await this.ready;
    this.prune();
    return { schemaVersion: 1, entries: structuredClone(this.entries) };
  }
  private prune(): void {
    const now = this.store.now();
    this.entries = this.entries
      .filter((entry) => entry.at <= now && entry.at >= now - 600_000)
      .slice(-80);
  }
  private safe(value: unknown): IpJournalEntry[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const v = value as Record<string, unknown>;
    if (
      typeof v.at !== "number" ||
      !Number.isSafeInteger(v.at) ||
      v.at < 0 ||
      (v.event !== "ready" && v.event !== "failure" && v.event !== "browser_error")
    )
      return [];
    const result: IpJournalEntry = { at: v.at, event: v.event };
    if (v.mode === "vpn" || v.mode === "direct") result.mode = v.mode;
    if (
      v.code === "transport" ||
      v.code === "http_error" ||
      v.code === "timeout" ||
      v.code === "route_unverified" ||
      v.code === "invalid_response" ||
      v.code === "rate_limited"
    )
      result.code = v.code;
    if (
      typeof v.durationMs === "number" &&
      Number.isSafeInteger(v.durationMs) &&
      v.durationMs >= 0 &&
      v.durationMs <= 600_000
    )
      result.durationMs = v.durationMs;
    if (
      v.httpStatus === null ||
      (typeof v.httpStatus === "number" &&
        Number.isInteger(v.httpStatus) &&
        v.httpStatus >= 100 &&
        v.httpStatus <= 599)
    )
      result.httpStatus = v.httpStatus;
    if (typeof v.netError === "string" && /^net::ERR_[A-Z0-9_]{1,64}$/.test(v.netError))
      result.netError = v.netError;
    return [result];
  }
}
