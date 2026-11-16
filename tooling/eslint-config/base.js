// Copied verbatim from Botyard-AI/botyard packages/eslint-config/base.js,
// read at main fa57165119aef36714849776811eb843f11dc3a2 (the file was last
// changed in 0fa91b63a87bb97e61c6a3a4f267fec3d14b0855). Do not edit it here:
// change the monorepo, then re-sync as README.md describes. Rules local to
// this repository live in the other files here (zero-any.js, javascript.js).

import js from "@eslint/js"
import sonarjs from "eslint-plugin-sonarjs"
import tseslint from "typescript-eslint"
import prettier from "eslint-config-prettier"

/**
 * Base ESLint config for all TypeScript packages.
 *
 * Includes: js recommended, typescript-eslint strict + stylistic,
 * core ESLint rules, full SonarJS cherry-pick set, prettier compat.
 *
 * Usage:
 *   import { base } from "@botyard/eslint-config/base"
 *   export default tseslint.config(...base, { ignores: ["dist"] })
 */

/** Shared typescript-eslint overrides */
const tsOverrides = {
  "@typescript-eslint/no-non-null-assertion": "error",
  "@typescript-eslint/no-empty-function": ["error", { allow: ["arrowFunctions"] }],
  "@typescript-eslint/consistent-type-definitions": ["error", "type"],
}

/** Core ESLint rules */
const coreRules = {
  eqeqeq: ["error", "always"],
  "no-console": "warn",
  "no-eval": "error",
  "no-implied-eval": "error",
  "no-alert": "warn",
  "no-template-curly-in-string": "error",
  "no-constructor-return": "error",
  "no-promise-executor-return": "error",
  "no-self-compare": "error",
  "no-unreachable-loop": "error",
  "no-new-wrappers": "error",
  "no-useless-concat": "error",
  "no-useless-return": "error",
  curly: ["error", "multi-line"],
  "object-shorthand": "warn",
  "prefer-template": "warn",
  "symbol-description": "error",
}

/** SonarJS cherry-picked rules (universal — no React-specific ones) */
const sonarRules = {
  // complexity
  "sonarjs/cognitive-complexity": ["error", 15],

  // logic / conditions
  "sonarjs/no-identical-conditions": "error",
  "sonarjs/no-all-duplicated-branches": "error",
  "sonarjs/no-duplicated-branches": "error",
  "sonarjs/no-gratuitous-expressions": "error",
  "sonarjs/no-identical-expressions": "error",
  "sonarjs/no-inverted-boolean-check": "error",
  "sonarjs/no-redundant-boolean": "error",
  "sonarjs/prefer-single-boolean-return": "error",

  // collections
  "sonarjs/no-collection-size-mischeck": "error",
  "sonarjs/no-element-overwrite": "error",
  "sonarjs/no-empty-collection": "error",
  "sonarjs/no-unused-collection": "error",

  // async / promises
  "sonarjs/no-use-of-empty-return-value": "error",
  "sonarjs/no-misleading-array-reverse": "error",
  "sonarjs/no-try-promise": "error",

  // style / quality
  "sonarjs/no-alphabetical-sort": "error",
  "sonarjs/no-async-constructor": "error",
  "sonarjs/reduce-initial-value": "error",
  "sonarjs/prefer-promise-shorthand": "error",
  "sonarjs/no-nested-conditional": "error",
  "sonarjs/no-nested-template-literals": "error",
  "sonarjs/no-nested-assignment": "error",
  "sonarjs/no-nested-functions": "error",
  "sonarjs/no-nested-incdec": "error",
  "sonarjs/no-nested-switch": "error",

  // bug prevention
  "sonarjs/no-unthrown-error": "error",
  "sonarjs/non-existent-operator": "error",
  "sonarjs/different-types-comparison": "error",
  "sonarjs/no-extra-arguments": "error",
  "sonarjs/comma-or-logical-or-case": "error",
  "sonarjs/array-callback-without-return": "error",
  "sonarjs/constructor-for-side-effects": "error",
  "sonarjs/new-operator-misuse": "error",
  "sonarjs/no-globals-shadowing": "error",
  "sonarjs/no-built-in-override": "error",
  "sonarjs/for-loop-increment-sign": "error",
  "sonarjs/no-useless-increment": "error",

  // code quality
  "sonarjs/no-collapsible-if": "error",
  "sonarjs/no-redundant-assignments": "error",
  "sonarjs/no-redundant-jump": "error",
  "sonarjs/no-inconsistent-returns": "error",
  "sonarjs/no-invariant-returns": "error",
  "sonarjs/prefer-immediate-return": "error",
  "sonarjs/no-identical-functions": "error",
  "sonarjs/no-dead-store": "error",
  "sonarjs/no-redundant-optional": "error",

  // testing
  "sonarjs/no-exclusive-tests": "error",
  "sonarjs/assertions-in-tests": "error",
  "sonarjs/no-empty-test-file": "error",
}

/** The base rules config object (without prettier) */
export const baseRules = {
  extends: [js.configs.recommended, ...tseslint.configs.strict, ...tseslint.configs.stylistic],
  files: ["**/*.{ts,tsx}"],
  languageOptions: {
    ecmaVersion: 2023,
  },
  plugins: {
    sonarjs,
  },
  rules: {
    ...tsOverrides,
    ...coreRules,
    ...sonarRules,
  },
}

/** Prettier compat — must be the last config object in any config array */
export const prettierConfig = prettier

/** Complete base config array — baseRules + prettier */
export const base = [baseRules, prettierConfig]

export { tseslint }
