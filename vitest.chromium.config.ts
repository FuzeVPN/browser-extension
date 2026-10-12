// SPDX-License-Identifier: MPL-2.0

import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@platform": resolve(import.meta.dirname, "src/platform/chromium") } },
  test: {
    root: import.meta.dirname,
    environment: "node",
    globals: true,
    clearMocks: true,
    include: ["tests/adapters/chromium/**/*.test.ts"],
  },
});
