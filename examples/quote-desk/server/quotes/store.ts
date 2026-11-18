// The desk's files: JSON, each replaced atomically (write, then rename).
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
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
export function readJson<T>(file: string, parse: (value: unknown) => T): T | null {
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

/** Flushes a file or directory to disk. */
export function syncPath(p: string): void {
  const fd = openSync(p, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Creates the data directory if needed and syncs it and its parent, so the
 * directory itself survives a power cut. Run once at startup, every time:
 * a sync that failed on an earlier run is tried again here. Throws when it
 * fails; the app then refuses to start. The parent must already exist.
 */
export function prepareDataDir(dir: string, sync = syncPath): void {
  try {
    mkdirSync(dir, { mode: 0o700 })
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err
  }
  sync(dir)
  sync(path.dirname(dir))
}

/**
 * Writes a temporary file, syncs it, then renames it over the old one. The
 * rename is the commit: once it is done the new state is the state, and
 * writeJson returns normally. Syncing the directory afterwards makes the
 * rename survive a power cut. Returns whether that worked: false means
 * written, but a power cut could still undo it. Leaves no temporary file.
 * The directory must exist (see prepareDataDir).
 */
export function writeJson(file: string, value: unknown, sync = syncPath): boolean {
  const tmp = `${file}.${String(process.pid)}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    sync(tmp)
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
  try {
    sync(path.dirname(file))
    return true
  } catch {
    return false // written, not proven durable: see above
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
