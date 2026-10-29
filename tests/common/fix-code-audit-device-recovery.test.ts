// SPDX-License-Identifier: MPL-2.0

import { ApiError, NetworkError } from "../../src/core/api/client";
import { AUTH, authenticatedState, createHarness, PROFILE } from "./helpers";

const DEVICES = ["a", "b", "c"].map((suffix) => ({
  deviceId: `remote-${suffix}`,
  name: `Browser ${suffix}`,
  kind: "browser_extension" as const,
  createdAt: "2026-08-26T12:00:00Z",
  profiles: [],
}));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function quota(revoked: boolean, count = 2) {
  const h = createHarness({ persisted: authenticatedState() });
  h.api.devices = { limit: count, devices: structuredClone(DEVICES.slice(0, count)) };
  if (revoked) {
    h.identity.deviceId = "revoked-device";
    const create = h.api.createProxySession.bind(h.api);
    h.api.createProxySession = async (...args) => {
      if (args[2].deviceId === "revoked-device") throw new ApiError("device_identity_revoked", 403);
      return create(...args);
    };
  }
  h.api.enrollError = new ApiError("device_limit", 409);
  await h.controller.connect("frankfurt-01");
  expect(await h.controller.refreshDevices()).toEqual({ ok: true });
  expect(h.controller.getSnapshot()).toMatchObject({
    error: revoked ? "device_revoked_limit" : "device_limit",
    protectionRequested: true,
    protected: false,
    trafficBlocked: true,
    nextRetryAt: null,
  });
  h.api.enrollError = null;

  const initial = {
    enrollments: h.api.enrollCalls,
    proofs: h.api.proofs.length,
    key: h.api.enrollments.at(-1)?.publicKey,
    keyGenerations: h.identity.keyGenerations,
  };
  const events: { kind: string; deviceId?: string; freeSlots?: number }[] = [];
  const gates = DEVICES.slice(0, count).map(() => ({
    entered: deferred(),
    commit: deferred(),
  }));
  const refill = new Set<string>();
  const controls = { heldEnrollment: null as { promise: Promise<void> } | null };
  const enrollmentEntered = deferred();
  const remove = h.api.deleteDevice.bind(h.api);
  const enroll = h.api.enrollBrowserDevice.bind(h.api);
  const sign = h.identity.createProof.bind(h.identity);
  const create = h.api.createProxySession.bind(h.api);

  const deleting = vi.spyOn(h.api, "deleteDevice").mockImplementation(async (token, deviceId) => {
    const gate = gates[DEVICES.findIndex((device) => device.deviceId === deviceId)]!;
    gate.entered.resolve();
    await gate.commit.promise; // Deliberately ignores abort to exercise late server replies.
    await remove(token, deviceId);
    events.push({ kind: "delete-confirmed", deviceId });
    if (refill.has(deviceId)) {
      h.api.devices.devices.push({ ...DEVICES[0]!, deviceId: `competitor-for-${deviceId}` });
      events.push({ kind: "competitor-filled-slot", deviceId });
    }
  });
  vi.spyOn(h.api, "enrollBrowserDevice").mockImplementation(async (...args) => {
    const freeSlots = h.api.devices.limit - h.api.devices.devices.length;
    events.push({ kind: "enroll-request", freeSlots });
    const held = controls.heldEnrollment;
    controls.heldEnrollment = null;
    const result = await enroll(...args);
    if (held) {
      enrollmentEntered.resolve();
      await held.promise;
    }
    if (freeSlots <= 0) {
      events.push({ kind: "enroll-quota-rejected", freeSlots });
      throw new ApiError("device_limit", 409);
    }
    h.api.devices.devices.push({ ...result, profiles: [] });
    events.push({ kind: "enroll-accepted", freeSlots });
    return result;
  });
  const signing = vi.spyOn(h.identity, "createProof").mockImplementation(async (...args) => {
    events.push({ kind: "proof-signed", deviceId: args[1] });
    return sign(...args);
  });
  vi.spyOn(h.api, "createProxySession").mockImplementation(async (...args) => {
    events.push({ kind: "proxy-request", deviceId: args[2].deviceId });
    return create(...args);
  });
  const listing = vi.spyOn(h.api, "getDevices").mockImplementation(async () => {
    events.push({ kind: "presentation-get-failed" });
    throw new NetworkError("network");
  });
  return {
    h,
    initial,
    events,
    gates,
    refill,
    controls,
    enrollmentEntered,
    deleting,
    signing,
    listing,
  };
}

type Quota = Awaited<ReturnType<typeof quota>>;

async function start(q: Quota) {
  const commands = q.gates.map((_, index) => q.h.controller.deleteDevice(DEVICES[index]!.deviceId));
  await Promise.all(q.gates.map((gate) => gate.entered.promise));
  expect(q.h.api.enrollCalls).toBe(q.initial.enrollments);
  expect(q.signing).not.toHaveBeenCalled();
  return commands;
}

async function expectRecovered(q: Quota, retries: number) {
  expect(q.h.api.enrollCalls).toBe(q.initial.enrollments + retries);
  expect(q.h.api.proofs).toHaveLength(q.initial.proofs + 1);
  expect(q.signing).toHaveBeenCalledTimes(1);
  expect(q.h.api.proofs.at(-1)).toEqual(await q.signing.mock.results[0]!.value);
  expect(q.h.api.proofs.at(-1)?.deviceId).toBe("browser-device-1");
  expect(q.h.api.proofs.at(-1)?.deviceNonce).toEqual(expect.any(String));
  expect(q.h.api.proofs.at(-1)?.deviceSignature).toEqual(expect.any(String));
  expect(
    q.h.api.enrollments.slice(q.initial.enrollments).map(({ publicKey }) => publicKey),
  ).toEqual(Array.from({ length: retries }, () => q.initial.key));
  expect(q.h.identity.keyGenerations).toBe(q.initial.keyGenerations);
  expect(q.events.filter(({ kind }) => kind === "enroll-accepted")).toHaveLength(1);
  expect(q.events.find(({ kind }) => kind === "enroll-accepted")!.freeSlots).toBeGreaterThan(0);
  const accepted = q.events.findIndex(({ kind }) => kind === "enroll-accepted");
  const signed = q.events.findIndex(({ kind }) => kind === "proof-signed");
  const sent = q.events.findIndex(({ kind }) => kind === "proxy-request");
  expect(accepted).toBeLessThan(signed);
  expect(signed).toBeLessThan(sent);
  expect(q.h.controller.getSnapshot()).toMatchObject({
    error: null,
    protectionRequested: true,
    protected: true,
    trafficBlocked: false,
    activeLocationId: "frankfurt-01",
    nextRetryAt: null,
  });
  expect(q.h.alarms.reconnectAt).toBeNull();
}

describe("CODE04: concurrent confirmed device deletions retain their quota recovery", () => {
  for (const revoked of [false, true]) {
    it.each([
      [0, 1],
      [1, 0],
    ])(
      `recovers from the later free slot after the earlier retry hits quota, order=%j, revoked=${String(revoked)}`,
      async (...order) => {
        const q = await quota(revoked);
        const commands = await start(q);
        q.refill.add(DEVICES[order[0]]!.deviceId);
        q.gates[order[0]]!.commit.resolve();
        expect(await commands[order[0]]).toMatchObject({ ok: false });
        expect(q.h.api.enrollCalls).toBe(q.initial.enrollments + 1);
        expect(q.signing).not.toHaveBeenCalled();
        expect(q.h.api.proofs).toHaveLength(q.initial.proofs);
        expect(q.h.controller.getSnapshot()).toMatchObject({
          protectionRequested: true,
          protected: false,
          trafficBlocked: true,
          error: revoked ? "device_revoked_limit" : "device_limit",
        });
        q.gates[order[1]]!.commit.resolve();
        expect(await commands[order[1]]).toEqual({ ok: true });
        expect(q.h.api.deletedDevices).toEqual(order.map((index) => DEVICES[index]!.deviceId));
        await expectRecovered(q, 2);
      },
    );

    it.each([
      [0, 1, 2],
      [2, 1, 0],
    ])(
      `retains three sequential deletion credits across two quota failures, order=%j, revoked=${String(revoked)}`,
      async (...order) => {
        const q = await quota(revoked, 3);
        const commands = await start(q);
        for (const index of order.slice(0, 2)) {
          q.refill.add(DEVICES[index]!.deviceId);
          q.gates[index]!.commit.resolve();
          expect(await commands[index]).toMatchObject({ ok: false });
          expect(q.signing).not.toHaveBeenCalled();
          expect(q.h.api.proofs).toHaveLength(q.initial.proofs);
        }
        q.gates[order[2]]!.commit.resolve();
        expect(await commands[order[2]]).toEqual({ ok: true });
        expect(q.h.api.deletedDevices).toEqual(order.map((index) => DEVICES[index]!.deviceId));
        await expectRecovered(q, 3);
      },
    );

    it.each([
      [0, 1, 2],
      [2, 1, 0],
    ])(
      `serializes two callbacks waiting behind one pending recovery, order=%j, revoked=${String(revoked)}`,
      async (...order) => {
        const q = await quota(revoked, 3);
        const commands = await start(q);
        const held = deferred();
        q.controls.heldEnrollment = held;
        q.refill.add(DEVICES[order[0]]!.deviceId);
        q.gates[order[0]]!.commit.resolve();
        await q.enrollmentEntered.promise;
        for (const index of order.slice(1)) q.gates[index]!.commit.resolve();
        await vi.waitFor(() => expect(q.listing).toHaveBeenCalledTimes(3));
        expect(q.h.api.enrollCalls).toBe(q.initial.enrollments + 1);
        expect(q.signing).not.toHaveBeenCalled();
        held.resolve();
        const results = await Promise.all(commands);
        expect(results.filter(({ ok }) => ok)).toHaveLength(1);
        expect(q.h.api.deletedDevices).toHaveLength(3);
        await expectRecovered(q, 2);
      },
    );

    it(`deduplicates both DELETE and the recovery credit, revoked=${String(revoked)}`, async () => {
      const q = await quota(revoked);
      const commands = await start(q);
      const duplicates = DEVICES.slice(0, 2).map(({ deviceId }) =>
        q.h.controller.deleteDevice(deviceId),
      );
      q.refill.add(DEVICES[0]!.deviceId);
      q.gates[0]!.commit.resolve();
      expect(await commands[0]).toMatchObject({ ok: false });
      q.gates[1]!.commit.resolve();
      const results = await Promise.all(commands);
      expect(await Promise.all(duplicates)).toEqual(results);
      expect(q.deleting).toHaveBeenCalledTimes(2);
      await expectRecovered(q, 2);
    });

    it(`keeps a delayed identity read valid after an internal quota failure, revoked=${String(revoked)}`, async () => {
      const q = await quota(revoked);
      const reading = deferred();
      const identity = deferred<string | null>();
      const read = q.h.identity.getDeviceId.bind(q.h.identity);
      vi.spyOn(q.h.identity, "getDeviceId")
        .mockImplementationOnce(read)
        .mockImplementationOnce(async () => {
          reading.resolve();
          return identity.promise;
        });
      const first = q.h.controller.deleteDevice(DEVICES[0]!.deviceId);
      const second = q.h.controller.deleteDevice(DEVICES[1]!.deviceId);
      await Promise.all([q.gates[0]!.entered.promise, reading.promise]);
      q.refill.add(DEVICES[0]!.deviceId);
      q.gates[0]!.commit.resolve();
      expect(await first).toMatchObject({ ok: false });
      expect(q.signing).not.toHaveBeenCalled();
      identity.resolve(null);
      await q.gates[1]!.entered.promise;
      q.gates[1]!.commit.resolve();
      expect(await second).toEqual({ ok: true });
      await expectRecovered(q, 2);
    });

    it.each(["intent", "account"] as const)(
      `allows a new %s to recover before an old ignored-abort enrollment settles, revoked=${String(revoked)}`,
      async (change) => {
        const q = await quota(revoked);
        const held = deferred();
        q.controls.heldEnrollment = held;
        q.refill.add(DEVICES[0]!.deviceId);
        const oldDelete = q.h.controller.deleteDevice(DEVICES[0]!.deviceId);
        await q.gates[0]!.entered.promise;
        q.gates[0]!.commit.resolve();
        await q.enrollmentEntered.promise;
        if (change === "account") {
          expect(await q.h.controller.logout()).toEqual({ ok: true });
          q.h.api.auth = { ...AUTH, accessToken: "independent-new-owner-token" };
          q.h.api.profile = { ...PROFILE, userId: "independent-new-owner" };
          expect(await q.h.controller.login(q.h.api.profile.email, "synthetic")).toEqual({
            ok: true,
          });
        } else {
          expect(await q.h.controller.disconnect()).toEqual({ ok: true });
        }
        expect(await q.h.controller.connect("frankfurt-02")).toMatchObject({ ok: false });
        expect(q.h.api.enrollCalls).toBe(q.initial.enrollments + 2);
        expect(q.signing).not.toHaveBeenCalled();
        let newResult: { ok: boolean } | undefined;
        const newDelete = q.h.controller.deleteDevice(DEVICES[1]!.deviceId).then((result) => {
          newResult = result;
          return result;
        });
        await q.gates[1]!.entered.promise;
        q.gates[1]!.commit.resolve();
        let snapshot: ReturnType<typeof q.h.controller.getSnapshot> | undefined;
        try {
          await vi.waitFor(() => expect(newResult).toEqual({ ok: true }));
          snapshot = q.h.controller.getSnapshot();
          expect(snapshot).toMatchObject({
            profile: { userId: q.h.api.profile.userId },
            protected: true,
            protectionRequested: true,
            trafficBlocked: false,
            activeLocationId: "frankfurt-02",
          });
          expect(q.h.api.enrollCalls).toBe(q.initial.enrollments + 3);
          expect(q.signing).toHaveBeenCalledTimes(1);
          expect(q.h.api.proofs).toHaveLength(q.initial.proofs + 1);
        } finally {
          held.resolve();
          expect(await oldDelete).toEqual({ ok: false, superseded: true });
          await newDelete;
        }
        expect(q.h.controller.getSnapshot()).toEqual(snapshot);
      },
    );

    it(`does not count a failed DELETE as a slot or sign any proof, revoked=${String(revoked)}`, async () => {
      const q = await quota(revoked);
      q.deleting.mockRejectedValueOnce(new NetworkError("network"));
      expect(await q.h.controller.deleteDevice(DEVICES[0]!.deviceId)).toEqual({
        ok: false,
        commandError: "network_error",
      });
      expect(q.listing).not.toHaveBeenCalled();
      expect(q.h.api.enrollCalls).toBe(q.initial.enrollments);
      expect(q.signing).not.toHaveBeenCalled();
      expect(q.h.api.deletedDevices).toEqual([]);
      expect(q.h.controller.getSnapshot()).toMatchObject({
        protectionRequested: true,
        protected: false,
        trafficBlocked: true,
      });
    });

    it.each(["disconnect", "connect"] as const)(
      `rejects queued recovery after a newer %s during the first retry, revoked=${String(revoked)}`,
      async (action) => {
        const q = await quota(revoked);
        const commands = await start(q);
        const held = deferred();
        q.controls.heldEnrollment = held;
        q.refill.add(DEVICES[0]!.deviceId);
        q.gates[0]!.commit.resolve();
        await q.enrollmentEntered.promise;
        q.gates[1]!.commit.resolve();
        await vi.waitFor(() => expect(q.listing).toHaveBeenCalledTimes(2));
        const actionResult =
          action === "connect"
            ? await q.h.controller.connect("frankfurt-02")
            : await q.h.controller.disconnect();
        expect(actionResult).toEqual({ ok: true });
        const snapshot = q.h.controller.getSnapshot();
        const enrollmentCount = q.h.api.enrollCalls;
        const proofCount = q.h.api.proofs.length;
        held.resolve();
        expect(await Promise.all(commands)).toEqual([
          { ok: false, superseded: true },
          { ok: false, superseded: true },
        ]);
        expect(q.h.controller.getSnapshot()).toEqual(snapshot);
        expect(q.h.api.enrollCalls).toBe(enrollmentCount);
        expect(q.h.api.proofs).toHaveLength(proofCount);
        expect(snapshot).toMatchObject({
          protectionRequested: action === "connect",
          protected: action === "connect",
          trafficBlocked: false,
          ...(action === "connect" ? { activeLocationId: "frankfurt-02" } : {}),
        });
      },
    );

    for (const account of ["same", "different"] as const) {
      it.each(["delete", "get"] as const)(
        `ignores late %s 401 after ${account}-account login, revoked=${String(revoked)}`,
        async (phase) => {
          const q = await quota(revoked);
          const oldReply = deferred<never>();
          const entered = deferred();
          const request = phase === "delete" ? q.deleting : q.listing;
          request.mockImplementationOnce(async () => {
            entered.resolve();
            return oldReply.promise;
          });
          const deleting = q.h.controller.deleteDevice(DEVICES[0]!.deviceId);
          if (phase === "get") {
            await q.gates[0]!.entered.promise;
            q.gates[0]!.commit.resolve();
          }
          await entered.promise;
          expect(await q.h.controller.logout()).toEqual({ ok: true });
          q.h.api.auth = { ...AUTH, accessToken: "new-login-token" };
          q.h.api.profile = {
            ...PROFILE,
            userId: account === "same" ? PROFILE.userId : "account-b",
            email: "new-login@example.invalid",
          };
          expect(await q.h.controller.login(q.h.api.profile.email, "synthetic")).toEqual({
            ok: true,
          });
          const snapshot = q.h.controller.getSnapshot();
          const enrollmentCount = q.h.api.enrollCalls;
          oldReply.reject(new ApiError("unauthorized", 401));
          expect(await deleting).toEqual({ ok: false, superseded: true });
          expect(q.h.controller.getSnapshot()).toEqual(snapshot);
          expect(q.h.api.enrollCalls).toBe(enrollmentCount);
          expect(q.signing).not.toHaveBeenCalled();
          expect(q.h.controller.getSnapshot()).toMatchObject({
            profile: { userId: q.h.api.profile.userId },
            protectionRequested: false,
            protected: false,
            trafficBlocked: false,
            error: null,
          });
        },
      );
    }

    it(`invalidates the current account on its own follow-up GET 401 without retrying, revoked=${String(revoked)}`, async () => {
      const q = await quota(revoked);
      q.listing.mockRejectedValueOnce(new ApiError("unauthorized", 401));
      const deleting = q.h.controller.deleteDevice(DEVICES[0]!.deviceId);
      await q.gates[0]!.entered.promise;
      q.gates[0]!.commit.resolve();
      expect(await deleting).toEqual({ ok: false, commandError: "unauthorized" });
      expect(q.h.api.enrollCalls).toBe(q.initial.enrollments);
      expect(q.signing).not.toHaveBeenCalled();
      expect(q.h.controller.getSnapshot()).toMatchObject({
        profile: null,
        protectionRequested: true,
        protected: false,
        trafficBlocked: true,
        error: "unauthorized",
      });
    });

    it.each(["same", "different"] as const)(
      `does not send a DELETE after its identity read crosses %s-account login, revoked=${String(revoked)}`,
      async (account) => {
        const q = await quota(revoked);
        const entered = deferred();
        const identity = deferred<string | null>();
        vi.spyOn(q.h.identity, "getDeviceId").mockImplementationOnce(async () => {
          entered.resolve();
          return identity.promise;
        });
        const deleting = q.h.controller.deleteDevice(DEVICES[0]!.deviceId);
        const result = deleting.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await entered.promise;
        expect(await q.h.controller.disconnect()).toEqual({ ok: true });
        q.h.api.auth = { ...AUTH, accessToken: "identity-read-new-token" };
        q.h.api.profile = {
          ...PROFILE,
          userId: account === "same" ? PROFILE.userId : "identity-read-account-b",
        };
        expect(await q.h.controller.login(q.h.api.profile.email, "synthetic")).toEqual({
          ok: true,
        });
        const snapshot = q.h.controller.getSnapshot();
        identity.resolve(null);
        expect(await result).toEqual({ value: { ok: false, superseded: true } });
        expect(q.deleting).not.toHaveBeenCalled();
        expect(q.h.controller.getSnapshot()).toEqual(snapshot);
        expect(q.h.api.enrollCalls).toBe(q.initial.enrollments);
        expect(q.signing).not.toHaveBeenCalled();
      },
    );
  }
});
