import { constants } from "node:fs"
import { copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { pageName } from "./names.ts"

// npm never packs a file named .gitignore and treats .npmrc as config, so the
// bundled templates store them under these names (scripts/bundle-templates.ts)
// and the scaffolder restores the dot.
export const BUNDLED_NAMES: ReadonlyMap<string, string> = new Map([
  [".gitignore", "gitignore"],
  [".npmrc", "npmrc"],
])
const RESTORED_NAMES = new Map([...BUNDLED_NAMES].map(([dot, bare]) => [bare, dot]))

export class ScaffoldError extends Error {
  override name = "ScaffoldError"
}

type ScaffoldOptions = {
  /** Directory holding one sub-directory per template. */
  templatesDir: string
  template: string
  /** Absolute path of the app to create. It must not exist, or be empty. */
  targetDir: string
  /** Validated npm package name for the app. */
  packageName: string
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
 * Copies a bundled template into `targetDir` and names the app. It only
 * copies regular files and directories from the package itself: no network,
 * no symlinks, no install and no scripts. It never overwrites a file, and on
 * failure it removes what it wrote.
 */
export async function scaffold(options: ScaffoldOptions): Promise<void> {
  const { templatesDir, template, targetDir, packageName } = options
  const available = await listTemplates(templatesDir)
  if (!available.includes(template)) {
    throw new ScaffoldError(
      `Unknown template "${template}". Available: ${available.join(", ") || "none"}.`
    )
  }

  const created = await prepareTarget(targetDir)
  try {
    await copyTree(path.join(templatesDir, template), targetDir)
    await nameApp(targetDir, packageName)
  } catch (err) {
    await cleanUp(targetDir, created)
    throw err
  }
}

/**
 * Returns the outermost directory it created (the target or a missing parent),
 * or null when the target existed and was empty.
 */
async function prepareTarget(targetDir: string): Promise<string | null> {
  let stat
  try {
    stat = await lstat(targetDir)
  } catch (err) {
    if (isErrno(err, "ENOENT")) {
      return (await mkdir(targetDir, { recursive: true })) ?? targetDir
    }
    throw err
  }
  if (!stat.isDirectory()) {
    throw new ScaffoldError(`${targetDir} exists and is not a directory.`)
  }
  const entries = await readdir(targetDir)
  if (entries.length > 0) {
    throw new ScaffoldError(`${targetDir} is not empty. Choose a new or empty directory.`)
  }
  return null
}

async function copyTree(from: string, to: string): Promise<void> {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const target = path.join(to, RESTORED_NAMES.get(entry.name) ?? entry.name)
    if (entry.isDirectory()) {
      // Not recursive: an existing directory means something else is writing here.
      await mkdir(target)
      await copyTree(source, target)
    } else if (entry.isFile()) {
      await copyFile(source, target, constants.COPYFILE_EXCL)
    } else {
      throw new ScaffoldError(`Template entry ${source} is not a regular file or directory.`)
    }
  }
}

async function nameApp(targetDir: string, packageName: string): Promise<void> {
  await editJson(path.join(targetDir, "package.json"), (json) => {
    json["name"] = packageName
  })
  await editJson(path.join(targetDir, "botyard.json"), (json) => {
    json["name"] = pageName(packageName)
  })
}

async function editJson(
  file: string,
  edit: (json: Record<string, unknown>) => void
): Promise<void> {
  let text
  try {
    text = await readFile(file, "utf8")
  } catch (err) {
    if (isErrno(err, "ENOENT")) return
    throw err
  }
  const json: unknown = JSON.parse(text)
  if (!isJsonObject(json)) {
    throw new ScaffoldError(`${file} is not a JSON object.`)
  }
  edit(json)
  await writeFile(file, `${JSON.stringify(json, null, 2)}\n`)
}

async function cleanUp(targetDir: string, created: string | null): Promise<void> {
  if (created !== null) {
    await rm(created, { recursive: true, force: true })
    return
  }
  // The directory was empty before we started, so everything in it is ours.
  for (const entry of await readdir(targetDir)) {
    await rm(path.join(targetDir, entry), { recursive: true, force: true })
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && err.code === code
}
