// SPDX-License-Identifier: MPL-2.0

export const SOURCE_DIRECTORIES: string[];
export const SOURCE_ROOT_FILES: string[];
export function assertPublicEntry(name: string, contents: Uint8Array): void;
export function readPublicFile(file: string, name: string): Buffer;
export function readPublicTree(directory: string, prefix?: string): Map<string, Buffer>;
export function readPublicSources(): Map<string, Buffer>;
