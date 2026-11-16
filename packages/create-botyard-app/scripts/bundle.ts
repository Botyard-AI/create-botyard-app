// Copies template directories into the package's templates/, which is what npm
// publishes and the CLI copies from. Used by bundle-templates.ts at build time.
//
// - Skips installs and build output (node_modules, dist, coverage, ...) and
//   local env files.
// - Stores .gitignore and .npmrc under names npm keeps (see BUNDLED_NAMES).
// - Follows symlinks, so a template can link a shared file such as the ESLint
//   config, but only to targets inside `root`. The bundle itself contains
//   regular files and directories only.

import { copyFile, mkdir, readdir, realpath, rm, stat } from "node:fs/promises"
import path from "node:path"
import { BUNDLED_NAMES } from "../src/scaffold.ts"

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".turbo", ".vite"])
const SKIP_FILE = /^\.env(?!\.example$)|\.tsbuildinfo$|^\.DS_Store$/

type BundleOptions = {
  /** Directory with one sub-directory per template. Missing means no templates. */
  sourceDir: string
  /** Replaced entirely. */
  outDir: string
  /** Symlinks must resolve inside this directory. */
  root: string
}

export async function bundleTemplates(options: BundleOptions): Promise<string[]> {
  const { sourceDir, outDir } = options
  const root = await realpath(options.root)
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  let names: string[] = []
  try {
    names = (await readdir(sourceDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err
  }
  for (const name of names) {
    const from = await realpath(path.join(sourceDir, name))
    await copyTree(from, path.join(outDir, name), root, new Set([from]))
  }
  return names
}

// `from` is a real path; `ancestors` holds the real paths being copied above it,
// so a symlink back to one of them is a cycle.
async function copyTree(
  from: string,
  to: string,
  root: string,
  ancestors: ReadonlySet<string>
): Promise<void> {
  await mkdir(to)
  for (const entry of await readdir(from)) {
    if (SKIP_DIRS.has(entry) || SKIP_FILE.test(entry)) continue
    const source = path.join(from, entry)
    const real = await realpath(source)
    if (real !== root && !real.startsWith(root + path.sep)) {
      throw new Error(`${source} resolves outside ${root} (${real}).`)
    }
    const info = await stat(real)
    if (info.isDirectory()) {
      if (ancestors.has(real)) throw new Error(`${source} links back to ${real}.`)
      await copyTree(real, path.join(to, entry), root, new Set([...ancestors, real]))
    } else if (info.isFile()) {
      await copyFile(real, path.join(to, BUNDLED_NAMES.get(entry) ?? entry))
    } else {
      throw new Error(`${source} is not a regular file or directory.`)
    }
  }
}
