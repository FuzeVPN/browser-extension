// SPDX-License-Identifier: MPL-2.0

export function crc32(bytes: Uint8Array): number;
export function createZip(entries: Iterable<readonly [string, Uint8Array]>): Buffer;
export function readZip(bytes: Uint8Array, options?: { maxBytes?: number }): Map<string, Buffer>;
