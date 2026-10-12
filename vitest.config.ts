// SPDX-License-Identifier: MPL-2.0

import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: { "@platform": resolve(import.meta.dirname, "src/platform/firefox") } },
        test: {
          name: "common-and-firefox",
          include: ["tests/common/**/*.test.ts", "tests/adapters/firefox/**/*.test.ts"],
          environment: "node",
          clearMocks: true,
          globals: true,
        },
      },
      {
        resolve: { alias: { "@platform": resolve(import.meta.dirname, "src/platform/chromium") } },
        test: {
          name: "chromium",
          include: ["tests/adapters/chromium/**/*.test.ts"],
          environment: "node",
          clearMocks: true,
          globals: true,
        },
      },
    ],
  },
});
