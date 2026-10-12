// SPDX-License-Identifier: MPL-2.0

import {
  canSendDiagnostics,
  requestDiagnosticsConsent,
} from "../../../src/core/shared/data-consent";
import { DiagnosticConnection, diagnosticErrorKey } from "../../../src/ui/diagnostics-page/client";
import type { DiagnosticUiState } from "../../../src/core/shared/diagnostics-ui";

afterEach(() => vi.unstubAllGlobals());

describe("Firefox diagnostic data consent", () => {
  it("does not confuse API permissions with consent for diagnostic data", async () => {
    vi.stubGlobal("browser", {
      permissions: {
        getAll: async () => ({
          permissions: ["storage", "technicalAndInteraction"],
          origins: ["<all_urls>"],
          data_collection: ["locationInfo"],
        }),
      },
    });
    expect(await canSendDiagnostics()).toBe(false);
  });

  it("observes consent withdrawal without caching an earlier grant", async () => {
    const getAll = vi
      .fn()
      .mockResolvedValueOnce({ data_collection: ["technicalAndInteraction"] })
      .mockResolvedValueOnce({ data_collection: [] });
    vi.stubGlobal("browser", { permissions: { getAll } });
    expect(await canSendDiagnostics()).toBe(true);
    expect(await canSendDiagnostics()).toBe(false);
  });

  it("does not send when an older Firefox omits data consent", async () => {
    vi.stubGlobal("browser", { permissions: { getAll: async () => ({ permissions: [] }) } });
    expect(await canSendDiagnostics()).toBe(false);
  });

  it("fails closed when reading permissions rejects", async () => {
    vi.stubGlobal("browser", {
      permissions: { getAll: async () => Promise.reject(new Error("permissions unavailable")) },
    });
    expect(await canSendDiagnostics()).toBe(false);
  });

  it("requests native consent before the user gesture ends", async () => {
    let gestureActive = true;
    const request = vi.fn((permission: browser.permissions.Permissions) => {
      expect(gestureActive).toBe(true);
      expect(permission).toEqual({ data_collection: ["technicalAndInteraction"] });
      return Promise.resolve(true);
    });
    const getAll = vi.fn();
    vi.stubGlobal("browser", { permissions: { request, getAll } });
    const result = requestDiagnosticsConsent();
    gestureActive = false;
    expect(request).toHaveBeenCalledOnce();
    expect(getAll).not.toHaveBeenCalled();
    expect(await result).toBe(true);
  });

  it("reports a native refusal", async () => {
    vi.stubGlobal("browser", { permissions: { request: async () => false } });
    expect(await requestDiagnosticsConsent()).toBe(false);
  });

  it("handles Firefox rejecting an unsupported data permission", async () => {
    vi.stubGlobal("browser", {
      permissions: { request: async () => Promise.reject(new Error("unsupported permission")) },
    });
    expect(await requestDiagnosticsConsent()).toBe(false);
  });

  it("handles an unavailable native permission API", async () => {
    vi.stubGlobal("browser", { permissions: {} });
    expect(await requestDiagnosticsConsent()).toBe(false);
  });

  it("accepts and localizes a worker refusal while preserving diagnostic controls", async () => {
    const state: DiagnosticUiState = {
      version: 1,
      workerId: "worker-1",
      revision: 1,
      language: "fr",
      signedIn: true,
      autoReporting: false,
      preparing: false,
      historyCount: 0,
      reports: [],
    };
    const client = new DiagnosticConnection(
      () => undefined,
      async () => ({
        diagnosticsVersion: 1,
        ok: false,
        state,
        error: "data_collection_required",
      }),
    );
    const response = await client.request({ type: "diagnostics_set_auto", enabled: true });
    expect(response?.ok).toBe(false);
    expect(client.available).toBe(true);
    expect(client.error).toBe("data_collection_required");
    expect(diagnosticErrorKey(client.error!)).toBe("diagnosticsDataCollectionRequired");
  });
});

describe("diagnostic consent across account changes", () => {
  function state(overrides: Partial<DiagnosticUiState> = {}): DiagnosticUiState {
    return {
      version: 1,
      workerId: "worker-1",
      revision: 1,
      accountEpoch: 3,
      language: "fr",
      signedIn: true,
      autoReporting: false,
      preparing: false,
      historyCount: 0,
      reports: [],
      ...overrides,
    };
  }

  function fixture(initial: DiagnosticUiState = state()) {
    const send = vi.fn(async () => ({ diagnosticsVersion: 1, ok: true, state: initial }));
    const changed = vi.fn();
    const client = new DiagnosticConnection(changed, send);
    client.receive({ type: "diagnostics_changed", state: initial });
    let grant!: (value: boolean) => void;
    const consent = new Promise<boolean>((resolve) => {
      grant = resolve;
    });
    const requestConsent = vi.fn(() => consent);
    return { client, send, changed, grant, requestConsent };
  }

  const command = { type: "diagnostics_set_auto", enabled: true } as const;

  it("uses the first accepted prompt even when its grant publishes a new revision", async () => {
    const { client, send, grant, requestConsent } = fixture();
    const pending = client.requestWithDataConsent(command, requestConsent);
    expect(requestConsent).toHaveBeenCalledOnce();
    client.receive({ type: "diagnostics_changed", state: state({ revision: 2 }) });
    grant(true);
    await pending;
    expect(send).toHaveBeenCalledWith(command);
  });

  it("does not apply an accepted prompt to another signed-in account", async () => {
    const { client, send, grant, requestConsent } = fixture();
    const pending = client.requestWithDataConsent(command, requestConsent);
    client.receive({
      type: "diagnostics_changed",
      state: state({ revision: 2, accountEpoch: 4 }),
    });
    grant(true);
    expect(await pending).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("observes logout then login even for a historical state without an account epoch", async () => {
    const initial = state({ accountEpoch: undefined });
    const { client, send, grant, requestConsent } = fixture(initial);
    const pending = client.requestWithDataConsent(command, requestConsent);
    client.receive({
      type: "diagnostics_changed",
      state: { ...initial, signedIn: false, revision: 2 },
    });
    client.receive({ type: "diagnostics_changed", state: { ...initial, revision: 3 } });
    grant(true);
    expect(await pending).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not apply an accepted prompt after a worker restart", async () => {
    const { client, send, grant, requestConsent } = fixture();
    const pending = client.requestWithDataConsent(command, requestConsent);
    client.receive({ type: "diagnostics_changed", state: state({ workerId: "worker-2" }) });
    grant(true);
    expect(await pending).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("also cancels when the popup observes its account change before the diagnostic broadcast", async () => {
    const { client, send, grant, requestConsent } = fixture();
    let accountUnchanged = true;
    const pending = client.requestWithDataConsent(command, requestConsent, () => accountUnchanged);
    accountUnchanged = false;
    grant(true);
    expect(await pending).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("shows refusal without sending a command or disabling local diagnostics", async () => {
    const { client, send, grant, requestConsent } = fixture();
    const pending = client.requestWithDataConsent(command, requestConsent);
    grant(false);
    expect(await pending).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(client.error).toBe("data_collection_required");
    expect(client.available).toBe(true);
  });
});
