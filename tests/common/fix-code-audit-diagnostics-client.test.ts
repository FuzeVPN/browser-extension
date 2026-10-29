// SPDX-License-Identifier: MPL-2.0

import { DiagnosticConnection } from "../../src/ui/diagnostics-page/client";
import type { DiagnosticResponse, DiagnosticUiState } from "../../src/core/shared/diagnostics-ui";

const reportId = "a1000000-0000-4000-8000-000000000001";

function state(overrides: Partial<DiagnosticUiState> = {}): DiagnosticUiState {
  return {
    version: 1,
    workerId: "worker-1",
    revision: 1,
    accountEpoch: 1,
    language: "fr",
    signedIn: true,
    autoReporting: false,
    preparing: false,
    historyCount: 0,
    reports: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function broadcast(client: DiagnosticConnection, next: DiagnosticUiState) {
  client.receive({ type: "diagnostics_changed", state: next });
}

function reply(next: DiagnosticUiState, ok = true): DiagnosticResponse {
  return { diagnosticsVersion: 1, ok, state: next, ...(!ok ? { error: "not_found" } : {}) };
}

describe("diagnostic client request ordering", () => {
  afterEach(() => vi.useRealTimers());

  it.each([true, false])(
    "keeps the first broadcast worker after an unknown initial worker replies (ok=%s)",
    async (ok) => {
      const held = deferred<unknown>();
      const client = new DiagnosticConnection(
        () => {},
        () => held.promise,
      );
      const pending = client.request({ type: "diagnostics_state" });
      const current = state({ workerId: "worker-2", revision: 3, accountEpoch: 2 });
      broadcast(client, current);
      await client.requestWithDataConsent(
        { type: "diagnostics_set_auto", enabled: true },
        async () => false,
      );

      held.resolve(reply(state({ revision: 100 }), ok));
      expect(await pending).toBeNull();
      expect(client.state).toEqual(current);
      expect(client.error).toBe("data_collection_required");
      expect(client.available).toBe(true);

      const following = { ...current, revision: 4, historyCount: 1 };
      broadcast(client, following);
      expect(client.state).toEqual(following);
    },
  );

  it.each([true, false])(
    "preserves a later native refusal when an earlier report replies at the broadcast revision (ok=%s)",
    async (ok) => {
      const held = deferred<unknown>();
      const send = vi.fn(() => held.promise);
      const client = new DiagnosticConnection(() => {}, send);
      broadcast(client, state());
      const pending = client.request({ type: "diagnostics_report", reportId });
      broadcast(client, state({ revision: 2 }));
      await client.requestWithDataConsent(
        { type: "diagnostics_set_auto", enabled: true },
        async () => false,
      );

      const response = reply(state({ revision: 2 }), ok);
      held.resolve(response);
      expect(await pending).toEqual(response);
      expect(client.error).toBe("data_collection_required");
      expect(send).toHaveBeenCalledExactlyOnceWith({ type: "diagnostics_report", reportId });
    },
  );

  it.each([true, false])(
    "still accepts a newer state from an earlier request without replacing the latest refusal (ok=%s)",
    async (ok) => {
      const held = deferred<unknown>();
      const client = new DiagnosticConnection(
        () => {},
        () => held.promise,
      );
      broadcast(client, state());
      const pending = client.request({ type: "diagnostics_report", reportId });
      await client.requestWithDataConsent(
        { type: "diagnostics_set_auto", enabled: true },
        async () => false,
      );

      const newer = state({ revision: 4, historyCount: 2 });
      held.resolve(reply(newer, ok));
      await pending;
      expect(client.state).toEqual(newer);
      expect(client.error).toBe("data_collection_required");
    },
  );

  it("keeps a newer action's error when an earlier native refusal resolves last", async () => {
    const consent = deferred<boolean>();
    const send = vi.fn(async () => reply(state(), false));
    const client = new DiagnosticConnection(() => {}, send);
    broadcast(client, state());
    const earlier = client.requestWithDataConsent(
      { type: "diagnostics_set_auto", enabled: true },
      () => consent.promise,
    );
    await client.request({ type: "diagnostics_report", reportId });
    expect(client.error).toBe("not_found");

    consent.resolve(false);
    expect(await earlier).toBeNull();
    expect(client.error).toBe("not_found");
    expect(send).toHaveBeenCalledOnce();
  });

  it("does not let an earlier transport failure disable a later consent refusal", async () => {
    const held = deferred<unknown>();
    const client = new DiagnosticConnection(
      () => {},
      () => held.promise,
    );
    broadcast(client, state());
    const pending = client.request({ type: "diagnostics_report", reportId });
    await client.requestWithDataConsent(
      { type: "diagnostics_set_auto", enabled: true },
      async () => false,
    );

    held.reject(new Error("synthetic_transport_failure"));
    expect(await pending).toBeNull();
    expect(client.available).toBe(true);
    expect(client.error).toBe("data_collection_required");
  });

  it.each(["transport", "malformed", "timeout"] as const)(
    "exposes the current %s failure after a same-context broadcast",
    async (failure) => {
      vi.useFakeTimers();
      const held = deferred<unknown>();
      const client = new DiagnosticConnection(
        () => {},
        () => held.promise,
        20,
      );
      broadcast(client, state());
      const pending = client.request({ type: "diagnostics_report", reportId });
      const current = state({ revision: 2, historyCount: 1 });
      broadcast(client, current);
      if (failure === "transport") held.reject(new Error("synthetic_transport_failure"));
      else if (failure === "malformed") held.resolve({ diagnosticsVersion: 0 });
      else await vi.advanceTimersByTimeAsync(20);

      expect(await pending).toBeNull();
      expect(client.state).toEqual(current);
      expect(client.available).toBe(false);
      expect(client.error).toBe("unavailable");
    },
  );

  it("publishes a current response error even when its revision was already broadcast", async () => {
    const held = deferred<unknown>();
    const client = new DiagnosticConnection(
      () => {},
      () => held.promise,
    );
    broadcast(client, state());
    const pending = client.request({ type: "diagnostics_report", reportId });
    broadcast(client, state({ revision: 2 }));

    held.resolve(reply(state({ revision: 2 }), false));
    await pending;
    expect(client.available).toBe(true);
    expect(client.error).toBe("not_found");
  });

  it("publishes a first response error matching an intervening first broadcast", async () => {
    const held = deferred<unknown>();
    const client = new DiagnosticConnection(
      () => {},
      () => held.promise,
    );
    const pending = client.request({ type: "diagnostics_state" });
    broadcast(client, state({ revision: 2 }));

    held.resolve(reply(state({ revision: 2 }), false));
    await pending;
    expect(client.error).toBe("not_found");
  });

  it("lets a later successful action clear the native refusal", async () => {
    const client = new DiagnosticConnection(
      () => {},
      async () => reply(state()),
    );
    broadcast(client, state());
    await client.requestWithDataConsent(
      { type: "diagnostics_set_auto", enabled: true },
      async () => false,
    );
    expect(client.error).toBe("data_collection_required");

    await client.request({ type: "diagnostics_report", reportId });
    expect(client.error).toBeNull();
  });

  it("accepts a new worker returned to a request that started in the current context", async () => {
    const held = deferred<unknown>();
    const client = new DiagnosticConnection(
      () => {},
      () => held.promise,
    );
    broadcast(client, state());
    const pending = client.request({ type: "diagnostics_state" });
    broadcast(client, state({ revision: 2 }));
    const restarted = state({ workerId: "worker-2", revision: 0 });

    held.resolve(reply(restarted));
    expect(await pending).toEqual(reply(restarted));
    expect(client.state).toEqual(restarted);
    broadcast(client, state({ revision: 100 }));
    expect(client.state).toEqual(restarted);
  });

  it("accepts a new account state from an old request without publishing its old error", async () => {
    const held = deferred<unknown>();
    const client = new DiagnosticConnection(
      () => {},
      () => held.promise,
    );
    broadcast(client, state());
    const pending = client.request({ type: "diagnostics_report", reportId });
    const switched = state({ revision: 2, accountEpoch: 2 });
    broadcast(client, switched);
    await client.requestWithDataConsent(
      { type: "diagnostics_set_auto", enabled: true },
      async () => false,
    );
    const newer = { ...switched, revision: 3, historyCount: 2 };

    held.resolve(reply(newer, false));
    await pending;
    expect(client.state).toEqual(newer);
    expect(client.error).toBe("data_collection_required");
  });

  it("accepts a new worker after an intervening account change on the same worker", async () => {
    const held = deferred<unknown>();
    const client = new DiagnosticConnection(
      () => {},
      () => held.promise,
    );
    broadcast(client, state());
    const pending = client.request({ type: "diagnostics_state" });
    broadcast(client, state({ revision: 2, accountEpoch: 2 }));
    const restarted = state({ workerId: "worker-2", revision: 0, accountEpoch: 2 });

    held.resolve(reply(restarted));
    expect(await pending).toEqual(reply(restarted));
    expect(client.state).toEqual(restarted);
  });

  it("publishes a current response error from an older snapshot without rolling back state", async () => {
    const held = deferred<unknown>();
    const client = new DiagnosticConnection(
      () => {},
      () => held.promise,
    );
    broadcast(client, state());
    const pending = client.request({ type: "diagnostics_report", reportId });
    const current = state({ revision: 3, historyCount: 2 });
    broadcast(client, current);

    held.resolve(reply(state({ revision: 2 }), false));
    await pending;
    expect(client.state).toEqual(current);
    expect(client.available).toBe(true);
    expect(client.error).toBe("not_found");
  });

  it.each([
    [true, "queue_full"],
    [false, "queue_full"],
    [true, "not_found"],
    [false, "not_found"],
  ] as const)(
    "preserves a later direct error publication, including repeated text (ok=%s, initial=%s)",
    async (ok, initial) => {
      const held = deferred<unknown>();
      const client = new DiagnosticConnection(
        () => {},
        () => held.promise,
      );
      broadcast(client, state());
      client.error = initial;
      const pending = client.request({ type: "diagnostics_report", reportId });
      broadcast(client, state({ revision: 3 }));
      client.error = "queue_full";

      held.resolve(reply(state({ revision: 2 }), ok));
      await pending;
      expect(client.state?.revision).toBe(3);
      expect(client.error).toBe("queue_full");
    },
  );

  it("preserves a newer direct error publication while native refusal is pending", async () => {
    const consent = deferred<boolean>();
    const client = new DiagnosticConnection(
      () => {},
      async () => reply(state()),
    );
    broadcast(client, state());
    client.error = "queue_full";
    const pending = client.requestWithDataConsent(
      { type: "diagnostics_set_auto", enabled: true },
      () => consent.promise,
    );
    client.error = "queue_full";

    consent.resolve(false);
    expect(await pending).toBeNull();
    expect(client.error).toBe("queue_full");
  });

  it.each([true, false])(
    "preserves a newer error when native consent grants an earlier action (ok=%s)",
    async (ok) => {
      const consent = deferred<boolean>();
      const send = vi.fn(async () => reply(state({ revision: 2 }), ok));
      const client = new DiagnosticConnection(() => {}, send);
      broadcast(client, state());
      const pending = client.requestWithDataConsent(
        { type: "diagnostics_set_auto", enabled: true },
        () => consent.promise,
      );
      client.error = "queue_full";

      consent.resolve(true);
      await pending;
      expect(send).toHaveBeenCalledOnce();
      expect(client.state?.revision).toBe(2);
      expect(client.error).toBe("queue_full");
    },
  );

  it("publishes a current error after a broadcast cleared an earlier transport error", async () => {
    const held = deferred<unknown>();
    const client = new DiagnosticConnection(
      () => {},
      () => held.promise,
    );
    broadcast(client, state());
    client.error = "unavailable";
    const pending = client.request({ type: "diagnostics_report", reportId });
    broadcast(client, state({ revision: 3 }));
    expect(client.error).toBeNull();

    held.resolve(reply(state({ revision: 2 }), false));
    await pending;
    expect(client.error).toBe("not_found");
    expect(client.state?.revision).toBe(3);
  });
});
