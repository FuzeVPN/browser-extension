// SPDX-License-Identifier: MPL-2.0

/** The proxy endpoint supplied by the session: IPv4 or DNS name, never IPv6. */
export function isVpnNodeAddress(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value) &&
    !value.includes("..")
  );
}

export function isIpv4(ip: unknown): ip is string {
  return (
    typeof ip === "string" &&
    /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(ip) &&
    ip.split(".").every((part) => Number(part) <= 255)
  );
}

export function isPublicIpv4(ip: string): boolean {
  if (!isIpv4(ip)) return false;
  const octets = ip.split(".").map(Number);
  if (octets.some((part) => part > 255)) return false;
  const [first, second, third] = octets;
  if (first === undefined || second === undefined || third === undefined) return false;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 &&
      ((second === 0 && (third === 0 || third === 2)) ||
        second === 168 ||
        (second === 88 && third === 99))) ||
    (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) ||
    (first === 203 && second === 0 && third === 113)
  );
}
