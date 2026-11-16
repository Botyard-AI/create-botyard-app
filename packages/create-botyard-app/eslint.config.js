import { javascript } from "@botyard/eslint-config/javascript"
import { node, tseslint } from "@botyard/eslint-config/node"
import { zeroAny } from "@botyard/eslint-config/zero-any"

// templates/ is build output copied from the repository's templates/, which
// lint themselves; test/fixtures are template files, not this package's code.
export default tseslint.config(
  { ignores: ["dist", "templates", "test/fixtures"] },
  ...node,
  ...zeroAny(import.meta.dirname),
  ...javascript
)
