// Local to create-botyard-app; NOT part of the monorepo copy. The monorepo
// configs lint TypeScript only, but this repository ships plain JavaScript too:
// the placeholder packages, the ESLint configs themselves and release scripts.
// This gives those files ESLint's recommended rules and Node globals.
//
// Usage, in an eslint.config.js:
//   import { javascript } from "@botyard/eslint-config/javascript"
//   export default tseslint.config(...node, ...javascript)

import js from "@eslint/js"
import globals from "globals"

export const javascript = [
  {
    ...js.configs.recommended,
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: globals.node,
    },
  },
]
