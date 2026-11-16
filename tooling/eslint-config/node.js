// Copied verbatim from Botyard-AI/botyard packages/eslint-config/node.js,
// read at main fa57165119aef36714849776811eb843f11dc3a2 (the file was last
// changed in cd523b5e6e2b03af94c3db36c14fc1c532a634f1). Do not edit it here:
// change the monorepo, then re-sync as README.md describes. Rules local to
// this repository live in the other files here (zero-any.js, javascript.js).

import globals from "globals"
import tseslint from "typescript-eslint"
import { baseRules, prettierConfig } from "./base.js"

/**
 * Node.js ESLint config — extends base with Node globals.
 *
 * Usage:
 *   import { node } from "@botyard/eslint-config/node"
 *   export default tseslint.config(...node, { ignores: ["dist"] })
 */
export const node = [
  baseRules,
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // no-alert is browser-only, not relevant for Node
      "no-alert": "off",
    },
  },
  prettierConfig,
]

export { tseslint }
