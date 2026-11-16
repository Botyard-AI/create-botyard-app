// Pins a bundled template's workspace dependencies to published versions.
//
// In this repository a template depends on our own packages as "workspace:*",
// so its tests and build use the sources at the same commit. A generated app
// installs from npm instead, so the bundle replaces each "workspace:*" with
// the exact version in that package's package.json, and fails unless:
//
// - that version is the package's current `latest` on npm, and
// - the template's package-lock.json, if any, locks that same version with
//   the integrity npm reports for it.

import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

/** What the registry says about a package. */
export type Published = {
  /** The `latest` dist-tag; undefined when the package is not published. */
  readonly latest: string | undefined
  /** The `dist.integrity` of a published version. */
  readonly integrity: (version: string) => string | undefined
}

export type Registry = (name: string) => Promise<Published>

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const

/** Name to version of every publishable package under `<root>/packages`. */
export async function readWorkspaceVersions(root: string): Promise<Map<string, string>> {
  const versions = new Map<string, string>()
  const dir = path.join(root, "packages")
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pkg = await readJsonObject(path.join(dir, entry.name, "package.json"))
    const { name, version } = pkg
    if (pkg["private"] === true || typeof name !== "string" || typeof version !== "string") continue
    versions.set(name, version)
  }
  return versions
}

/**
 * Rewrites `workspace:*` dependencies in `<templateDir>/package.json` to exact
 * published versions. Returns the pinned names and versions.
 */
export async function pinWorkspaceDependencies(
  templateDir: string,
  workspace: ReadonlyMap<string, string>,
  registry: Registry
): Promise<Map<string, string>> {
  const pkgFile = path.join(templateDir, "package.json")
  const pkg = await readJsonObject(pkgFile)
  const pinned = new Map<string, string>()
  for (const field of DEPENDENCY_FIELDS) {
    const deps = pkg[field]
    if (!isJsonObject(deps)) continue
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue
      const version = await publishedVersion(pkgFile, name, spec, workspace, registry)
      deps[name] = version
      pinned.set(name, version)
    }
  }
  if (pinned.size === 0) return pinned

  await checkLockfile(templateDir, pinned, registry)
  await writeFile(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`)
  return pinned
}

/** The version a `workspace:` dependency pins to; throws unless it is npm's latest. */
async function publishedVersion(
  pkgFile: string,
  name: string,
  spec: string,
  workspace: ReadonlyMap<string, string>,
  registry: Registry
): Promise<string> {
  if (spec !== "workspace:*") {
    throw new Error(`${pkgFile}: ${name} is "${spec}"; templates use "workspace:*".`)
  }
  const version = workspace.get(name)
  if (version === undefined) {
    throw new Error(`${pkgFile}: ${name} is not a publishable package in this repository.`)
  }
  const { latest } = await registry(name)
  if (latest !== version) {
    throw new Error(
      `${pkgFile}: ${name} is ${version} here but npm's latest is ${latest ?? "nothing"}. ` +
        `Publish ${name}@${version} before releasing a template that uses it.`
    )
  }
  return version
}

async function checkLockfile(
  templateDir: string,
  pinned: ReadonlyMap<string, string>,
  registry: Registry
): Promise<void> {
  const lockFile = path.join(templateDir, "package-lock.json")
  let lock
  try {
    lock = await readJsonObject(lockFile)
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return
    throw err
  }
  const packages = isJsonObject(lock["packages"]) ? lock["packages"] : {}
  for (const [name, version] of pinned) {
    const entry = packages[`node_modules/${name}`]
    const integrity = (await registry(name)).integrity(version)
    if (
      !isJsonObject(entry) ||
      entry["version"] !== version ||
      integrity === undefined ||
      entry["integrity"] !== integrity
    ) {
      throw new Error(
        `${lockFile} does not lock ${name}@${version} as published. ` +
          "Regenerate it with scripts/lock-template.sh."
      )
    }
  }
}

/** Reads package metadata from the public npm registry. */
export function npmRegistry(base = "https://registry.npmjs.org"): Registry {
  return async (name) => {
    const res = await fetch(`${base}/${name.replace("/", "%2f")}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(30_000),
    })
    if (res.status === 404) return { latest: undefined, integrity: () => undefined }
    if (!res.ok) throw new Error(`npm registry: ${name}: HTTP ${String(res.status)}`)
    const doc: unknown = await res.json()
    const tags = isJsonObject(doc) && isJsonObject(doc["dist-tags"]) ? doc["dist-tags"] : {}
    const versions = isJsonObject(doc) && isJsonObject(doc["versions"]) ? doc["versions"] : {}
    const latest = tags["latest"]
    return {
      latest: typeof latest === "string" ? latest : undefined,
      integrity: (version) => {
        const meta = versions[version]
        const dist = isJsonObject(meta) && isJsonObject(meta["dist"]) ? meta["dist"] : {}
        const value = dist["integrity"]
        return typeof value === "string" ? value : undefined
      },
    }
  }
}

async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  const json: unknown = JSON.parse(await readFile(file, "utf8"))
  if (!isJsonObject(json)) throw new Error(`${file} is not a JSON object.`)
  return json
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
