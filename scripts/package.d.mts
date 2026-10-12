// SPDX-License-Identifier: MPL-2.0

export interface ArchiveResult {
  archive: string;
  sha256: string;
  preserved: boolean;
}
export function safeOutput(path: string): Promise<string>;
export function verifyArchive(bytes: Uint8Array, expected: Record<string, string>): void;
export function publishArchive(options: {
  directory: string;
  name: string;
  entries: Iterable<readonly [string, Uint8Array]>;
  expected: Record<string, string>;
}): Promise<ArchiveResult>;
export function packageTarget(
  target: string,
): Promise<ArchiveResult & { target: string; version: string }>;
