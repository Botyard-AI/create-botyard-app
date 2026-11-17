// Build step: bundles the repository's templates/<name>/ into this package's
// templates/. See bundle.ts.

import path from "node:path"
import { fileURLToPath } from "node:url"
import { bundleTemplates } from "./bundle.ts"

const packageDir = fileURLToPath(new URL("..", import.meta.url))
const repoRoot = path.resolve(packageDir, "../..")

const names = await bundleTemplates({
  sourceDir: path.join(repoRoot, "templates"),
  outDir: path.join(packageDir, "templates"),
  root: repoRoot,
})
process.stdout.write(`Bundled templates: ${names.join(", ") || "none"}\n`)
