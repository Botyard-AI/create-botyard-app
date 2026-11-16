import { lstat, mkdir, open, readdir, readFile, rmdir, unlink } from "node:fs/promises"
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
 *   `mkdir`), so it never overwrites or writes through a symlink, even if
 *   another process writes to the target at the same time. Files are written
 *   once, already named; nothing is rewritten.
 * - Before reporting success it checks, by device and inode, that the target
 *   and every entry it created are still at their paths. Exclusive creation
 *   protects only the last path segment: if another process swaps the target
 *   or a directory in it for a symlink mid-run, files land where it points.
 *   They never overwrite anything there, and the check turns the swap into a
 *   failure instead of a false success.
 * - On failure it removes only what it created, matched by inode: a file
 *   another process put in its place, or anything added to a directory it
 *   created, is left alone. Missing parent directories are left in place.
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
  try {
    let target = await createDir(targetDir)
    if (target === null) target = await checkTarget(targetDir, false)
    else created.push(target)
    if (target === null) throw new ScaffoldError(`${targetDir} disappeared while scaffolding.`)

    for (const entry of plan) {
      const file = path.join(targetDir, entry.rel)
      if (entry.kind === "dir") created.push(await createDirOrFail(file))
      else await createFile(file, entry.data, created, hooks)
      await hooks.afterCreate?.(file)
    }
    await verify([target, ...created], targetDir)
  } catch (err) {
    await rollBack(created)
    throw asScaffoldError(err, targetDir)
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

/** The file's bytes, with the app's name filled in for package.json and botyard.json. */
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

/** Creates and writes a file, recording it in `created` before writing, so a failed write is rolled back. */
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
          "Nothing was overwritten, but some files may have been created where it pointed."
      )
    }
  }
}

/** Removes what this run created, newest first, while it is still the same inode. */
async function rollBack(created: readonly Created[]): Promise<void> {
  for (const item of [...created].reverse()) {
    try {
      const now = await lstat(item.file)
      if (now.dev !== item.dev || now.ino !== item.ino) continue
      // rmdir only removes an empty directory, so another writer's files survive.
      await (item.dir ? rmdir(item.file) : unlink(item.file))
    } catch {
      // Gone already, or not empty: leave it.
    }
  }
}

function asScaffoldError(err: unknown, targetDir: string): Error {
  if (err instanceof ScaffoldError) return err
  if (err instanceof Error && "code" in err) {
    return new ScaffoldError(`Could not create the app in ${targetDir}: ${err.message}`)
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
