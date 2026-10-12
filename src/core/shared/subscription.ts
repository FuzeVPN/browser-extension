// SPDX-License-Identifier: MPL-2.0

import { decodeSubscription, type BillingSubscription } from "../api/types";

/** Restore display metadata without trusting a different schema than the API.
 * Older caches omitted offer/start details; entitlement and expiry remain required. */
export function normalizeSubscription(value: unknown): BillingSubscription | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const subscription = value as Record<string, unknown>;
  return decodeSubscription({
    status: subscription.status,
    has_access: subscription.hasAccess,
    offer_id: subscription.offerId ?? null,
    started_at: subscription.startedAt ?? null,
    expires_at: subscription.expiresAt,
    renews_automatically: subscription.renewsAutomatically,
  });
}
