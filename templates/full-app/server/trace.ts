import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs"
import path from "node:path"
import { ConfigError } from "./config.ts"

/** Where the trace lives, under the app's root. Not under dist/, which `npm start` serves. */
const TRACE_FILE = path.join("data", "trace.jsonl")

/** Where the trace is: as configured, and where that really is on disk. */
type TracePlace = { readonly file: string; readonly real: string }

/**
 * The trace cannot be kept, for a reason outside the app's control (its
 * directory cannot be created or read). The trace is optional: the app runs
 * without it. A trace placed where it could be served is a ConfigError instead.
 */
export class TraceUnavailableError extends Error {
  override name = "TraceUnavailableError"
}

/** What `npm start` and `npm run dev` serve, besides the app's root itself. */
const SERVED_DIRS = [path.join("dist", "client"), "public"]

/**
 * The trace's path: data/trace.jsonl, or `TRACE_FILE` from the environment
 * (relative to `root`). Creates its directory, then checks where the file
 * really is, with symlinks followed, and throws a ConfigError when:
 * - the name does not end in `.jsonl` (the rotated file, `.1.jsonl`, needs a
 *   name of its own);
 * - it is inside the app but not under its own data/ directory: the rest of
 *   the app can be served (dist/client by `npm start`, the root and public/
 *   by `npm run dev`). Both the path as written and the real path are
 *   checked, so data/ being a symlink into such a place is caught too;
 * - it really is inside dist/client or public/, wherever they really are:
 *   either can be a symlink to a directory outside the app, such as a release
 *   directory, and is served from there;
 * - the trace or the rotated file already exists as anything but a regular
 *   file, such as a symlink.
 * Anywhere else outside the app is fine: nothing serves it there.
 *
 * Throws a TraceUnavailableError when the directory cannot be created or
 * resolved (read-only disk, a file where a directory should be): the caller
 * runs without a trace.
 */
export function traceFilePath(root: string, env: NodeJS.ProcessEnv = process.env): TracePlace {
  const file = path.resolve(root, env["TRACE_FILE"] ?? TRACE_FILE)
  if (!file.endsWith(".jsonl")) {
    throw new ConfigError(`TRACE_FILE must end in .jsonl, not "${file}".`)
  }
  const notServed = (where: string, base: string): boolean =>
    !isInside(base, where) || isInside(path.join(base, "data"), where)
  const unsafe = (really: string): ConfigError =>
    new ConfigError(
      `TRACE_FILE "${file}" (really ${really}) is inside the app but not under its data/ ` +
        "directory, where it could be served."
    )
  // As written, before anything is created on disk.
  if (!notServed(file, root)) throw unsafe(file)

  let real: string
  let realRoot: string
  let servedDirs: string[]
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    real = path.join(realpathSync(path.dirname(file)), path.basename(file))
    realRoot = realpathSync(root)
    servedDirs = SERVED_DIRS.flatMap((dir) => realpathIfThere(path.join(root, dir)))
  } catch (err) {
    throw new TraceUnavailableError(
      `Cannot keep a trace at ${file}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (!notServed(real, realRoot) || servedDirs.some((dir) => isInside(dir, real))) {
    throw unsafe(real)
  }
  for (const name of [real, previousFile(real)]) {
    let stats
    try {
      stats = lstatSync(name)
    } catch {
      continue // Not there yet: fine.
    }
    if (!stats.isFile()) {
      throw new ConfigError(`The trace file ${name} exists and is not a regular file.`)
    }
  }
  return { file, real }
}

/** Where `dir` really is, or nothing when it does not exist. */
function realpathIfThere(dir: string): string[] {
  try {
    return [realpathSync(dir)]
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return []
    throw err
  }
}

/** True when `child` is `parent` or below it, compared by whole path components. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/** The current file is rotated once it reaches this size. */
const TRACE_MAX_BYTES = 1024 * 1024

type TraceOptions = {
  /** Rotate at this size, in bytes. Tests use a small one. */
  maxBytes?: number
  /** Where a write failure is reported, once. */
  onError?: (err: unknown) => void
}

/**
 * A short-term record of recent requests and errors, for the bot to read with
 * `npm run trace`: one JSON object per line in `data/trace.jsonl`.
 *
 * It is bounded: before a line would take the file past `maxBytes`, the file
 * is renamed to `trace.1.jsonl` (replacing the previous one) and a new one
 * starts. Neither file exceeds `maxBytes`; a single record too big for one is
 * replaced by a short note.
 *
 * It is private by construction: it is a file on the bot's disk, and no route
 * serves it. Records are redacted before they get here (see log.ts).
 *
 * Writes are synchronous appends: a line or two per request, which keeps the
 * order of lines and the rotation simple. If a write fails (disk full, a
 * read-only directory), the trace turns itself off and the app carries on.
 */
export class TraceFile {
  readonly file: string
  readonly #maxBytes: number
  readonly #onError: (err: unknown) => void
  #size: number
  #broken = false

  constructor(file: string, { maxBytes = TRACE_MAX_BYTES, onError = () => {} }: TraceOptions = {}) {
    if (!file.endsWith(".jsonl")) throw new ConfigError(`A trace file must end in .jsonl: ${file}`)
    this.file = file
    this.#maxBytes = maxBytes
    this.#onError = onError
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    } catch (err) {
      this.#broken = true
      onError(err)
    }
    this.#size = sizeOf(file)
  }

  /**
   * Appends one record: `json` is the line log.ts already serialized, `time`
   * its timestamp, used if the record is too big and only a note is kept.
   */
  write(json: string, time: string): void {
    if (this.#broken) return
    let line = `${json}\n`
    // A record bigger than a whole file would break the cap: keep a note of it instead.
    if (Buffer.byteLength(line) > this.#maxBytes) {
      const note = { time, event: "trace_record_too_big", bytes: Buffer.byteLength(line) }
      line = `${JSON.stringify(note)}\n`
    }
    if (Buffer.byteLength(line) > this.#maxBytes) return
    try {
      if (this.#size > 0 && this.#size + Buffer.byteLength(line) > this.#maxBytes) {
        renameSync(this.file, previousFile(this.file))
        this.#size = 0
      }
      // O_NOFOLLOW: if the file has been swapped for a symlink, refuse to write through it.
      const fd = openSync(
        this.file,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600
      )
      try {
        writeSync(fd, line)
      } finally {
        closeSync(fd)
      }
      this.#size += Buffer.byteLength(line)
    } catch (err) {
      this.#broken = true
      this.#onError(err)
    }
  }
}

/** The rotated file next to `file`: data/trace.jsonl -> data/trace.1.jsonl. */
export function previousFile(file: string): string {
  return file.replace(/\.jsonl$/, ".1.jsonl")
}

/** Every record in the trace, oldest first. Lines that are not JSON objects are skipped. */
export function readTrace(file: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  for (const name of [previousFile(file), file]) {
    let text: string
    try {
      text = readFileSync(name, "utf8")
    } catch {
      continue
    }
    for (const line of text.split("\n")) {
      if (line === "") continue
      try {
        const value: unknown = JSON.parse(line)
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          records.push(Object.fromEntries(Object.entries(value)))
        }
      } catch {
        // A line cut short by a crash mid-write: skip it.
      }
    }
  }
  return records
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}
