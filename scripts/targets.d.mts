// SPDX-License-Identifier: MPL-2.0

export interface BuildManifest {
  version: string;
  key?: string;
  browser_specific_settings?: { gecko: { id: string } };
}
export const TARGETS: string[];
export const EXPECTED_IDENTITIES: Record<string, string>;
export function assertTarget(target: string): string;
export function selectTargets(args?: string[]): string[];
export function distributionDirectory(target: string): string;
export function publicKeyId(key: unknown): string;
export function manifestFor(target: string): Promise<BuildManifest>;
export function manifestBytes(manifest: BuildManifest): string;
