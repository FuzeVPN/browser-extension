// SPDX-License-Identifier: MPL-2.0

import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

const root = resolve(import.meta.dirname, "..");
const source = await readFile(resolve(root, "assets/brand/fuzevpn-mark.svg"), "utf8");
const output = resolve(root, "assets/icons");
await mkdir(output, { recursive: true });

const variants = {
  disconnected: { color: "#bd2c2c", label: "OFF" },
  connected: { color: "#0f8a6a", label: "ON" },
  reconnecting: { color: "#c66a08", label: "…" },
  error: { color: "#bd2c2c", label: "!" },
};

for (const [name, status] of Object.entries(variants)) {
  for (const size of [16, 32, 48, 128]) {
    await sharp(Buffer.from(source))
      .resize(size, size)
      .composite([{ input: Buffer.from(statusIndicator(size, status)) }])
      .png()
      .toFile(resolve(output, `${name}-${size}.png`));
  }
}

function statusIndicator(size, status) {
  const padding = Math.max(1, Math.round(size * 0.04));

  if (size <= 32) {
    const diameter = Math.max(6, Math.round(size * 0.34));
    const radius = diameter / 2;
    const center = size - padding - radius;
    const stroke = Math.max(1, Math.round(size * 0.035));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <circle cx="${center}" cy="${center}" r="${radius}" fill="${status.color}" stroke="#F3EFE6" stroke-width="${stroke}"/>
    </svg>`;
  }

  const height = Math.round(size * 0.22);
  const width = Math.round(size * (status.label.length >= 3 ? 0.34 : 0.27));
  const x = size - padding - width;
  const y = size - padding - height;
  const fontSize = Math.max(6, Math.round(height * 0.52));
  const stroke = Math.max(1, Math.round(size * 0.012));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" fill="${status.color}" stroke="#F3EFE6" stroke-width="${stroke}"/>
    <text x="${x + width / 2}" y="${y + height / 2}" fill="#ffffff" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="700" text-anchor="middle" dominant-baseline="central">${status.label}</text>
  </svg>`;
}
