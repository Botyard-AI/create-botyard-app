import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs"
import path from "node:path"
import { ConfigError } from "./config.ts"

/** Where the trace lives, under the app's root. Not under dist/, which `npm start` serves. */
const TRACE_FILE = path.join("data", "trace.jsonl")

/**
 * The trace's path: data/trace.jsonl, or `TRACE_FILE` from the environment
 * (relative to `root`). It must end in `.jsonl`, so the rotated file
 * (`.1.jsonl`) has a name of its own. Inside the app it must be under data/,
 * which neither `npm start` nor the dev server serves (see vite.config.ts).
 */
export function traceFilePath(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const file = path.resolve(root, env["TRACE_FILE"] ?? TRACE_FILE)
  if (!file.endsWith(".jsonl")) {
    throw new ConfigError(`TRACE_FILE must end in .jsonl, not "${file}".`)
  }
  const inApp = path.relative(root, file)
  const outside = inApp.startsWith("..") || path.isAbsolute(inApp)
  if (!outside && !inApp.startsWith(`data${path.sep}`)) {
    throw new ConfigError(
      `TRACE_FILE "${file}" is inside the app but not under data/, where it could be served.`
    )
  }
  return file
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

  write(record: Readonly<Record<string, unknown>>): void {
    if (this.#broken) return
    let line = `${JSON.stringify(record)}\n`
    // A record bigger than a whole file would break the cap: keep a note of it instead.
    if (Buffer.byteLength(line) > this.#maxBytes) {
      const note = { time: record["time"], event: "trace_record_too_big", bytes: line.length }
      line = `${JSON.stringify(note)}\n`
    }
    if (Buffer.byteLength(line) > this.#maxBytes) return
    try {
      if (this.#size > 0 && this.#size + Buffer.byteLength(line) > this.#maxBytes) {
        renameSync(this.file, previousFile(this.file))
        this.#size = 0
      }
      appendFileSync(this.file, line, { mode: 0o600 })
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
