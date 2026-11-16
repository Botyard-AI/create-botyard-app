/**
 * Adapter for Hono. `hono` is an optional peer dependency.
 *
 * On `@hono/node-server` the Node socket is used for the loopback checks; on
 * other runtimes pass `bind` to `createBotPage`.
 */
import type { MiddlewareHandler } from "hono"

import type { BotPage, RequireMemberOptions, Viewer } from "./botpage.ts"
import type { RequestLike } from "./headers.ts"
import { guardFailure } from "./responses.ts"

export type BotPageVariables = {
  viewer: Viewer | null
}

export type BotPageEnv = {
  Variables: BotPageVariables
}

export type ViewerMiddlewareOptions = {
  /** `member`: answer 401/403 unless the viewer is an org member. Default: no guard. */
  require?: "member"
} & RequireMemberOptions

/**
 * The socket @hono/node-server puts in `c.env.incoming`. Other runtimes pass
 * their own bindings, so read it defensively.
 */
function nodeSocket(
  env: unknown
): { localAddress: string | undefined; remoteAddress: string | undefined } | undefined {
  if (typeof env !== "object" || env === null || !("incoming" in env)) return undefined
  const { incoming } = env
  if (typeof incoming !== "object" || incoming === null || !("socket" in incoming)) return undefined
  const { socket } = incoming
  if (typeof socket !== "object" || socket === null) return undefined
  const localAddress =
    "localAddress" in socket && typeof socket.localAddress === "string"
      ? socket.localAddress
      : undefined
  const remoteAddress =
    "remoteAddress" in socket && typeof socket.remoteAddress === "string"
      ? socket.remoteAddress
      : undefined
  return { localAddress, remoteAddress }
}

function requestLike(raw: Request, env: unknown): RequestLike {
  const socket = nodeSocket(env)
  return socket === undefined
    ? { headers: raw.headers }
    : {
        headers: raw.headers,
        socket: { localAddress: socket.localAddress, remoteAddress: socket.remoteAddress },
      }
}

/**
 * Set `c.get("viewer")` for downstream handlers. With `require: "member"`,
 * non-members get a JSON 401/403 (or 503 when the directory is unavailable).
 */
export function viewerMiddleware(
  botpage: BotPage,
  options: ViewerMiddlewareOptions = {}
): MiddlewareHandler<BotPageEnv> {
  return async (c, next) => {
    const req = requestLike(c.req.raw, c.env)
    try {
      const viewer =
        options.require === "member"
          ? await botpage.requireMember(req, options)
          : await botpage.viewer(req)
      c.set("viewer", viewer)
    } catch (error) {
      const failure = guardFailure(error)
      if (failure === null) throw error
      c.header("cache-control", "no-store")
      return c.json(failure.body, failure.status)
    }
    await next()
    return undefined
  }
}
