/**
 * Adapter for Next.js App Router route handlers and middleware. It uses only
 * the Web `Request`/`Response` types, so it imports nothing from `next`.
 *
 * Requests carry no socket here, so pass `bind: "127.0.0.1"` to
 * `createBotPage` (and start Next with `-H 127.0.0.1`) if you rely on the dev
 * viewer override. Platform tool calls need Node APIs: run middleware with
 * `export const config = { runtime: "nodejs" }`.
 */
import type { BotPage, MemberViewer, RequireMemberOptions, Viewer } from "./botpage.ts"
import { guardFailure, guardFailureResponse } from "./responses.ts"

export type RouteHandler<C, V> = (
  req: Request,
  context: C,
  viewer: V
) => Response | Promise<Response>

/** Wrap a route handler so it receives the viewer, or `null` when none was identified. */
export function withViewer<C>(
  botpage: BotPage,
  handler: RouteHandler<C, Viewer | null>
): (req: Request, context: C) => Promise<Response> {
  return async (req, context) => {
    let viewer: Viewer | null
    try {
      viewer = await botpage.viewer(req)
    } catch (error) {
      const failure = guardFailure(error)
      if (failure === null) throw error
      return guardFailureResponse(failure)
    }
    return handler(req, context, viewer)
  }
}

/** Wrap a route handler so it runs only for org members; others get JSON 401/403/503. */
export function withMember<C>(
  botpage: BotPage,
  handler: RouteHandler<C, MemberViewer>,
  options?: RequireMemberOptions
): (req: Request, context: C) => Promise<Response> {
  return async (req, context) => {
    let viewer: MemberViewer
    try {
      viewer = await botpage.requireMember(req, options)
    } catch (error) {
      const failure = guardFailure(error)
      if (failure === null) throw error
      return guardFailureResponse(failure)
    }
    return handler(req, context, viewer)
  }
}

/**
 * A middleware guard: resolves a 401/403/503 `Response` to return, or
 * `undefined` to let the request through.
 *
 * ```ts
 * const guard = memberGuard(botpage);
 * export async function middleware(req: NextRequest) {
 *   return (await guard(req)) ?? NextResponse.next();
 * }
 * ```
 */
export function memberGuard(
  botpage: BotPage,
  options?: RequireMemberOptions
): (req: Request) => Promise<Response | undefined> {
  return async (req) => {
    try {
      await botpage.requireMember(req, options)
      return undefined
    } catch (error) {
      const failure = guardFailure(error)
      if (failure === null) throw error
      return guardFailureResponse(failure)
    }
  }
}
