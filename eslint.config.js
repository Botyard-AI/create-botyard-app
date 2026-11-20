import { javascript } from "@botyard/eslint-config/javascript"
import { node, tseslint } from "@botyard/eslint-config/node"
import { zeroAny } from "@botyard/eslint-config/zero-any"

// Root files only: the shared configs, release scripts and the Vitest config.
// Each package, template and example lints itself with its own eslint.config.js.
// Blocks (registry/blocks) are linted inside a generated app by
// scripts/check-blocks.mjs, with that app's config.
export default tseslint.config(
  {
    ignores: [
      "packages/**",
      "templates/**",
      "examples/**",
      "registry/blocks/**",
      "**/dist",
      "coverage",
    ],
  },
  ...node,
  ...zeroAny(import.meta.dirname),
  ...javascript
)
