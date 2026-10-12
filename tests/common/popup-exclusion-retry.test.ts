// SPDX-License-Identifier: MPL-2.0

import { exclusionRetry, type ExclusionIntent } from "../../src/ui/popup/exclusion-retry";
import type {
  SiteExclusionPolicy,
  SiteExclusionsState,
} from "../../src/core/shared/site-exclusions";

const base: SiteExclusionPolicy = {
  revision: 4,
  enabled: true,
  entries: [{ domain: "example.com", includeSubdomains: true }],
};
const intent: ExclusionIntent = { base, target: { enabled: false, entries: [] } };
const ready: SiteExclusionsState = { saved: base, applied: base, pending: false, error: false };
const target = { revision: 5, ...intent.target };

describe("retrying a popup exclusion intent", () => {
  it("resubmits the original removal if the request failed before journal creation", () => {
    expect(exclusionRetry(intent, ready)).toEqual({
      type: "update_site_exclusions",
      expectedRevision: 4,
      enabled: false,
      entries: [],
    });
  });

  it("resumes the already staged target after an uncertain journal write", () => {
    expect(exclusionRetry(intent, { ...ready, saved: target, pending: true, error: true })).toEqual(
      {
        type: "retry_site_exclusions",
      },
    );
  });

  it("recognizes a committed target after the response was lost without writing again", () => {
    expect(exclusionRetry(intent, { ...ready, saved: target, applied: target })).toEqual({
      type: "complete",
    });
  });

  it("never overwrites a later revision, even when its contents happen to match the old base", () => {
    expect(exclusionRetry(intent, { ...ready, saved: { ...base, revision: 6 } })).toEqual({
      type: "conflict",
    });
  });

  it("does not resume somebody else's unfinished modification or bypass an unreadable journal", () => {
    for (const change of [{ pending: true }, { error: true }]) {
      expect(exclusionRetry(intent, { ...ready, ...change })).toEqual({ type: "conflict" });
    }
  });

  it("continues durable recovery when no local draft survives a popup restart", () => {
    expect(exclusionRetry(null, { ...ready, saved: target, pending: true })).toEqual({
      type: "retry_site_exclusions",
    });
  });
});
