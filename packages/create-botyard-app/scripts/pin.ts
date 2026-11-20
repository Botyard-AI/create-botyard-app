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
//
// One exception, for CI only (`allowUnpublishedBump`, set by ci.yml through
// BOTYARD_ALLOW_UNPUBLISHED_BUMP): a version strictly ahead of npm's latest is
// a release bump whose PR must pass CI before release.yml can publish it from
// main. It is pinned as is, without the lockfile check, which cannot pass until
// it is published. A version equal to latest gets every check, and anything
// else still fails. The default, used locally and by release.yml, is strict,
// so a published CLI never pins an unpublished version.

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

type PinOptions = {
  /** CI only: pin a version ahead of npm's latest without the lockfile check. */
  readonly allowUnpublishedBump?: boolean
}

/** Whether ci.yml asked for `allowUnpublishedBump` (BOTYARD_ALLOW_UNPUBLISHED_BUMP=1). */
export function pinOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): PinOptions {
  return { allowUnpublishedBump: env["BOTYARD_ALLOW_UNPUBLISHED_BUMP"] === "1" }
}

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
  registry: Registry,
  options: PinOptions = {}
): Promise<Map<string, string>> {
  const pkgFile = path.join(templateDir, "package.json")
  const pkg = await readJsonObject(pkgFile)
  const pinned = new Map<string, string>()
  const published = new Map<string, string>()
  for (const field of DEPENDENCY_FIELDS) {
    const deps = pkg[field]
    if (!isJsonObject(deps)) continue
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue
      const { version, isPublished } = await pinnedVersion(
        pkgFile,
        name,
        spec,
        workspace,
        registry,
        options
      )
      deps[name] = version
      pinned.set(name, version)
      if (isPublished) published.set(name, version)
    }
  }
  if (pinned.size === 0) return pinned

  await checkLockfile(templateDir, published, registry)
  await writeFile(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`)
  return pinned
}

/**
 * The version a `workspace:` dependency pins to; throws unless it is npm's
 * latest, or (with `allowUnpublishedBump`) strictly ahead of it.
 */
async function pinnedVersion(
  pkgFile: string,
  name: string,
  spec: string,
  workspace: ReadonlyMap<string, string>,
  registry: Registry,
  options: PinOptions
): Promise<{ version: string; isPublished: boolean }> {
  if (spec !== "workspace:*") {
    throw new Error(`${pkgFile}: ${name} is "${spec}"; templates use "workspace:*".`)
  }
  const version = workspace.get(name)
  if (version === undefined) {
    throw new Error(`${pkgFile}: ${name} is not a publishable package in this repository.`)
  }
  const { latest } = await registry(name)
  if (latest === version) return { version, isPublished: true }
  if (options.allowUnpublishedBump === true && latest !== undefined && isAhead(version, latest)) {
    return { version, isPublished: false }
  }
  throw new Error(
    `${pkgFile}: ${name} is ${version} here but npm's latest is ${latest ?? "nothing"}. ` +
      `Publish ${name}@${version} before releasing a template that uses it.`
  )
}

/** A stable release, `x.y.z` with no leading zeros, prerelease or build metadata. */
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/**
 * Whether `version` is a stable release strictly ahead of `latest`, also a
 * stable release. Our packages only release stable `x.y.z` versions (the
 * template test requires it), so anything else, including valid prereleases
 * and build metadata, is not ahead and gets the strict check.
 */
export function isAhead(version: string, latest: string): boolean {
  const a = STABLE.exec(version)
  const b = STABLE.exec(latest)
  if (a === null || b === null) return false
  for (const i of [1, 2, 3]) {
    const x = a[i] ?? ""
    const y = b[i] ?? ""
    // No leading zeros, so a longer numeral is larger; compared as strings so
    // numerals past Number.MAX_SAFE_INTEGER still order exactly.
    if (x !== y) return x.length !== y.length ? x.length > y.length : x > y
  }
  return false
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
    // A scoped name's "/" is escaped as npm's own client does: "@scope%2fname".
    const res = await fetch(`${base}/${name.replaceAll("/", "%2f")}`, {
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
