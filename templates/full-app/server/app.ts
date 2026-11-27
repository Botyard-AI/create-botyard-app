import { randomUUID } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import { performance } from "node:perf_hooks"
import type { BotPage } from "@botyard/botpage"
import { FORWARDED_USER_HEADER, parseBotShadowAddress, parseForwardedUser } from "@botyard/botpage"
import { requireMember, withViewer } from "@botyard/botpage/node"
import { createLog, requestSecrets, type Log } from "./log.ts"
import { createReadiness, type ReadyChecks } from "./ready.ts"
import { serveStatic } from "./static.ts"
import type { StaticFiles } from "./static.ts"

/** Connect-style middleware, such as Vite's dev server. */
export type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

export type AppOptions = {
  botpage: BotPage
  /** Built UI to serve (production), from `loadStatic`. */
  staticFiles?: StaticFiles
  /** Serves the UI in development (Vite). Used when `staticFiles` is not set. */
  ui?: Middleware
  /** What `GET /api/ready` checks. See ready.ts. */
  readyChecks?: ReadyChecks
  /** Where request and error lines go. Default: stdout and stderr, no trace. */
  log?: Log
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  })
  res.end(text)
}

/**
 * The app's HTTP handler. Add your API routes to `api` below.
 *
 * Every request reaches this server through the Bot Page proxy, which signs
 * the viewer in. `withViewer` gives a route the viewer, or null;
 * `requireMember` lets only members of your org through.
 *
 * Every request gets an id, sent back as `x-request-id`, and one log line
 * when it finishes. A route that throws answers a JSON 500 carrying that id;
 * the error itself, with its stack, goes only to the log.
 */
export function createApp({
  botpage,
  staticFiles,
  ui,
  readyChecks = {},
  log = createLog(),
}: AppOptions): Handler {
  const ready = createReadiness(readyChecks, { log })
  const api: Record<string, Handler> = {
    // Liveness: the process answers. No I/O, so it stays cheap and fast.
    "GET /api/health": async (_req, res) => {
      sendJson(res, 200, { ok: true })
    },
    // Readiness: what the app needs is working. 503 says which check failed.
    "GET /api/ready": async (_req, res) => {
      const report = await ready()
      sendJson(res, report.ok ? 200 : 503, report)
    },
    // Who is looking at this page: a member, an unknown person, a bot, or null.
    "GET /api/me": withViewer(botpage, (_req, res, viewer) => {
      sendJson(res, 200, { viewer })
    }),
    // An example of a members-only route. Others get 401 or 403 as JSON.
    "GET /api/hello": requireMember(botpage, (_req, res, member) => {
      sendJson(res, 200, { message: `Hello, ${member.name ?? member.email ?? member.userId}!` })
    }),
  }
  // A Map, so a request can only find a route listed above, never a property
  // every object inherits (such as "constructor").
  const routes = new Map(Object.entries(api))

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let url: URL
    try {
      url = new URL(req.url ?? "/", "http://localhost")
    } catch {
      sendJson(res, 400, { error: "bad_request" })
      return
    }
    const method = req.method ?? "GET"

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const route = routes.get(`${method === "HEAD" ? "GET" : method} ${url.pathname}`)
      if (typeof route !== "function") sendJson(res, 404, { error: "not_found" })
      else await route(req, res)
      return
    }

    if (method !== "GET" && method !== "HEAD") {
      sendJson(res, 405, { error: "method_not_allowed" })
      return
    }
    if (staticFiles !== undefined) {
      if (!serveStatic(staticFiles, url.pathname, req, res)) {
        sendJson(res, 404, { error: "not_found" })
      }
      return
    }
    if (ui !== undefined) {
      ui(req, res, () => {
        sendJson(res, 404, { error: "not_found" })
      })
      return
    }
    sendJson(res, 404, { error: "not_found" })
  }

  return async (req, res) => {
    const requestId = randomUUID()
    const started = performance.now()
    const method = req.method ?? "GET"
    // Never the query string: it can carry anything.
    const path = (req.url ?? "/").split("?")[0] ?? "/"
    res.setHeader("x-request-id", requestId)
    res.once("close", () => {
      log.request(
        {
          requestId,
          method,
          path,
          status: res.statusCode,
          ms: Math.round((performance.now() - started) * 10) / 10,
          viewer: viewerKind(req),
          ...(res.writableFinished ? {} : { aborted: true }),
        },
        requestSecrets(req)
      )
    })
    try {
      await route(req, res)
    } catch (err) {
      log.error("unhandled_error", { requestId, method, path, error: err }, requestSecrets(req))
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error", requestId })
      else res.destroy()
    }
  }
}

/**
 * Who sent the request, as far as the identity header says: "person", "bot"
 * or "none". Cheap (no member lookup) and never the email itself.
 */
function viewerKind(req: IncomingMessage): "person" | "bot" | "none" {
  const raw = req.headers[FORWARDED_USER_HEADER]
  const subject = raw === undefined ? null : parseForwardedUser(raw)
  if (subject === null) return "none"
  return parseBotShadowAddress(subject) === null ? "person" : "bot"
}
