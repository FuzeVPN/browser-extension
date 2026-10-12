// SPDX-License-Identifier: MPL-2.0

/** Poll asynchronous browser reads without treating their Promise as a match.
 * Return the matching value so assertions inspect the state that satisfied the wait. */
export async function waitForRead(
  read,
  matches,
  { timeoutMs = 30000, intervalMs = 25, message = "Timed out waiting for browser state" } = {},
) {
  const timeoutError = new Error(message);
  let stopped = false;
  let deadlineTimer;
  let pollingTimer;
  async function poll() {
    for (;;) {
      const value = await read();
      if (stopped) throw timeoutError;
      const matched = await matches(value);
      if (stopped) throw timeoutError;
      if (matched) return value;
      await new Promise((resolve) => {
        pollingTimer = setTimeout(resolve, intervalMs);
      });
    }
  }
  try {
    return await Promise.race([
      poll(),
      new Promise((_, reject) => {
        deadlineTimer = setTimeout(() => reject(timeoutError), timeoutMs);
      }),
    ]);
  } finally {
    stopped = true;
    clearTimeout(deadlineTimer);
    clearTimeout(pollingTimer);
  }
}
