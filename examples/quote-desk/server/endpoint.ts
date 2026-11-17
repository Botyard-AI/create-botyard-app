// Serves an entry of the API table (shared/api.ts). The entry fixes the
// method, the path, how the body and the query are parsed, and the type the
// handler must return, so a handler cannot answer with anything the UI's
// parser would not accept, and no route pairs a path with a parser by hand.
//
// Reads use `endpoint`. Anything that changes state uses `change`, which
// checks the viewer again after the last await (the body, and whatever its
// `prepare` step looks up), against a fresh directory listing rather than the
// cache (members.ts), and then runs `apply`. `apply` is synchronous, so
// nothing can wait between that check and the change: a member removed or
// demoted while the request was in flight is refused.
import type { IncomingMessage } from "node:http"
import type { MemberViewer } from "@botyard/botpage"
import { requireMember } from "@botyard/botpage/node"
import type { Endpoint, ParamName, Query } from "../shared/api.ts"
import type { DeepReadonly } from "../shared/narrow.ts"
import { HttpError, readJson, sendJson, type Route } from "./http.ts"
import { confirmMember, type Guard } from "./members.ts"

/** What a handler gets: the signed-in member, and the request already parsed. */
export type EndpointContext<P extends string, B, Q extends Query> = {
  readonly req: IncomingMessage
  readonly member: MemberViewer
  /** A path parameter. Only the names in the entry's path are accepted. */
  readonly param: (name: ParamName<P>) => string
  readonly body: B
  readonly query: Q
}

type Answer<R> = DeepReadonly<R> | Promise<DeepReadonly<R>>

function serve<P extends string, B, R, Q extends Query>(
  guard: Guard,
  def: Endpoint<P, B, R, Q>,
  handler: (ctx: EndpointContext<P, B, Q>) => Answer<R>,
  roles: readonly string[] | undefined
): Route {
  return {
    method: def.method,
    path: def.path,
    handler: (req, res, params) =>
      requireMember(
        guard.botpage,
        async (rq, rs, member) => {
          const body = def.body(def.sendsBody ? await readJson(rq) : {})
          const query = def.query(new URL(rq.url ?? "/", "http://localhost").searchParams)
          const param = (name: ParamName<P>): string => {
            const value = params[name]
            if (value === undefined) throw new HttpError(404, "not found")
            return value
          }
          sendJson(rs, def.status, await handler({ req: rq, member, param, body, query }))
        },
        roles === undefined ? {} : { roles }
      )(req, res),
  }
}

/** A route that only reads, for org members (optionally only some org roles). */
export function endpoint<P extends string, B, R, Q extends Query>(
  guard: Guard,
  def: Endpoint<P, B, R, Q>,
  handler: NoInfer<(ctx: EndpointContext<P, B, Q>) => Answer<R>>,
  roles?: readonly string[]
): Route {
  return serve(guard, def, handler, roles)
}

/**
 * A route that changes state. `prepare` may await (directory lookups, other
 * tools); then the viewer is checked again against a fresh listing, must still
 * be a member and still pass `roles`, and `apply` makes the change.
 */
export function change<P extends string, B, R, Q extends Query, T>(
  guard: Guard,
  def: Endpoint<P, B, R, Q>,
  steps: {
    readonly prepare: (ctx: EndpointContext<P, B, Q>) => T | Promise<T>
    readonly apply: (ctx: EndpointContext<P, B, Q>, prepared: T) => DeepReadonly<NoInfer<R>>
  },
  roles?: readonly string[]
): Route {
  return serve(
    guard,
    def,
    async (ctx) => {
      const prepared = await steps.prepare(ctx)
      await confirmMember(guard.tools, ctx.member, roles)
      return steps.apply(ctx, prepared)
    },
    roles
  )
}

/** For a change that needs nothing looked up first. */
export const nothing = (): null => null
