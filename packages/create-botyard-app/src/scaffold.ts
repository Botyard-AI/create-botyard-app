import { lstat, mkdir, open, readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { pageName } from "./names.ts"

// npm never packs a file named .gitignore and treats .npmrc as config, so the
// bundled templates store them under these names (scripts/bundle.ts) and the
// scaffolder restores the dot.
export const BUNDLED_NAMES: ReadonlyMap<string, string> = new Map([
  [".gitignore", "gitignore"],
  [".npmrc", "npmrc"],
])
const RESTORED_NAMES = new Map([...BUNDLED_NAMES].map(([dot, bare]) => [bare, dot]))

export class ScaffoldError extends Error {
  override name = "ScaffoldError"
}

/** Test seams for deterministic interleavings with another writer. */
type ScaffoldHooks = {
  /** Runs after the target was checked and before it is created or used. */
  beforeTarget?: () => Promise<void>
  /** Runs after each file or directory is created. */
  afterCreate?: (file: string) => Promise<void>
  /** Runs after a file is created and before its contents are written. */
  beforeWrite?: (file: string) => Promise<void>
}

type ScaffoldOptions = {
  /** Directory holding one sub-directory per template. */
  templatesDir: string
  template: string
  /** Absolute path of the app to create. It must not exist, or be empty. */
  targetDir: string
  /** Validated npm package name for the app. */
  packageName: string
  hooks?: ScaffoldHooks
}

type PlanEntry =
  | { readonly kind: "dir"; readonly rel: string }
  | { readonly kind: "file"; readonly rel: string; readonly data: Buffer | string }

/** A path and the inode this run created or checked there. */
type Created = {
  readonly file: string
  readonly dir: boolean
  readonly dev: number
  readonly ino: number
}

export async function listTemplates(templatesDir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(templatesDir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Copies a bundled template into `targetDir` and names the app.
 *
 * - It reads and checks the whole template before writing anything: only
 *   regular files and directories, no symlinks. No network, no install, no
 *   scripts.
 * - Every file and directory is created exclusively (`O_EXCL`, non-recursive
 *   `mkdir`), so it never overwrites an existing file or follows a symlink at
 *   the path it creates. Files are written once, already named.
 * - Before reporting success it checks, by device and inode, that the target
 *   and every entry it created are still at their paths.
 * - It never deletes anything. If it fails part-way, what it created stays,
 *   and the error lists the paths it created, warning that another process
 *   may have changed them since: removing a path after checking it is ours
 *   can never be atomic, so cleanup is left to the user.
 *
 * Limit (Node has no `openat`): exclusive creation protects only the last
 * path segment. A concurrent process that can rename directories on the
 * target's path can send new files elsewhere by swapping an ancestor for a
 * symlink. Such a swap still never overwrites or deletes anything; a swap
 * that persists to the end fails the run instead of reporting success; but
 * after a swap that is reverted before a failure, files written through it
 * can stay outside the target. That process already holds the user's write
 * access to those directories, so this is a robustness limit, not a
 * privilege boundary.
 */
export async function scaffold(options: ScaffoldOptions): Promise<void> {
  const { templatesDir, template, targetDir, packageName, hooks = {} } = options
  const available = await listTemplates(templatesDir)
  if (!available.includes(template)) {
    throw new ScaffoldError(
      `Unknown template "${template}". Available: ${available.join(", ") || "none"}.`
    )
  }
  const plan = await planTemplate(path.join(templatesDir, template), packageName)

  await checkTarget(targetDir, true)
  await mkdir(path.dirname(targetDir), { recursive: true })
  await hooks.beforeTarget?.()

  const created: Created[] = []
  let madeTarget = false
  try {
    let target = await createDir(targetDir)
    if (target === null) target = await checkTarget(targetDir, false)
    else madeTarget = true
    if (target === null) throw new ScaffoldError(`${targetDir} disappeared while scaffolding.`)

    for (const entry of plan) {
      const file = path.join(targetDir, entry.rel)
      if (entry.kind === "dir") created.push(await createDirOrFail(file))
      else await createFile(file, entry.data, created, hooks)
      await hooks.afterCreate?.(file)
    }
    await verify([target, ...created], targetDir)
  } catch (err) {
    throw withCreatedList(err, targetDir, madeTarget, created)
  }
}

async function planTemplate(templateDir: string, packageName: string): Promise<PlanEntry[]> {
  const plan: PlanEntry[] = []
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).map((entry) => ({
      entry,
      name: RESTORED_NAMES.get(entry.name) ?? entry.name,
    }))
    // By output name, in code-unit order rather than locale order, so the
    // plan is the same everywhere.
    entries.sort((a, b) => compareCodeUnits(a.name, b.name))
    for (const { entry, name } of entries) {
      const source = path.join(dir, entry.name)
      const target = path.join(rel, name)
      if (entry.isDirectory()) {
        plan.push({ kind: "dir", rel: target })
        await walk(source, target)
      } else if (entry.isFile()) {
        plan.push({ kind: "file", rel: target, data: await fileData(source, target, packageName) })
      } else {
        throw new ScaffoldError(`Template entry ${source} is not a regular file or directory.`)
      }
    }
  }
  await walk(templateDir, "")
  return plan
}

/** The file's bytes, with the app's name filled in for package.json, its lockfile and botyard.json. */
async function fileData(
  source: string,
  rel: string,
  packageName: string
): Promise<Buffer | string> {
  if (rel === "package.json") {
    return renamed(source, (json) => {
      json["name"] = packageName
    })
  }
  if (rel === "package-lock.json") {
    return renamed(source, (json) => {
      json["name"] = packageName
      const root = isJsonObject(json["packages"]) ? json["packages"][""] : undefined
      if (isJsonObject(root)) root["name"] = packageName
    })
  }
  if (rel === "botyard.json") {
    return renamed(source, (json) => {
      json["name"] = pageName(packageName)
    })
  }
  return readFile(source)
}

async function renamed(
  file: string,
  edit: (json: Record<string, unknown>) => void
): Promise<string> {
  const json: unknown = JSON.parse(await readFile(file, "utf8"))
  if (!isJsonObject(json)) throw new ScaffoldError(`${file} is not a JSON object.`)
  edit(json)
  return `${JSON.stringify(json, null, 2)}\n`
}

/** Checks that the target is missing or an empty directory; returns its inode when it exists. */
async function checkTarget(targetDir: string, mayBeMissing: boolean): Promise<Created | null> {
  let stat
  try {
    stat = await lstat(targetDir)
  } catch (err) {
    if (mayBeMissing && isErrno(err, "ENOENT")) return null
    throw err
  }
  if (!stat.isDirectory()) {
    throw new ScaffoldError(`${targetDir} exists and is not a directory.`)
  }
  if ((await readdir(targetDir)).length > 0) {
    throw new ScaffoldError(`${targetDir} is not empty. Choose a new or empty directory.`)
  }
  return { file: targetDir, dir: true, dev: stat.dev, ino: stat.ino }
}

/** Creates a directory exclusively; null when something already exists there. */
async function createDir(dir: string): Promise<Created | null> {
  try {
    await mkdir(dir)
  } catch (err) {
    if (isErrno(err, "EEXIST")) return null
    throw err
  }
  const { dev, ino } = await lstat(dir)
  return { file: dir, dir: true, dev, ino }
}

async function createDirOrFail(dir: string): Promise<Created> {
  const created = await createDir(dir)
  if (created === null) throw new ScaffoldError(`${dir} appeared while scaffolding.`)
  return created
}

/** Creates and writes a file, recording it in `created` before writing, so a partial file is reported. */
async function createFile(
  file: string,
  data: Buffer | string,
  created: Created[],
  hooks: ScaffoldHooks
): Promise<void> {
  let handle
  try {
    // "wx" is O_CREAT | O_EXCL: it fails if anything, even a symlink, is there.
    handle = await open(file, "wx")
  } catch (err) {
    if (isErrno(err, "EEXIST")) throw new ScaffoldError(`${file} appeared while scaffolding.`)
    throw err
  }
  try {
    const { dev, ino } = await handle.stat()
    created.push({ file, dir: false, dev, ino })
    await hooks.beforeWrite?.(file)
    await handle.writeFile(data)
  } finally {
    await handle.close()
  }
}

/** Fails unless every path still holds the directory or file this run recorded there. */
async function verify(expected: readonly Created[], targetDir: string): Promise<void> {
  for (const item of expected) {
    let now
    try {
      now = await lstat(item.file)
    } catch {
      now = null
    }
    const same =
      now !== null &&
      now.dev === item.dev &&
      now.ino === item.ino &&
      (item.dir ? now.isDirectory() : now.isFile())
    if (!same) {
      throw new ScaffoldError(
        `${targetDir} changed while scaffolding: ${item.file} is no longer what was created. ` +
          "Some files may have been created where it pointed."
      )
    }
  }
}

/**
 * The error to report for a failed run. When it created anything, the message
 * lists the paths it created, as a record of what this run did, not as proof
 * of what is there now: another process may have replaced any of them or
 * added files inside them, so the user must check before removing anything.
 */
function withCreatedList(
  err: unknown,
  targetDir: string,
  madeTarget: boolean,
  created: readonly Created[]
): Error {
  let note = ""
  if (madeTarget || created.length > 0) {
    const paths = created.map(
      (item) => `  ${path.relative(targetDir, item.file)}${item.dir ? "/" : ""}`
    )
    let what = `these paths in ${targetDir}`
    if (madeTarget) {
      what = paths.length > 0 ? `${targetDir} itself and these paths in it` : `${targetDir} itself`
    }
    const list = paths.length > 0 ? `:\n${paths.join("\n")}` : "."
    note = [
      `\n\nNothing was overwritten or deleted. Before it stopped, this run created ${what}${list}`,
      "This is a record of what this run created, not of what is there now: another " +
        "process may since have replaced any of these paths or added files inside them, " +
        "and nothing else there was created by this run. Check what is at each path " +
        "before removing anything, then try again in a new or empty directory.",
    ].join("\n")
  }
  if (err instanceof ScaffoldError) return new ScaffoldError(`${err.message}${note}`)
  if (err instanceof Error && "code" in err) {
    return new ScaffoldError(`Could not create the app in ${targetDir}: ${err.message}.${note}`)
  }
  return err instanceof Error ? err : new Error(String(err))
}

function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && err.code === code
}
