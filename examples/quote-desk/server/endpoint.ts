// Serves an entry of the API table (shared/api.ts). The entry fixes the
// method, the path, how the body and the query are parsed, and the type the
// handler must return, so a handler cannot answer with anything the UI's
// parser would not accept, and no route pairs a path with a parser by hand.
import type { IncomingMessage } from "node:http"
import type { BotPage, MemberViewer } from "@botyard/botpage"
import { requireMember } from "@botyard/botpage/node"
import type { Endpoint, ParamName, Query } from "../shared/api.ts"
import type { DeepReadonly } from "../shared/narrow.ts"
import { HttpError, readJson, sendJson, type Route } from "./http.ts"

/** What a handler gets: the signed-in member, and the request already parsed. */
export type EndpointContext<P extends string, B, Q extends Query> = {
  readonly req: IncomingMessage
  readonly member: MemberViewer
  /** A path parameter. Only the names in the entry's path are accepted. */
  readonly param: (name: ParamName<P>) => string
  readonly body: B
  readonly query: Q
}

export type EndpointHandler<P extends string, B, R, Q extends Query> = (
  ctx: EndpointContext<P, B, Q>
) => DeepReadonly<R> | Promise<DeepReadonly<R>>

/** The route for one API entry, for org members (optionally only some roles). */
export function endpoint<P extends string, B, R, Q extends Query>(
  botpage: BotPage,
  def: Endpoint<P, B, R, Q>,
  handler: NoInfer<EndpointHandler<P, B, R, Q>>,
  roles?: readonly string[]
): Route {
  return {
    method: def.method,
    path: def.path,
    handler: (req, res, params) =>
      requireMember(
        botpage,
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
