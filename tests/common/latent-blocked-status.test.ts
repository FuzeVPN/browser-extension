// SPDX-License-Identifier: MPL-2.0

import {
  emptySiteExclusionRecord,
  type SiteExclusionRecord,
  type SiteExclusionStorage,
} from "../../src/core/storage/site-exclusion-storage";
import { authenticatedState, createHarness } from "./helpers";

const entry = { domain: "example.com", includeSubdomains: true };

class Policies implements SiteExclusionStorage {
  record: SiteExclusionRecord = emptySiteExclusionRecord();
  rejectCommit = false;

  async read() {
    return structuredClone(this.record);
  }

  async write(record: SiteExclusionRecord) {
    if (this.rejectCommit && !record.pending) throw new Error("exclusion commit unavailable");
    this.record = structuredClone(record);
  }
}

describe("the blocked status once its traffic guard is released", () => {
  it("returns to disconnected after a failed exclusion change is retried successfully", async () => {
    const policies = new Policies();
    const h = createHarness({ persisted: authenticatedState(), siteExclusionStorage: policies });
    await h.controller.initialize();
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "disconnected",
      protectionRequested: false,
      trafficBlocked: false,
    });

    // Without a connection, an exclusion change which cannot commit keeps traffic guarded.
    policies.rejectCommit = true;
    await expect(
      h.controller.updateSiteExclusions(policies.record.saved.revision, true, [entry]),
    ).rejects.toThrow("exclusion commit unavailable");
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "blocked",
      protectionRequested: false,
      trafficBlocked: true,
      siteExclusions: { pending: true, error: true },
    });

    // The retry commits the policy and releases that guard: nothing blocks any more.
    policies.rejectCommit = false;
    await h.controller.retrySiteExclusions();
    expect(h.safety.status.trafficBlocked).toBe(false);
    expect(h.controller.getSnapshot()).toMatchObject({
      protectionRequested: false,
      trafficBlocked: false,
      siteExclusions: { pending: false, error: false },
    });
    expect(h.controller.getSnapshot().status).toBe("disconnected");
  });
});
