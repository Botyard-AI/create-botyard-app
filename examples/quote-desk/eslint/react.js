// Copied verbatim from Botyard-AI/botyard packages/eslint-config/react.js,
// read at main fa57165119aef36714849776811eb843f11dc3a2 (the file was last
// changed in cda41f6069ce6e97a0fe20e8c6cd9c459772ab9a). Do not edit it here:
// change the monorepo, then re-sync as README.md describes. Rules local to
// this repository live in the other files here (zero-any.js, javascript.js).

import globals from "globals"
import reactPlugin from "eslint-plugin-react"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import tseslint from "typescript-eslint"
import { baseRules, prettierConfig } from "./base.js"

/**
 * React ESLint config — extends base with React plugins, browser globals,
 * and React-specific SonarJS rules.
 *
 * Usage:
 *   import { reactConfig } from "@botyard/eslint-config/react"
 *   export default tseslint.config(...reactConfig, { ignores: ["dist"] })
 */
export const reactConfig = [
  baseRules,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
    settings: {
      react: { version: "detect" },
    },
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // React hooks
      ...reactHooks.configs.recommended.rules,
      "react-hooks/exhaustive-deps": "error",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "react/no-multi-comp": ["error", { ignoreStateless: false }],

      // SonarJS React-specific
      "sonarjs/no-hook-setter-in-body": "error",
      "sonarjs/jsx-no-leaked-render": "error",
      "sonarjs/no-useless-react-setstate": "error",
      "sonarjs/prefer-read-only-props": "error",
      "sonarjs/no-uniq-key": "error",

      // Metro (React Native) does not resolve `.js` → `.ts`, and Vite is
      // happy without extensions either. Forbid `.js`/`.jsx`/`.mjs`/`.cjs`
      // on relative imports so frontend code bundles cleanly under both.
      // Node-runtime packages use `./node` instead — they need the extensions.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportDeclaration[source.value=/^\\.{1,2}\\/.*\\.(js|jsx|mjs|cjs)$/]",
          message:
            "Do not include a .js/.jsx/.mjs/.cjs extension in relative imports — Metro can't resolve it. Use an extensionless import.",
        },
        {
          selector:
            "ExportAllDeclaration[source.value=/^\\.{1,2}\\/.*\\.(js|jsx|mjs|cjs)$/]",
          message:
            "Do not include a .js/.jsx/.mjs/.cjs extension in relative re-exports — Metro can't resolve it. Use an extensionless import.",
        },
        {
          selector:
            "ExportNamedDeclaration[source.value=/^\\.{1,2}\\/.*\\.(js|jsx|mjs|cjs)$/]",
          message:
            "Do not include a .js/.jsx/.mjs/.cjs extension in relative re-exports — Metro can't resolve it. Use an extensionless import.",
        },
      ],
    },
  },
  prettierConfig,
]

export { tseslint }
