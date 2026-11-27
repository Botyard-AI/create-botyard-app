import type { IncomingMessage } from "node:http"
import type { TraceFile } from "./trace.ts"

// Structured logs: one JSON object per line, on stdout (info, warn) or stderr
// (error), and in the short-term trace when there is one (see trace.ts).
//
//   {"time":"…","level":"info","event":"request","requestId":"…","method":"GET",
//    "path":"/api/me","status":200,"ms":3.1,"viewer":"person"}
//
// What a log line may hold: no viewer email, no request headers, no query
// strings, no secrets. So:
// - Fields are plain values (strings, numbers, booleans, null) that the code
//   names itself. Nothing copies an object, or its keys, into a log line.
// - An error becomes its name, message and stack, and only when it is a real
//   Error. Anything else that was thrown is logged as its type alone.
// - Every string is scrubbed: email addresses, Bearer and Basic credentials,
//   and, for a request, the exact values of its identity and credential
//   headers are blanked out.
// - Logging never throws, so it cannot get in the way of an answer.

type Level = "info" | "warn" | "error"
type Value = string | number | boolean | null
type Fields = Readonly<Record<string, Value>>

/** What a log line says about an error. */
type ErrorInfo =
  | { readonly name: string; readonly message: string; readonly stack: string | null }
  | { readonly thrown: string }

export type Log = {
  info(event: string, fields?: Fields): void
  warn(event: string, fields?: Fields, error?: unknown): void
  /** `secrets` are blanked out of the line: pass `requestSecrets(req)`. */
  error(event: string, fields?: Fields, error?: unknown, secrets?: readonly string[]): void
  /** One line per finished request. */
  request(fields: Fields, secrets: readonly string[]): void
}

type LogOptions = {
  trace?: TraceFile | undefined
  /** Where lines go. Default stdout and stderr; tests collect them. */
  write?: (level: Level, line: string) => void
}

export function createLog({ trace, write = writeStd }: LogOptions = {}): Log {
  const emit = (
    level: Level,
    event: string,
    fields: Fields,
    error: unknown,
    secrets: readonly string[]
  ): void => {
    try {
      const clean = scrubber(secrets)
      const time = new Date().toISOString()
      const record: Record<string, Value | ErrorInfo> = {
        time,
        level,
        event,
      }
      for (const [key, value] of Object.entries(fields)) {
        record[key] = typeof value === "string" ? clean(value) : value
      }
      if (error !== undefined) record["error"] = describeError(error, clean)
      const line = JSON.stringify(record)
      write(level, line)
      trace?.write(line, time)
    } catch {
      // Never let logging fail the caller. Say that a line was lost, if even that works.
      try {
        write("error", JSON.stringify({ time: new Date().toISOString(), event: "log_failed" }))
      } catch {
        // Nothing left to tell.
      }
    }
  }
  return {
    info: (event, fields = {}) => {
      emit("info", event, fields, undefined, [])
    },
    warn: (event, fields = {}, error) => {
      emit("warn", event, fields, error, [])
    },
    error: (event, fields = {}, error, secrets = []) => {
      emit("error", event, fields, error, secrets)
    },
    request: (fields, secrets) => {
      const status = fields["status"]
      const level = typeof status === "number" && status >= 500 ? "error" : "info"
      emit(level, "request", fields, undefined, secrets)
    },
  }
}

function writeStd(level: Level, line: string): void {
  ;(level === "error" ? process.stderr : process.stdout).write(`${line}\n`)
}

/** Longest string kept in a line; stacks get more room. */
const MAX_STRING = 1000
const MAX_STACK = 4000

/**
 * An error's name, message and stack, scrubbed and cut to length. Only a
 * real Error is read, and reading it cannot throw. For anything else thrown,
 * only its type: its contents and keys could be anything, such as the
 * viewer's email.
 */
export function describeError(
  value: unknown,
  clean: (text: string, max?: number) => string
): ErrorInfo {
  if (value instanceof Error) {
    try {
      const { name, message, stack } = value
      return {
        name: clean(typeof name === "string" ? name : "Error"),
        message: clean(typeof message === "string" ? message : ""),
        stack: typeof stack === "string" ? clean(stack, MAX_STACK) : null,
      }
    } catch {
      // A getter that throws: fall through to the type alone.
    }
  }
  return { thrown: value === null ? "null" : typeof value }
}

/** Headers that carry who the viewer is or a credential. */
const SECRET_HEADERS = ["authorization", "proxy-authorization", "cookie", "x-forwarded-user"]

/**
 * The values to blank out of anything logged about `req`: its credential
 * and identity headers, whole and in pieces.
 */
export function requestSecrets(req: IncomingMessage): string[] {
  const secrets = SECRET_HEADERS.flatMap((name) =>
    [req.headers[name] ?? []].flat().flatMap((value) => [value, ...partsOf(name, value)])
  )
  // Short values ("a", "1") would blank out half of every line; they are not
  // credentials anyway.
  return secrets.filter((s) => s.length >= 4)
}

/** The pieces of a header value that are secrets on their own. */
function partsOf(name: string, value: string): string[] {
  // "a=1; session=abc": each cookie's value.
  if (name === "cookie") {
    return value.split(";").map((pair) => pair.slice(pair.indexOf("=") + 1).trim())
  }
  // "Bearer abc": the token without its scheme.
  if (name.endsWith("authorization")) return [value.replace(/^\S+\s+/, "")]
  return []
}

const REDACTED = "[redacted]"

/** Blanked out of every string, request or not. */
const ALWAYS = [
  // Email addresses; not "vite@8.3.8" or "node_modules/@botyard/runtime".
  /[\w.+-]+@(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi,
  // Credentials written the Authorization way.
  /\b(bearer|basic)\s+[\w~+/.=-]+/gi,
]

/** Scrubs a string for a log line: see the top of this file. */
export function scrubber(secrets: readonly string[]): (text: string, max?: number) => string {
  const exact = secrets.map((s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"))
  return (text, max = MAX_STRING) => {
    let out = text
    for (const pattern of [...exact, ...ALWAYS]) out = out.replace(pattern, REDACTED)
    return out.length > max ? `${out.slice(0, max)}…` : out
  }
}
