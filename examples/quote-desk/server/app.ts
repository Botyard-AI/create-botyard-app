import type { IncomingMessage, ServerResponse } from "node:http"
import type { BotPage } from "@botyard/botpage"
import { withViewer } from "@botyard/botpage/node"
import { match, sendError, sendJson, type Route } from "./http.ts"
import type { QuoteDesk } from "./quotes/desk.ts"
import { quoteRoutes } from "./routes.ts"
import { serveStatic } from "./static.ts"
import type { StaticFiles } from "./static.ts"

/** Connect-style middleware, such as Vite's dev server. */
export type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

export type AppOptions = {
  botpage: BotPage
  /** The quotes this app serves. */
  desk: QuoteDesk
  /** Built UI to serve (production), from `loadStatic`. */
  staticFiles?: StaticFiles
  /** Serves the UI in development (Vite). Used when `staticFiles` is not set. */
  ui?: Middleware
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/**
 * The app's HTTP handler.
 *
 * Every request reaches this server through the Bot Page proxy, which signs
 * the viewer in. `withViewer` gives a route the viewer, or null; the quote
 * routes (routes.ts) let only members of your org through.
 */
/** Runs the API route for a request. Refusals become JSON; anything else is rethrown. */
async function handleApi(
  api: readonly Route[],
  method: string,
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const found = match(api, method === "HEAD" ? "GET" : method, pathname)
  if (found.route === null) {
    sendJson(res, found.allowed ? 405 : 404, {
      error: found.allowed ? "method_not_allowed" : "not_found",
    })
    return
  }
  try {
    await found.route.handler(req, res, found.params)
  } catch (err) {
    if (!sendError(res, err)) throw err
  }
}

export function createApp({ botpage, desk, staticFiles, ui }: AppOptions): Handler {
  const api: Route[] = [
    {
      method: "GET",
      path: "/api/health",
      handler: async (_req, res) => {
        sendJson(res, 200, { ok: true })
      },
    },
    // Who is looking at this page: a member, an unknown person, a bot, or null.
    {
      method: "GET",
      path: "/api/me",
      handler: withViewer(botpage, (_req, res, viewer) => {
        sendJson(res, 200, { viewer })
      }),
    },
    ...quoteRoutes(desk, botpage),
  ]

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
      await handleApi(api, method, url.pathname, req, res)
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
}
