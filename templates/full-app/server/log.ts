import type { IncomingMessage } from "node:http"
import type { TraceFile } from "./trace.ts"

// Structured logs: one JSON object per line, on stdout (info, warn) or stderr
// (error), and in the short-term trace when there is one (see trace.ts).
//
//   {"time":"…","level":"info","event":"request","requestId":"…","method":"GET",
//    "path":"/api/me","status":200,"ms":3.1,"viewer":"person"}
//
// What a log line may hold: no viewer email, no request headers, no query
// strings, no secrets. Request lines are built from a short list of fields,
// and every record also goes through `redact` below, which drops sensitive
// keys and blanks out the request's own credentials wherever they appear,
// such as in an error message.

type Level = "info" | "warn" | "error"
type Fields = Readonly<Record<string, unknown>>

export type Log = {
  info(event: string, fields?: Fields): void
  warn(event: string, fields?: Fields): void
  /** `secrets` are blanked out of the record: pass `requestSecrets(req)`. */
  error(event: string, fields?: Fields, secrets?: readonly string[]): void
  /** One line per finished request. */
  request(fields: Fields, secrets: readonly string[]): void
}

type LogOptions = {
  trace?: TraceFile | undefined
  /** Where lines go. Default stdout and stderr; tests collect them. */
  write?: (level: Level, line: string) => void
}

export function createLog({ trace, write = writeStd }: LogOptions = {}): Log {
  const emit = (level: Level, event: string, fields: Fields, secrets: readonly string[]): void => {
    const record = redactFields(
      { time: new Date().toISOString(), level, event, ...fields },
      secrets
    )
    write(level, JSON.stringify(record))
    trace?.write(record)
  }
  return {
    info: (event, fields = {}) => {
      emit("info", event, fields, [])
    },
    warn: (event, fields = {}) => {
      emit("warn", event, fields, [])
    },
    error: (event, fields = {}, secrets = []) => {
      emit("error", event, fields, secrets)
    },
    request: (fields, secrets) => {
      emit(Number(fields["status"]) >= 500 ? "error" : "info", "request", fields, secrets)
    },
  }
}

function writeStd(level: Level, line: string): void {
  ;(level === "error" ? process.stderr : process.stdout).write(`${line}\n`)
}

/** Headers that carry who the viewer is or a credential. */
const SECRET_HEADERS = ["authorization", "proxy-authorization", "cookie", "x-forwarded-user"]

/** Keys whose values are never logged, wherever they appear in a record. */
const SECRET_KEY =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-forwarded-user|headers|rawHeaders|password|secret|token|api[-_]?key)$/i

const REDACTED = "[redacted]"

/**
 * The values to blank out of anything logged about `req`: its credential
 * and identity headers, whole and, for cookies, each cookie's value.
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
  if (name === "cookie")
    return value.split(";").map((pair) => pair.slice(pair.indexOf("=") + 1).trim())
  // "Bearer abc": the token without its scheme.
  if (name.endsWith("authorization")) return [value.replace(/^\S+\s+/, "")]
  return []
}

/** `redact` for a record's top-level fields. */
function redactFields(fields: Fields, secrets: readonly string[] = []): Record<string, unknown> {
  const safe = redact(fields, secrets)
  return typeof safe === "object" && safe !== null ? Object.fromEntries(Object.entries(safe)) : {}
}

/**
 * A copy of `value` safe to log: errors become `{ name, message, stack }`,
 * sensitive keys are replaced, and each of `secrets` is blanked out of every
 * string, ignoring case.
 */
export function redact(value: unknown, secrets: readonly string[] = []): unknown {
  const patterns = secrets.map((s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"))
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return patterns.reduce((text, p) => text.replace(p, REDACTED), v)
    if (v instanceof Error) {
      return walk({ name: v.name, message: v.message, stack: v.stack }, depth)
    }
    if (typeof v !== "object" || v === null) return v
    if (depth > 5) return REDACTED
    if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1))
    return Object.fromEntries(
      Object.entries(v).map(([k, item]) => [
        k,
        SECRET_KEY.test(k) ? REDACTED : walk(item, depth + 1),
      ])
    )
  }
  return walk(value, 0)
}
