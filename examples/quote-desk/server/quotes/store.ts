// The desk's state on disk: one JSON file, replaced atomically on every change.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { DeskState } from "./desk.ts"
import { parseDeskState } from "./parse.ts"

/**
 * Reads the state file. Null when there is none yet (a fresh desk). Throws
 * when the file exists but cannot be read or parsed: the app refuses to start
 * rather than silently replace someone's quotes with the seed.
 */
export function loadState(file: string): DeskState | null {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null
    throw err
  }
  const json: unknown = JSON.parse(text)
  return parseDeskState(json)
}

/** Writes the whole state: a temporary file, then a rename over the old one. */
export function saveState(file: string, state: DeskState): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${String(process.pid)}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
}
