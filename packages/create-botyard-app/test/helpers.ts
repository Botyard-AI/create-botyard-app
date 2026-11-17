import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach } from "vitest"
import { main } from "../src/cli.ts"

export const fixtureTemplates = fileURLToPath(new URL("fixtures/templates", import.meta.url))

const temps: string[] = []
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

export async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cba-test-")))
  temps.push(dir)
  return dir
}

type RunResult = { code: number; stdout: string; stderr: string }

export async function run(
  argv: string[],
  options: { cwd: string; templatesDir?: string }
): Promise<RunResult> {
  let stdout = ""
  let stderr = ""
  const code = await main(argv, {
    cwd: options.cwd,
    templatesDir: options.templatesDir ?? fixtureTemplates,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  })
  return { code, stdout, stderr }
}

/** Every file under `dir`, as sorted relative paths. */
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => !e.isDirectory())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort((a, b) => a.localeCompare(b))
}

export async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"))
}
