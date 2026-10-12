// SPDX-License-Identifier: MPL-2.0

import { deflateRawSync, inflateRawSync } from "node:zlib";

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

function safeName(name) {
  if (
    typeof name !== "string" ||
    !name ||
    /[\\:]/.test(name) ||
    [...name].some((character) => character.charCodeAt(0) < 32) ||
    name.startsWith("/") ||
    name.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`Unsafe ZIP path: ${name}`);
  return name;
}

/** Fixed timestamp, ordering and compression make local release archives reproducible. */
export function createZip(entries) {
  const locals = [];
  const central = [];
  const seen = new Set();
  let offset = 0;
  for (const [name, contents] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    safeName(name);
    if (seen.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
    seen.add(name);
    const bytes = Buffer.from(contents);
    const filename = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(bytes, { level: 9 });
    if (filename.length > 65535 || bytes.length > 0xffffffff || compressed.length > 0xffffffff)
      throw new Error("ZIP64 is not supported for extension packages");
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12); // 1980-01-01; no build-machine timestamps.
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, compressed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt16LE(0x21, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += local.length + filename.length + compressed.length;
  }
  if (seen.size > 65535 || offset > 0xffffffff) throw new Error("ZIP64 is not supported");
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(seen.size, 8);
  end.writeUInt16LE(seen.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Read the strict archive format we publish, rejecting duplicates and inconsistent headers. */
export function readZip(bytes, { maxBytes = 64 * 1024 * 1024 } = {}) {
  bytes = Buffer.from(bytes);
  if (bytes.length < 22) throw new Error("Truncated ZIP");
  const end = bytes.length - 22;
  if (
    bytes.readUInt32LE(end) !== 0x06054b50 ||
    bytes.readUInt16LE(end + 4) ||
    bytes.readUInt16LE(end + 6) ||
    bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10) ||
    bytes.readUInt16LE(end + 20)
  )
    throw new Error("Unsupported ZIP end record");
  const count = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralOffset = bytes.readUInt32LE(end + 16);
  if (centralOffset + centralSize !== end) throw new Error("Invalid ZIP central directory");
  const result = new Map();
  let cursor = centralOffset;
  let localEnd = 0;
  let totalBytes = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error("Invalid ZIP entry record");
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42);
    const filename = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = safeName(filename.toString("utf8"));
    if (!Buffer.from(name, "utf8").equals(filename) || result.has(name))
      throw new Error("Invalid or duplicate ZIP filename");
    if (flags !== 0x800 || method !== 8 || extraLength || commentLength || offset !== localEnd)
      throw new Error("Unsupported ZIP entry layout");
    totalBytes += size;
    if (totalBytes > maxBytes || offset + 30 + nameLength + compressedSize > centralOffset)
      throw new Error("ZIP entry exceeds package limits");
    if (
      bytes.readUInt32LE(offset) !== 0x04034b50 ||
      bytes.readUInt16LE(offset + 6) !== flags ||
      bytes.readUInt16LE(offset + 8) !== method ||
      bytes.readUInt32LE(offset + 14) !== crc ||
      bytes.readUInt32LE(offset + 18) !== compressedSize ||
      bytes.readUInt32LE(offset + 22) !== size ||
      bytes.readUInt16LE(offset + 26) !== nameLength ||
      bytes.readUInt16LE(offset + 28) ||
      !bytes.subarray(offset + 30, offset + 30 + nameLength).equals(filename)
    )
      throw new Error("ZIP local and central headers differ");
    const dataStart = offset + 30 + nameLength;
    const contents = inflateRawSync(bytes.subarray(dataStart, dataStart + compressedSize), {
      maxOutputLength: Math.max(1, size),
    });
    if (contents.length !== size || crc32(contents) !== crc)
      throw new Error("Corrupt ZIP contents");
    result.set(name, contents);
    localEnd = dataStart + compressedSize;
    cursor += 46 + nameLength;
  }
  if (cursor !== end || localEnd !== centralOffset) throw new Error("Unexpected ZIP data");
  return result;
}
