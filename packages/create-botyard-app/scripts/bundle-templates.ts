// Build step: bundles the repository's templates/<name>/ into this package's
// templates/ (see bundle.ts), then pins each template's workspace:*
// dependencies to their published versions (see pin.ts). Needs the npm
// registry, and fails if a template uses an unpublished version.

import path from "node:path"
import { fileURLToPath } from "node:url"
import { bundleTemplates } from "./bundle.ts"
import { npmRegistry, pinWorkspaceDependencies, readWorkspaceVersions } from "./pin.ts"

const packageDir = fileURLToPath(new URL("..", import.meta.url))
const repoRoot = path.resolve(packageDir, "../..")
const outDir = path.join(packageDir, "templates")

const names = await bundleTemplates({
  sourceDir: path.join(repoRoot, "templates"),
  outDir,
  root: repoRoot,
})
const workspace = await readWorkspaceVersions(repoRoot)
const registry = npmRegistry()
for (const name of names) {
  const pinned = await pinWorkspaceDependencies(path.join(outDir, name), workspace, registry)
  const list = [...pinned].map(([dep, version]) => `${dep}@${version}`).join(", ")
  const pins = list === "" ? "" : `, pinning ${list}`
  process.stdout.write(`Bundled template ${name}${pins}\n`)
}
if (names.length === 0) process.stdout.write("Bundled templates: none\n")
