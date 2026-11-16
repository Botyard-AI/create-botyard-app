import type { IncomingMessage, ServerResponse } from "node:http"
import type { BotPage } from "@botyard/botpage"
import { requireMember, withViewer } from "@botyard/botpage/node"
import { serveStatic } from "./static.ts"

/** Connect-style middleware, such as Vite's dev server. */
export type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

export type AppOptions = {
  botpage: BotPage
  /** Built UI to serve (production). */
  staticDir?: string
  /** Serves the UI in development (Vite). Used when `staticDir` is not set. */
  ui?: Middleware
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
 */
export function createApp({ botpage, staticDir, ui }: AppOptions): Handler {
  const api: Record<string, Handler> = {
    "GET /api/health": async (_req, res) => {
      sendJson(res, 200, { ok: true })
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

  return async (req, res) => {
    let url: URL
    try {
      url = new URL(req.url ?? "/", "http://localhost")
    } catch {
      sendJson(res, 400, { error: "bad_request" })
      return
    }
    const method = req.method ?? "GET"

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const route = api[`${method === "HEAD" ? "GET" : method} ${url.pathname}`]
      if (route === undefined) sendJson(res, 404, { error: "not_found" })
      else await route(req, res)
      return
    }

    if (method !== "GET" && method !== "HEAD") {
      sendJson(res, 405, { error: "method_not_allowed" })
      return
    }
    if (staticDir !== undefined) {
      if (!(await serveStatic(staticDir, url.pathname, req, res))) {
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
}
