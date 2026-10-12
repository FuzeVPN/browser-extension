// SPDX-License-Identifier: MPL-2.0

// Exercise the real country and city disclosure controls before checking server rows.
// Expanding a group must never select a server or create a proxy session.
export async function expandAllLocations(page) {
  for (let count = 0; count < 1000; count += 1) {
    const disclosure = page.locator(
      '#locationList .location-disclosure[aria-expanded="false"]:visible',
    );
    if ((await disclosure.count()) === 0) return;
    await disclosure.first().click();
  }
  throw new Error("Location hierarchy did not finish expanding");
}
