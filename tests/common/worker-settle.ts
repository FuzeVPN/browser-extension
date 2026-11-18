// SPDX-License-Identifier: MPL-2.0

/**
 * Waiting for a worker under test to finish what it has started.
 *
 * A worker's start is not a fixed number of turns of the event loop: it hashes with the
 * platform's cryptography and reads responses, which take time, not turns. A wait counted
 * in turns is long enough on an idle machine and too short on a busy one. The worker is
 * instead taken to be at rest once it has stopped using the browser it was given.
 */

let activity = 0;

/** Wraps a stand-in of a browser API: each call the worker makes to it is counted. */
export function watched<T extends object>(api: T): T {
  return new Proxy(api, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof member !== "function") return member;
      return (...parameters: unknown[]) => {
        activity += 1;
        return (member as (...parameters: unknown[]) => unknown).apply(target, parameters);
      };
    },
  });
}

/** One pause: long enough for what was started to reach the browser again. */
async function pause(): Promise<void> {
  for (let turn = 0; turn < 40; turn++) await new Promise<void>((done) => setImmediate(done));
  await new Promise<void>((done) => setTimeout(done, 5));
}

/** Resolves once the worker has made no call to its browser over two pauses in a row. */
export async function settleWorker(limitMs = 10_000): Promise<void> {
  const deadline = performance.now() + limitMs;
  let quiet = 0;
  while (quiet < 2) {
    if (performance.now() > deadline) throw new Error("The worker under test never came to rest");
    const before = activity;
    await pause();
    quiet = activity === before ? quiet + 1 : 0;
  }
}
