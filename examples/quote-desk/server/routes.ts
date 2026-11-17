// The quote desk API. Every route here is for org members only: the viewer
// comes from @botyard/botpage, never from the request body, so "who did this"
// in a quote's history is always the signed-in person.
import type { IncomingMessage, ServerResponse } from "node:http"
import type { BotPage, MemberViewer } from "@botyard/botpage"
import { requireMember } from "@botyard/botpage/node"
import type { MemberOption, Person } from "../shared/types.ts"
import type { QuoteDesk } from "./quotes/desk.ts"
import { parseQuoteInput } from "./quotes/parse.ts"
import { HttpError, readJson, sendJson, type Params, type Route } from "./http.ts"

type MemberHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  member: MemberViewer,
  params: Params
) => Promise<void>

/** How a member is named in a quote's history. */
export function displayName(member: Pick<MemberViewer, "name" | "email" | "userId">): string {
  return member.name ?? member.email ?? member.userId
}

const QUARTER = /^\d{4}-Q[1-4]$/

export function quoteRoutes(desk: QuoteDesk, botpage: BotPage): Route[] {
  const members = (method: Route["method"], path: string, handler: MemberHandler): Route => ({
    method,
    path,
    handler: (req, res, params) =>
      requireMember(botpage, (rq, rs, member) => handler(rq, rs, member, params))(req, res),
  })

  /** An owner a builder picked, checked against the org. */
  async function lookupOwner(email: string): Promise<Person> {
    const found = await botpage.members.lookup(email)
    if (found === null) throw new HttpError(400, `${email} is not a member of this org`)
    return { name: displayName(found), email: found.email }
  }

  return [
    members("GET", "/api/meta", async (_req, res) => {
      sendJson(res, 200, desk.meta())
    }),
    members("GET", "/api/members", async (_req, res) => {
      const list: MemberOption[] = (await botpage.members.list()).map((m) => ({
        user_id: m.userId,
        name: displayName(m),
        email: m.email,
      }))
      sendJson(res, 200, { members: list })
    }),
    members("POST", "/api/preview", async (req, res) => {
      sendJson(res, 200, desk.preview(parseQuoteInput(await readJson(req))))
    }),
    members("GET", "/api/quotes", async (_req, res) => {
      sendJson(res, 200, { quotes: desk.list() })
    }),
    members("POST", "/api/quotes", async (req, res, member) => {
      const input = parseQuoteInput(await readJson(req))
      sendJson(
        res,
        201,
        desk.create(
          input,
          input.owner_email === null
            ? { name: displayName(member), email: member.email }
            : await lookupOwner(input.owner_email),
          displayName(member)
        )
      )
    }),
    members("GET", "/api/quotes/:id", async (_req, res, _member, { id = "" }) => {
      sendJson(res, 200, desk.get(id))
    }),
    members("PUT", "/api/quotes/:id", async (req, res, member, { id = "" }) => {
      const input = parseQuoteInput(await readJson(req))
      sendJson(
        res,
        200,
        desk.update(
          id,
          input,
          // No owner picked while editing keeps the quote's owner.
          input.owner_email === null ? null : await lookupOwner(input.owner_email),
          displayName(member)
        )
      )
    }),
    members("POST", "/api/quotes/:id/submit", async (_req, res, member, { id = "" }) => {
      sendJson(res, 200, desk.submit(id, displayName(member)))
    }),
    members("POST", "/api/quotes/:id/send", async (_req, res, member, { id = "" }) => {
      sendJson(res, 200, desk.send(id, displayName(member)))
    }),
    members("POST", "/api/quotes/:id/sign", async (_req, res, member, { id = "" }) => {
      sendJson(res, 200, desk.sign(id, `customer (recorded by ${displayName(member)})`))
    }),
    members("GET", "/api/quarter", async (req, res) => {
      const q = new URL(req.url ?? "/", "http://localhost").searchParams.get("quarter")
      if (q !== null && !QUARTER.test(q)) throw new HttpError(400, "quarter must look like 2026-Q4")
      sendJson(res, 200, desk.quarter(q ?? undefined))
    }),
    members("POST", "/api/reset", async (_req, res) => {
      sendJson(res, 200, desk.reset())
    }),
  ]
}
