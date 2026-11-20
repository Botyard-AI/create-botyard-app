// The rules scripts/check-blocks.ts applies to blocks and to the app it adds
// them to. See docs/blocks.md.
//
// A user adds a block with `npx shadcn add @botyard/<block>`, and shadcn
// installs the block's npm dependencies with `npm install <name>@<version>`.
// So that install resolves to what we tested:
//
// - npm dependencies are exact versions, `<name>@<x.y.z>`, never a range or a
//   bare name (which npm resolves to whatever is newest). This pins the direct
//   dependencies only: the user's npm still resolves their dependencies fresh.
// - registryDependencies name only other @botyard blocks. A shadcn/ui
//   component such as "button" lists its npm dependencies without versions,
//   so a block that needs one ships its own copy with pinned dependencies.
//
// - A file with a `target` lands under ~/server/, ~/src/ or ~/test/, never
//   elsewhere in the app (package.json, .npmrc, .env) and never outside it.
// - Only the fields below: shadcn's `envVars` (writes .env), `css`/`cssVars`
//   (edit the app's CSS) and the rest are refused until we decide on them.
//
// The minimum release age and the no-install-scripts rule are checked when
// the dependencies are locked (scripts/lock-template.sh --app).

import { object, stringList } from "./json.ts"
import type { LockEntry } from "./json.ts"

export const NAMESPACE = "@botyard"

/** The parts of a built registry item (r/<name>.json) the rules look at. */
export type Block = {
  readonly name: string
  readonly dependencies: readonly string[]
  readonly devDependencies: readonly string[]
  readonly registryDependencies: readonly string[]
  /** Fields of the item that are not in ALLOWED_FIELDS. */
  readonly otherFields: readonly string[]
  readonly files: readonly { readonly path: string; readonly target: string | undefined }[]
}

const ALLOWED_FIELDS = new Set([
  "$schema",
  "name",
  "type",
  "title",
  "description",
  "author",
  "docs",
  "categories",
  "meta",
  "files",
  "dependencies",
  "devDependencies",
  "registryDependencies",
])

export function parseBlock(value: unknown, what: string): Block {
  const item = object(value, what)
  const name = item["name"]
  if (typeof name !== "string") throw new Error(`${what}.name is not a string`)
  return {
    name,
    dependencies: stringList(item["dependencies"], `${what}.dependencies`),
    devDependencies: stringList(item["devDependencies"], `${what}.devDependencies`),
    registryDependencies: stringList(item["registryDependencies"], `${what}.registryDependencies`),
    otherFields: Object.keys(item).filter((key) => !ALLOWED_FIELDS.has(key)),
    files: parseFiles(item["files"], `${what}.files`),
  }
}

function parseFiles(value: unknown, what: string): Block["files"] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${what} is not a list`)
  return value.map((entry: unknown, i) => {
    const file = object(entry, `${what}[${i}]`)
    const filePath = file["path"]
    const target = file["target"]
    if (typeof filePath !== "string") throw new Error(`${what}[${i}].path is not a string`)
    if (target !== undefined && typeof target !== "string")
      throw new Error(`${what}[${i}].target is not a string`)
    return { path: filePath, target }
  })
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
const TARGET = /^~\/(server|src|test)\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/
const EXACT = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/** Splits "<name>@<version>" (the name may be scoped) into its two parts. */
export function splitSpec(spec: string): [name: string, version: string] {
  const at = spec.lastIndexOf("@")
  return [spec.slice(0, at), spec.slice(at + 1)]
}

/** Every rule the registry's blocks break, as readable messages. */
export function registryProblems(blocks: ReadonlyMap<string, Block>): string[] {
  return [...blocks].flatMap(([name, block]) =>
    [
      NAME.test(name) ? [] : ['block names are lowercase words joined by "-"'],
      block.otherFields.map((field) => `"${field}" is not supported in a block`),
      block.files.flatMap(targetProblems),
      [...block.dependencies, ...block.devDependencies]
        .filter((spec) => !EXACT.test(spec))
        .map((spec) => `npm dependency "${spec}" must be an exact version, "<name>@<x.y.z>"`),
      block.registryDependencies.flatMap((dep) => registryDependencyProblems(dep, blocks)),
    ]
      .flat()
      .map((problem) => `${name}: ${problem}`)
  )
}

function targetProblems(file: Block["files"][number]): string[] {
  const { target } = file
  if (target === undefined) return []
  if (TARGET.test(target) && !target.split("/").includes("..")) return []
  return [`${file.path} targets "${target}", not a file under ~/server, ~/src or ~/test`]
}

function registryDependencyProblems(dep: string, blocks: ReadonlyMap<string, Block>): string[] {
  const other = otherBlock(dep)
  if (other === undefined) return [`registryDependencies "${dep}" must be a ${NAMESPACE} block`]
  if (!blocks.has(other)) return [`registryDependencies "${dep}" is not in registry.json`]
  return []
}

type NpmDependencies = { dependencies: Map<string, string>; devDependencies: Map<string, string> }

/**
 * The npm dependencies a block brings, with those of the blocks it depends
 * on, as name to exact version. Call it only when `registryProblems` is empty.
 */
export function npmDependencies(name: string, blocks: ReadonlyMap<string, Block>): NpmDependencies {
  const result: NpmDependencies = { dependencies: new Map(), devDependencies: new Map() }
  for (const block of withRegistryDependencies(name, blocks)) {
    for (const field of ["dependencies", "devDependencies"] as const) {
      for (const spec of block[field]) {
        const [dep, version] = splitSpec(spec)
        const other = result[field].get(dep)
        if (other !== undefined && other !== version) {
          throw new Error(`${dep} is pinned to both ${other} and ${version} in ${name}'s blocks`)
        }
        result[field].set(dep, version)
      }
    }
  }
  return result
}

/** The block and every block it depends on, directly or not, once each. */
function withRegistryDependencies(name: string, blocks: ReadonlyMap<string, Block>): Block[] {
  const found = new Map<string, Block>()
  const queue = [name]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (found.has(next)) continue
    const block = blocks.get(next)
    if (block === undefined) throw new Error(`no block "${next}" in registry.json`)
    found.set(next, block)
    queue.push(...block.registryDependencies.flatMap((dep) => otherBlock(dep) ?? []))
  }
  return [...found.values()]
}

/**
 * The generated app's dependencies, ready to install. Each of our own
 * packages must be pinned at the version its package-lock.json locks.
 *
 * One exception, for CI only (`allowUnpublishedBump`, as in
 * packages/create-botyard-app/scripts/pin.ts): during a release bump the CLI
 * pins a version that is not on npm yet, while the lockfile still locks the
 * published one. The app then cannot install, so that package goes back to
 * the locked, published version, and the block is checked against it.
 * Templates may only use published versions of our packages (CONTRIBUTING.md),
 * so this is the app a user would get once the bump is released.
 */
export function installablePins(
  dependencies: Readonly<Record<string, string>>,
  lock: ReadonlyMap<string, LockEntry>,
  { allowUnpublishedBump }: { allowUnpublishedBump: boolean }
): { dependencies: Record<string, string>; rolledBack: string[] } {
  const result = { ...dependencies }
  const rolledBack: string[] = []
  for (const [dep, version] of Object.entries(dependencies)) {
    if (!dep.startsWith(`${NAMESPACE}/`)) continue
    const locked = lock.get(`node_modules/${dep}`)
    if (locked?.version === version) continue
    if (!allowUnpublishedBump) {
      throw new Error(`${dep}@${version} is not what package-lock.json locks (${locked?.version})`)
    }
    if (
      locked?.version === undefined ||
      locked.resolved?.startsWith("https://registry.npmjs.org/") !== true ||
      locked.integrity?.startsWith("sha512-") !== true
    ) {
      throw new Error(
        `${dep}@${version} is not published, and package-lock.json has no published version`
      )
    }
    result[dep] = locked.version
    rolledBack.push(`${dep}@${version} -> ${locked.version}`)
  }
  return { dependencies: result, rolledBack }
}

function otherBlock(dep: string): string | undefined {
  return dep.startsWith(`${NAMESPACE}/`) ? dep.slice(NAMESPACE.length + 1) : undefined
}

/**
 * Locked packages with an install script that the generated app's lockfile
 * did not already have. The template's lockfile may have some (fsevents);
 * the app's .npmrc never runs them. Re-locking for a block keeps such an
 * entry only as the very same package: same version, tarball and integrity.
 */
export function newInstallScripts(
  before: ReadonlyMap<string, LockEntry>,
  after: ReadonlyMap<string, LockEntry>
): string[] {
  const added: string[] = []
  for (const [key, entry] of after) {
    if (!entry.hasInstallScript) continue
    const old = before.get(key)
    const same =
      old?.hasInstallScript === true &&
      old.version === entry.version &&
      old.resolved === entry.resolved &&
      old.integrity === entry.integrity
    if (!same) added.push(`${key.replace(/^node_modules\//, "")}@${entry.version ?? "?"}`)
  }
  return added
}
