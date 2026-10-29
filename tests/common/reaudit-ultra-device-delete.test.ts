// SPDX-License-Identifier: MPL-2.0

import { ApiClient, ApiError, NetworkError } from "../../src/core/api/client";
import type { CommandResult } from "../../src/core/shared/messages";
import { AUTH, authenticatedState, createHarness, PROFILE } from "./helpers";

const DEVICES = ["a", "b"].map((suffix) => ({
  deviceId: `remote-${suffix}`,
  name: `Browser ${suffix}`,
  kind: "browser_extension" as const,
  createdAt: "2026-08-26T12:00:00Z",
  profiles: [],
}));

type Reply = "success" | "404" | "401" | "network";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function quota() {
  const h = createHarness({ persisted: authenticatedState() });
  h.api.devices = { limit: 2, devices: structuredClone(DEVICES) };
  h.api.enrollError = new ApiError("device_limit", 409);
  expect(await h.controller.connect("frankfurt-01")).toEqual({
    ok: false,
    commandError: "device_limit",
  });
  expect(await h.controller.refreshDevices()).toEqual({ ok: true });
  h.api.enrollError = null;
  const initial = { enrollments: h.api.enrollCalls, proofs: h.api.proofs.length };
  const refill = new Set<string>();
  const controls = { heldEnrollment: null as Promise<void> | null };
  const enrollmentEntered = deferred();
  const enroll = h.api.enrollBrowserDevice.bind(h.api);
  vi.spyOn(h.api, "enrollBrowserDevice").mockImplementation(async (...args) => {
    const freeSlots = h.api.devices.limit - h.api.devices.devices.length;
    const held = controls.heldEnrollment;
    controls.heldEnrollment = null;
    const result = await enroll(...args);
    if (held) {
      enrollmentEntered.resolve();
      await held;
    }
    if (freeSlots <= 0) throw new ApiError("device_limit", 409);
    h.api.devices.devices.push({ ...result, profiles: [] });
    return result;
  });
  // The presentation list fails, so only the DELETE reply decides the recovery.
  const listing = vi.spyOn(h.api, "getDevices").mockRejectedValue(new NetworkError("network"));
  const gates = DEVICES.map(() => ({ entered: deferred(), reply: deferred<Reply>() }));
  const remove = h.api.deleteDevice.bind(h.api);
  vi.spyOn(h.api, "deleteDevice").mockImplementation(async (token, deviceId) => {
    const gate = gates[DEVICES.findIndex((device) => device.deviceId === deviceId)]!;
    gate.entered.resolve();
    const reply = await gate.reply.promise;
    if (reply === "401") throw new ApiError("unauthorized", 401);
    if (reply === "network") throw new NetworkError("network");
    if (reply === "404") {
      // Another client removed the device first: its slot is free all the same.
      h.api.devices.devices = h.api.devices.devices.filter(
        (device) => device.deviceId !== deviceId,
      );
      throw new ApiError("not_found", 404);
    }
    await remove(token, deviceId);
    if (refill.has(deviceId))
      h.api.devices.devices.push({ ...DEVICES[0]!, deviceId: "competitor" });
  });
  return { h, initial, refill, controls, enrollmentEntered, listing, gates };
}

async function startBoth(q: Awaited<ReturnType<typeof quota>>) {
  const commands = DEVICES.map(({ deviceId }) => q.h.controller.deleteDevice(deviceId));
  await Promise.all(q.gates.map((gate) => gate.entered.promise));
  return commands;
}

// The first confirmed deletion retries at once, but a competitor took its slot:
// that internal recovery fails on quota and advances the operation id.
async function afterInternalRecovery() {
  const q = await quota();
  const commands = await startBoth(q);
  q.refill.add(DEVICES[0]!.deviceId);
  q.gates[0]!.reply.resolve("success");
  expect(await commands[0]).toEqual({ ok: false, commandError: "device_limit" });
  expect(q.h.api.enrollCalls).toBe(q.initial.enrollments + 1);
  expect(q.h.api.proofs).toHaveLength(q.initial.proofs);
  return { ...q, second: commands[1]! };
}

describe("ULTRA-06: a sibling's internal quota recovery does not supersede a DELETE reply", () => {
  it("credits an idempotent 404 with the freed slot", async () => {
    const q = await afterInternalRecovery();
    q.gates[1]!.reply.resolve("404");

    expect(await q.second).toEqual({ ok: true });
    expect(q.h.api.enrollCalls).toBe(q.initial.enrollments + 2);
    expect(q.h.api.proofs).toHaveLength(q.initial.proofs + 1);
    const snapshot = q.h.controller.getSnapshot();
    expect(snapshot).toMatchObject({
      profile: PROFILE,
      error: null,
      protectionRequested: true,
      protected: true,
      trafficBlocked: false,
      activeLocationId: "frankfurt-01",
    });
    expect(snapshot.devices.map(({ deviceId }) => deviceId)).not.toContain(DEVICES[1]!.deviceId);
  });

  it("invalidates the still-current account on a DELETE 401", async () => {
    const q = await afterInternalRecovery();
    q.gates[1]!.reply.resolve("401");

    expect(await q.second).toEqual({ ok: false, commandError: "unauthorized" });
    expect(q.h.api.enrollCalls).toBe(q.initial.enrollments + 1);
    expect(q.h.api.proofs).toHaveLength(q.initial.proofs);
    expect(q.h.controller.getSnapshot()).toMatchObject({
      profile: null,
      error: "unauthorized",
      protectionRequested: true,
      protected: false,
      trafficBlocked: true,
    });
  });

  it("reports an unconfirmed failure without granting a slot", async () => {
    const q = await afterInternalRecovery();
    q.gates[1]!.reply.resolve("network");

    expect(await q.second).toEqual({ ok: false, commandError: "network_error" });
    expect(q.h.api.enrollCalls).toBe(q.initial.enrollments + 1);
    expect(q.h.api.proofs).toHaveLength(q.initial.proofs);
    const snapshot = q.h.controller.getSnapshot();
    expect(snapshot).toMatchObject({
      profile: PROFILE,
      error: "network_error",
      protectionRequested: true,
      protected: false,
      trafficBlocked: true,
    });
    expect(snapshot.devices.map(({ deviceId }) => deviceId)).toContain(DEVICES[1]!.deviceId);
  });

  it.each([
    ["fails", { ok: false, commandError: "network_error" }],
    ["succeeds", { ok: false, superseded: true }],
  ] as const)(
    "reports a remote failure only after a pending sibling recovery %s",
    async (outcome, expected) => {
      const q = await quota();
      const commands = await startBoth(q);
      const held = deferred();
      q.controls.heldEnrollment = held.promise;
      if (outcome === "fails") q.refill.add(DEVICES[0]!.deviceId);
      q.gates[0]!.reply.resolve("success");
      await q.enrollmentEntered.promise;
      let second: CommandResult | undefined;
      void commands[1]!.then((result) => {
        second = result;
      });
      q.gates[1]!.reply.resolve("network");
      await settle();

      // The failure neither overwrites the pending connection nor resolves early.
      expect(second).toBeUndefined();
      expect(q.h.controller.getSnapshot()).toMatchObject({ status: "connecting", error: null });
      held.resolve();
      expect(await commands[1]).toEqual(expected);
      expect(await commands[0]).toEqual(
        outcome === "fails" ? { ok: false, commandError: "device_limit" } : { ok: true },
      );
      expect(q.h.api.enrollCalls).toBe(q.initial.enrollments + 1);
      expect(q.h.controller.getSnapshot()).toMatchObject(
        outcome === "fails"
          ? { error: "network_error", protected: false, trafficBlocked: true }
          : { status: "connected", error: null, protected: true, trafficBlocked: false },
      );
    },
  );

  it.each([
    [404, "not_found", { ok: true }],
    [401, "unauthorized", { ok: false, commandError: "unauthorized" }],
  ] as const)(
    "keeps a late same-account HTTP %i decoded by the API client",
    async (status, code, expected) => {
      const q = await quota();
      const replies = new Map(DEVICES.map(({ deviceId }) => [deviceId, deferred<Response>()]));
      const started = new Set<string>();
      const signals: AbortSignal[] = [];
      const removing: typeof fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        const deviceId = decodeURIComponent(url.split("/").at(-1)!);
        expect(init?.method).toBe("DELETE");
        started.add(deviceId);
        signals.push(init!.signal!);
        return replies.get(deviceId)!.promise;
      };
      const client = new ApiClient(removing, "https://api.example.invalid", 6000);
      vi.spyOn(q.h.api, "deleteDevice").mockImplementation((...args) =>
        client.deleteDevice(...args),
      );
      const commands = DEVICES.map(({ deviceId }) => q.h.controller.deleteDevice(deviceId));
      await vi.waitFor(() => expect(started.size).toBe(2));
      q.h.api.devices.devices = [DEVICES[1]!, { ...DEVICES[0]!, deviceId: "competitor" }];
      replies.get(DEVICES[0]!.deviceId)!.resolve(new Response(null, { status: 204 }));
      expect(await commands[0]).toEqual({ ok: false, commandError: "device_limit" });
      if (status === 404) q.h.api.devices.devices = [{ ...DEVICES[0]!, deviceId: "competitor" }];
      replies.get(DEVICES[1]!.deviceId)!.resolve(
        new Response(JSON.stringify({ error: code }), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );

      expect(await commands[1]).toEqual(expected);
      expect(signals.some((signal) => signal.aborted)).toBe(false);
      expect(q.h.api.enrollCalls).toBe(q.initial.enrollments + (status === 404 ? 2 : 1));
      expect(q.h.controller.getSnapshot()).toMatchObject(
        status === 404
          ? { profile: PROFILE, error: null, protected: true }
          : { profile: null, error: "unauthorized", protected: false, trafficBlocked: true },
      );
    },
  );

  it.each(["disconnect", "account"] as const)(
    "still supersedes a late 404 after a %s replacement",
    async (change) => {
      const q = await quota();
      const commands = await startBoth(q);
      if (change === "account") {
        expect(await q.h.controller.logout()).toEqual({ ok: true });
        q.h.api.auth = { ...AUTH, accessToken: "same-account-new-token" };
        expect(await q.h.controller.login(PROFILE.email, "synthetic")).toEqual({ ok: true });
      } else {
        expect(await q.h.controller.disconnect()).toEqual({ ok: true });
      }
      const snapshot = q.h.controller.getSnapshot();
      const enrollments = q.h.api.enrollCalls;
      const listings = q.listing.mock.calls.length;
      for (const gate of q.gates) gate.reply.resolve("404");

      expect(await Promise.all(commands)).toEqual([
        { ok: false, superseded: true },
        { ok: false, superseded: true },
      ]);
      expect(q.h.api.enrollCalls).toBe(enrollments);
      expect(q.listing).toHaveBeenCalledTimes(listings);
      expect(q.h.controller.getSnapshot()).toMatchObject({
        profile: PROFILE,
        error: null,
        protectionRequested: false,
        trafficBlocked: false,
      });
      if (change === "account") expect(q.h.controller.getSnapshot()).toEqual(snapshot);
    },
  );
});
