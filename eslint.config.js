import { javascript } from "@botyard/eslint-config/javascript"
import { node, tseslint } from "@botyard/eslint-config/node"
import { zeroAny } from "@botyard/eslint-config/zero-any"

// Root files only: the shared configs, release scripts and the Vitest config.
// Each package and template lints itself with its own eslint.config.js.
export default tseslint.config(
  { ignores: ["packages/**", "templates/**", "**/dist", "coverage"] },
  ...node,
  ...zeroAny(import.meta.dirname),
  ...javascript
)
