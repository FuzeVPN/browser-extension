// SPDX-License-Identifier: MPL-2.0

export interface AuthSession {
  accessToken: string;
  expiresAt: string;
}

export interface ExtensionCodeExchange {
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export interface Profile {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  countryCode: string;
}

export interface BillingSubscription {
  status: string;
  hasAccess: boolean;
  offerId: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  renewsAutomatically: boolean;
}

export interface Location {
  id: string;
  city: string;
  countryCode: string;
  displayName: string;
  supportedProtocols: string[];
}

export interface ProxySession {
  id: string;
  locationId: string;
  scheme: "https";
  host: string;
  port: number;
  username: string;
  password: string;
  issuedAt: string;
  expiresAt: string;
  refreshAfterSeconds: number;
}

export interface BrowserDeviceEnrollment {
  deviceId: string;
  name: string;
  kind: "browser_extension";
  createdAt: string;
}

export interface DeviceProfile {
  protocol: string;
  status: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface Device {
  deviceId: string;
  name: string;
  kind: string;
  profiles: DeviceProfile[];
  createdAt: string;
}

export interface DeviceList {
  limit: number;
  devices: Device[];
}

export interface DeviceProof {
  deviceId: string;
  deviceTimestamp: number;
  deviceNonce: string;
  deviceSignature: string;
}

export interface ApiErrorPayload {
  error: string;
  retryAfterSeconds?: number;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function string(value: unknown): value is string {
  return typeof value === "string";
}

function nonEmptyString(value: unknown): value is string {
  return string(value) && value.trim().length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || string(value);
}

function dateString(value: unknown): value is string {
  return string(value) && Number.isFinite(Date.parse(value));
}

export function decodeAuthSession(value: unknown): AuthSession | null {
  const data = object(value);
  if (!data || !nonEmptyString(data.access_token) || !dateString(data.expires_at)) return null;
  return { accessToken: data.access_token, expiresAt: data.expires_at };
}

export function decodeProfile(value: unknown): Profile | null {
  const data = object(value);
  if (
    !data ||
    !nonEmptyString(data.user_id) ||
    !string(data.email) ||
    !string(data.first_name) ||
    !string(data.last_name) ||
    !string(data.country_code)
  )
    return null;
  return {
    userId: data.user_id,
    email: data.email,
    firstName: data.first_name,
    lastName: data.last_name,
    countryCode: data.country_code,
  };
}

export function decodeSubscription(value: unknown): BillingSubscription | null {
  const data = object(value);
  if (
    !data ||
    !string(data.status) ||
    typeof data.has_access !== "boolean" ||
    !nullableString(data.offer_id) ||
    !nullableString(data.started_at) ||
    !nullableString(data.expires_at) ||
    typeof data.renews_automatically !== "boolean"
  )
    return null;
  if (
    (data.started_at !== null && !dateString(data.started_at)) ||
    (data.expires_at !== null && !dateString(data.expires_at))
  )
    return null;
  return {
    status: data.status,
    hasAccess: data.has_access,
    offerId: data.offer_id,
    startedAt: data.started_at,
    expiresAt: data.expires_at,
    renewsAutomatically: data.renews_automatically,
  };
}

export function decodeLocations(value: unknown): Location[] | null {
  const root = object(value);
  if (!root || !Array.isArray(root.locations)) return null;
  const locations: Location[] = [];
  const identifiers = new Set<string>();
  for (const item of root.locations) {
    const data = object(item);
    if (
      !data ||
      !nonEmptyString(data.id) ||
      identifiers.has(data.id) ||
      !string(data.city) ||
      !string(data.country_code) ||
      !string(data.display_name) ||
      !Array.isArray(data.supported_protocols) ||
      !data.supported_protocols.every(string)
    )
      return null;
    identifiers.add(data.id);
    locations.push({
      id: data.id,
      city: data.city,
      countryCode: data.country_code,
      displayName: data.display_name,
      supportedProtocols: data.supported_protocols,
    });
  }
  return locations.filter((location) => location.supportedProtocols.includes("browser_proxy"));
}

export function decodeProxySession(value: unknown): ProxySession | null {
  const data = object(value);
  if (
    !data ||
    !nonEmptyString(data.id) ||
    !nonEmptyString(data.location_id) ||
    data.scheme !== "https" ||
    !string(data.host) ||
    !Number.isInteger(data.port) ||
    (data.port as number) < 1 ||
    (data.port as number) > 65_535 ||
    !string(data.username) ||
    !string(data.password) ||
    !dateString(data.issued_at) ||
    !dateString(data.expires_at) ||
    !Number.isSafeInteger(data.refresh_after_seconds) ||
    (data.refresh_after_seconds as number) < 1
  )
    return null;
  return {
    id: data.id,
    locationId: data.location_id,
    scheme: "https",
    host: data.host.toLowerCase(),
    port: data.port as number,
    username: data.username,
    password: data.password,
    issuedAt: data.issued_at,
    expiresAt: data.expires_at,
    refreshAfterSeconds: data.refresh_after_seconds as number,
  };
}

export function decodeBrowserDeviceEnrollment(value: unknown): BrowserDeviceEnrollment | null {
  const data = object(value);
  if (
    !data ||
    !nonEmptyString(data.device_id) ||
    !string(data.name) ||
    data.kind !== "browser_extension" ||
    !dateString(data.created_at)
  )
    return null;
  return {
    deviceId: data.device_id,
    name: data.name,
    kind: "browser_extension",
    createdAt: data.created_at,
  };
}

export function decodeDeviceList(value: unknown): DeviceList | null {
  const root = object(value);
  if (!root || !Number.isSafeInteger(root.limit) || (root.limit as number) < 1) return null;
  if (!Array.isArray(root.devices)) return null;
  const devices: Device[] = [];
  const identifiers = new Set<string>();
  for (const item of root.devices) {
    const data = object(item);
    if (
      !data ||
      !nonEmptyString(data.device_id) ||
      identifiers.has(data.device_id) ||
      !string(data.name) ||
      !string(data.kind) ||
      !dateString(data.created_at) ||
      !Array.isArray(data.profiles)
    )
      return null;
    identifiers.add(data.device_id);
    const profiles: DeviceProfile[] = [];
    for (const profileItem of data.profiles) {
      const profile = object(profileItem);
      if (
        !profile ||
        !string(profile.protocol) ||
        !string(profile.status) ||
        !dateString(profile.created_at) ||
        (profile.expires_at !== undefined &&
          profile.expires_at !== null &&
          !dateString(profile.expires_at))
      )
        return null;
      profiles.push({
        protocol: profile.protocol,
        status: profile.status,
        createdAt: profile.created_at,
        expiresAt: typeof profile.expires_at === "string" ? profile.expires_at : null,
      });
    }
    devices.push({
      deviceId: data.device_id,
      name: data.name,
      kind: data.kind,
      profiles,
      createdAt: data.created_at,
    });
  }
  return { limit: root.limit as number, devices };
}

export function decodeApiError(value: unknown): ApiErrorPayload | null {
  const data = object(value);
  if (!data || !string(data.error)) return null;
  const retry = data.retry_after_seconds;
  return {
    error: data.error,
    ...(typeof retry === "number" && Number.isFinite(retry) && retry >= 0
      ? { retryAfterSeconds: Math.ceil(retry) }
      : {}),
  };
}
