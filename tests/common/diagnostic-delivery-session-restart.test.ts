// SPDX-License-Identifier: MPL-2.0

import { DiagnosticDelivery, type DiagnosticAccount } from "../../src/core/diagnostics/delivery";
import type { DiagnosticReport } from "../../src/core/shared/diagnostic-report";

const NOW = Date.parse("2026-09-16T12:00:00Z");
const HOUR = 3_600_000;
const OWNER = "synthetic-account";
const FIRST_TOKEN = "synthetic-token-one";
const SECOND_TOKEN = "synthetic-token-two";
const id = (number: number) => `a1000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

function report(number = 1): DiagnosticReport {
  return {
    schema_version: 1,
    report_id: id(number),
    report_type: "simple",
    platform: "chrome_extension",
    app_version: "1.1.1",
    created_at: new Date(NOW).toISOString(),
    consent: { mode: "manual", notice_version: 1 },
    protocol: "browser_proxy",
    state: "error",
    occurrences: 1,
    error: {
      domain: "proxy",
      code: "proxy_unavailable",
      operation: "connect",
      stage: "proxy_configuration",
    },
    truncated: false,
    dropped_events: 0,
  };
}

function received(clientId: string) {
  return new Response(
    JSON.stringify({
      report_id: "b1000000-0000-4000-8000-000000000001",
      client_report_id: clientId,
      received_at: new Date(NOW).toISOString(),
      expires_at: new Date(NOW + 30 * 24 * HOUR).toISOString(),
      status: "received",
      duplicate: false,
    }),
    { status: 201 },
  );
}

const refused = () => new Response("{}", { status: 401 });

interface Stored {
  accounts: { ownerId: string; sessionRequired?: boolean; rejected?: unknown }[];
  reports: { id: string; status: string }[];
}

/** One worker, over what the browser profile keeps of the deliveries. */
function worker(stored: unknown, token: string) {
  const state = {
    stored,
    account: {
      ownerId: OWNER,
      token,
      expiresAt: NOW + 7 * 24 * HOUR,
      generation: 1,
    } as DiagnosticAccount | null,
  };
  /** The server accepts every token but those it has ended. */
  const ended = new Set<string>();
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const sent = new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "") ?? "";
    if (ended.has(sent)) return refused();
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      report_id: string;
    };
    return received(body.report_id);
  });
  const delivery = new DiagnosticDelivery({
    read: async () => structuredClone(state.stored),
    write: async (value) => {
      state.stored = structuredClone(value);
    },
    getAccount: () => state.account,
    canSendDiagnostics: async () => true,
    now: () => NOW,
    random: () => 0.5,
    fetch: fetcher,
    onChanged: () => undefined,
    schedule: async () => undefined,
  });
  return {
    state,
    ended,
    fetcher,
    delivery,
    flush: () => delivery.pump(),
    saved: () => structuredClone(state.stored) as Stored,
    status: (number: number) =>
      delivery.list(OWNER).find((entry) => entry.id === id(number))?.status,
  };
}

/** A worker whose report the server refused with the first token, then stopped. */
async function refusedThenStopped() {
  const first = worker(undefined, FIRST_TOKEN);
  first.ended.add(FIRST_TOKEN);
  await first.delivery.enqueue(report(1), OWNER);
  await first.flush();
  expect(first.fetcher).toHaveBeenCalledOnce();
  expect(first.status(1)).toBe("session_required");
  return first;
}

describe("a diagnostic report refused for its session, then a new worker", () => {
  it("is sent by a worker which starts with another token", async () => {
    const first = await refusedThenStopped();

    // The account signed in again while no worker observed the change.
    const next = worker(first.state.stored, SECOND_TOKEN);
    await next.flush();

    expect(next.fetcher).toHaveBeenCalledOnce();
    expect(next.status(1)).toBe("received");
    expect(next.saved().accounts[0]?.sessionRequired).toBe(false);
  });

  it("no longer holds back the later reports of the account", async () => {
    const first = await refusedThenStopped();
    await first.delivery.remove(id(1), OWNER);

    const next = worker(first.state.stored, SECOND_TOKEN);
    await next.delivery.enqueue(report(2), OWNER);
    await next.flush();

    expect(next.fetcher).toHaveBeenCalledOnce();
    expect(next.status(2)).toBe("received");
  });

  it("is still held by a worker which starts with the refused token", async () => {
    const first = await refusedThenStopped();

    const next = worker(first.state.stored, FIRST_TOKEN);
    await next.delivery.enqueue(report(2), OWNER);
    await next.flush();

    expect(next.fetcher).not.toHaveBeenCalled();
    expect(next.status(1)).toBe("session_required");
    expect(next.status(2)).toBe("session_required");
  });

  it("is held again when the server refuses the other token too", async () => {
    const first = await refusedThenStopped();

    const second = worker(first.state.stored, SECOND_TOKEN);
    second.ended.add(SECOND_TOKEN);
    await second.flush();
    expect(second.fetcher).toHaveBeenCalledOnce();
    expect(second.status(1)).toBe("session_required");

    // Neither refused token is tried again by later workers; a third one is.
    for (const token of [FIRST_TOKEN, SECOND_TOKEN]) {
      const later = worker(second.state.stored, token);
      await later.flush();
      expect(later.fetcher).not.toHaveBeenCalled();
    }
    const third = worker(second.state.stored, "synthetic-token-three");
    await third.flush();
    expect(third.fetcher).toHaveBeenCalledOnce();
    expect(third.status(1)).toBe("received");
  });

  it("stores a digest of the refused token, never the token", async () => {
    const first = await refusedThenStopped();

    const account = first.saved().accounts[0];
    expect(account?.sessionRequired).toBe(true);
    expect(account?.rejected).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect(JSON.stringify(first.state.stored)).not.toContain(FIRST_TOKEN);
  });

  it("keeps resuming within one worker when the token changes, as before", async () => {
    const first = await refusedThenStopped();

    first.state.account = { ...first.state.account!, token: SECOND_TOKEN, generation: 2 };
    first.delivery.syncAccount();
    await first.flush();

    expect(first.fetcher).toHaveBeenCalledTimes(2);
    expect(first.status(1)).toBe("received");
  });
});

describe("a refusal which an earlier version stored without saying which token", () => {
  /** What the stored state looked like before refused tokens were remembered. */
  async function storedByEarlierVersion() {
    const first = await refusedThenStopped();
    const stored = first.saved();
    for (const account of stored.accounts) delete account.rejected;
    return stored;
  }

  it("is settled by one attempt with the current token", async () => {
    const next = worker(await storedByEarlierVersion(), SECOND_TOKEN);
    await next.flush();

    expect(next.fetcher).toHaveBeenCalledOnce();
    expect(next.status(1)).toBe("received");
  });

  it("is held again, for good, when that attempt is refused", async () => {
    const next = worker(await storedByEarlierVersion(), FIRST_TOKEN);
    next.ended.add(FIRST_TOKEN);
    await next.flush();
    expect(next.fetcher).toHaveBeenCalledOnce();
    expect(next.status(1)).toBe("session_required");

    const later = worker(next.state.stored, FIRST_TOKEN);
    await later.flush();
    expect(later.fetcher).not.toHaveBeenCalled();
  });
});

describe("the stored digests of refused tokens", () => {
  it.each([
    ["is no list", "a".repeat(64)],
    ["holds something which is no digest", ["refused"]],
    ["holds too many entries", Array.from({ length: 9 }, (_, index) => String(index).repeat(64))],
  ])("are ignored, without losing the deliveries, when the record %s", async (_name, value) => {
    const first = await refusedThenStopped();
    const stored = first.saved();
    stored.accounts[0]!.rejected = value;

    const next = worker(stored, FIRST_TOKEN);
    await next.flush();

    // The deliveries are still readable; the refusal is settled like an earlier version's.
    expect(next.delivery.list(OWNER)).toHaveLength(1);
    expect(next.fetcher).toHaveBeenCalledOnce();
  });
});
