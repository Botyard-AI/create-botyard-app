import type { IncomingMessage, ServerResponse } from "node:http"
import { DeskError } from "./quotes/desk.ts"
import { ParseError } from "./quotes/parse.ts"

/** Largest request body the API reads, in bytes. */
const MAX_BODY = 64 * 1024

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  })
  res.end(text)
}

/** A request the API refuses, with the HTTP status and a message for the person. */
export class HttpError extends Error {
  override name = "HttpError"
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Reads a JSON body of at most 64 KiB. An empty body is `{}`. */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers["content-type"] ?? ""
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buf.length
    if (size > MAX_BODY) throw new HttpError(413, "request body too large")
    chunks.push(buf)
  }
  if (size === 0) return {}
  if (!type.startsWith("application/json"))
    throw new HttpError(415, "send JSON (content-type: application/json)")
  try {
    const json: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    return json
  } catch {
    throw new HttpError(400, "body must be JSON")
  }
}

/** Answers a refused request as JSON. Returns false for anything else, which is a bug: rethrow it. */
export function sendError(res: ServerResponse, err: unknown): boolean {
  if (res.headersSent) return false
  if (err instanceof DeskError || err instanceof HttpError) {
    sendJson(res, err.status, { error: err.message })
    return true
  }
  if (err instanceof ParseError) {
    sendJson(res, 400, { error: err.message })
    return true
  }
  return false
}

export type Params = Readonly<Record<string, string>>

export type Route = {
  readonly method: "GET" | "POST" | "PUT"
  /** Path with `:name` segments, e.g. `/api/quotes/:id/submit`. */
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse, params: Params) => Promise<void>
}

const SEGMENT = /^[A-Za-z0-9._-]{1,80}$/

/** Finds the route for a request. `:name` matches one plain path segment. */
export function match(
  routes: readonly Route[],
  method: string,
  pathname: string
): { route: Route; params: Params } | { route: null; allowed: boolean } {
  const parts = pathname.split("/")
  let allowed = false
  for (const route of routes) {
    const want = route.path.split("/")
    if (want.length !== parts.length) continue
    const params: Record<string, string> = {}
    const ok = want.every((w, i) => {
      const got = parts[i] ?? ""
      if (!w.startsWith(":")) return w === got
      if (!SEGMENT.test(got)) return false
      params[w.slice(1)] = got
      return true
    })
    if (!ok) continue
    if (route.method === method) return { route, params }
    allowed = true
  }
  return { route: null, allowed }
}
