// The desk's files: JSON, each replaced atomically on every change.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseSettings } from "../../shared/parse.ts"
import type { DeskSettings } from "../../shared/types.ts"
import type { DeskState } from "./desk.ts"
import { parseDeskState } from "./parse.ts"

/**
 * Reads and parses a JSON file. Null when there is none yet. Throws when the
 * file exists but cannot be read or parsed: the app refuses to start rather
 * than silently replace someone's data with defaults.
 */
function readJson<T>(file: string, parse: (value: unknown) => T): T | null {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null
    throw err
  }
  const json: unknown = JSON.parse(text)
  return parse(json)
}

/** Writes a temporary file, then renames it over the old one. Leaves no temporary file. */
function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${String(process.pid)}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

export function loadState(file: string): DeskState | null {
  return readJson(file, parseDeskState)
}

export function saveState(file: string, state: DeskState): void {
  writeJson(file, { version: 1, ...state })
}

export function loadSettings(file: string): DeskSettings | null {
  return readJson(file, (v) => parseSettings(v))
}

export function saveSettings(file: string, settings: DeskSettings): void {
  writeJson(file, settings)
}
