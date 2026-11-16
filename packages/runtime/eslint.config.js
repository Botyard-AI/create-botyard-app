import { javascript } from "@botyard/eslint-config/javascript"
import { node, tseslint } from "@botyard/eslint-config/node"
import { zeroAny } from "@botyard/eslint-config/zero-any"

export default tseslint.config(
  { ignores: ["dist"] },
  ...node,
  ...zeroAny(import.meta.dirname),
  ...javascript
)
