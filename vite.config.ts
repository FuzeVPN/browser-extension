// SPDX-License-Identifier: MPL-2.0

import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export type BuildTarget = "chrome" | "edge" | "firefox";

export function makeBuildConfig(target: BuildTarget, outDir?: string) {
  const platform = target === "firefox" ? "firefox" : "chromium";
  return defineConfig({
    root: resolve(import.meta.dirname, "src/ui"),
    publicDir: resolve(import.meta.dirname, "assets"),
    resolve: { alias: { "@platform": resolve(import.meta.dirname, `src/platform/${platform}`) } },
    build: {
      outDir: outDir ?? resolve(import.meta.dirname, `dist/${target}`),
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: {
        input: {
          popup: resolve(import.meta.dirname, "src/ui/popup/popup.html"),
          diagnostics: resolve(import.meta.dirname, "src/ui/diagnostics-page/diagnostics.html"),
          worker: resolve(import.meta.dirname, "src/core/background/service-worker.ts"),
        },
        output: {
          entryFileNames: (entry) =>
            entry.name === "worker" ? "background/service-worker.js" : "assets/[name]-[hash].js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  });
}

export default makeBuildConfig("firefox");
