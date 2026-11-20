// SPDX-License-Identifier: MPL-2.0

/**
 * Reports the errors which a page dispatches without throwing.
 *
 * Playwright's "pageerror" is given the uncaught exceptions of a page. A browser also
 * reports some faults as an error event of the window alone, with a message and no
 * exception: a ResizeObserver whose callback resizes what it observes, for instance. The
 * extensions page of the browser lists those among the errors of the extension.
 *
 * Call it before the page loads. `report` receives each message.
 */
export async function reportErrorEvents(page, report) {
  await page.exposeFunction("reportErrorEvent", (message) => report(String(message)));
  await page.addInitScript(() => {
    window.addEventListener("error", (event) => {
      // An uncaught exception carries its error, and is already a "pageerror".
      if (!event.error) void window.reportErrorEvent(event.message);
    });
  });
}
