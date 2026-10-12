// SPDX-License-Identifier: MPL-2.0

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "assets/icons/**",
      "audit/local/**",
      "releases/**",
      "publication/**",
      "reference/**",
      "private/**",
      "doc private/**",
      "conserver/**",
      "prive/**",
      "reference/**",
    ],
  },
  {
    files: ["**/*.ts"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.browser, ...globals.webextensions, ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      "@typescript-eslint/consistent-type-definitions": ["error", "interface"],
      "@typescript-eslint/no-unnecessary-type-parameters": "off",
    },
  },
  {
    files: ["src/core/**/*.ts", "src/ui/**/*.ts"],
    rules: {
      "no-restricted-globals": ["error", "chrome", "browser"],
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/no-empty-function": "off",
    },
  },
  {
    files: [
      "scripts/**/*.mjs",
      "tests/browser/**/*.mjs",
      "tests/reconstruction/**/*.mjs",
      "eslint.config.mjs",
    ],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["scripts/browser-*.mjs", "tests/browser/**/*.mjs"],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions } },
  },
  // These globals are installed by the isolated extensions used in evaluate().
  {
    files: ["tests/browser/chromium/browser-device-identity-check.mjs"],
    languageOptions: { globals: { identityModule: "readonly" } },
  },
  {
    files: ["tests/browser/chromium/browser-network-fixes-check.mjs"],
    languageOptions: { globals: { audit: "readonly" } },
  },
  {
    files: ["tests/browser/chromium/browser-legacy-worker-check.mjs"],
    languageOptions: {
      globals: {
        fixtureCommands: "readonly",
        fixturePublish: "readonly",
        restoreFixtureTransport: "readonly",
      },
    },
  },
);
