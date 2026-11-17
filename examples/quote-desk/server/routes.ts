// The quote desk API. Every route here is for org members only: the viewer
// comes from @botyard/botpage, never from the request body, so "who did this"
// in a quote's history is always the signed-in person. Each route serves one
// entry of the API table (shared/api.ts), which fixes its method, path,
// parsers and answer type.
import type { BotPage, MemberViewer } from "@botyard/botpage"
import { API } from "../shared/api.ts"
import type { Person } from "../shared/types.ts"
import { endpoint } from "./endpoint.ts"
import type { QuoteDesk } from "./quotes/desk.ts"
import { HttpError, type Route } from "./http.ts"

/** How a member is named in a quote's history. */
export function displayName(member: Pick<MemberViewer, "name" | "email" | "userId">): string {
  return member.name ?? member.email ?? member.userId
}

export function quoteRoutes(desk: QuoteDesk, botpage: BotPage): Route[] {
  /** An owner a builder picked, checked against the org. */
  async function lookupOwner(email: string): Promise<Person> {
    const found = await botpage.members.lookup(email)
    if (found === null) throw new HttpError(400, `${email} is not a member of this org`)
    return { name: displayName(found), email: found.email }
  }

  return [
    endpoint(botpage, API.meta, () => desk.meta()),
    endpoint(botpage, API.members, async () => ({
      members: (await botpage.members.list()).map((m) => ({
        user_id: m.userId,
        name: displayName(m),
        email: m.email,
      })),
    })),
    endpoint(botpage, API.preview, ({ body }) => desk.preview(body)),
    endpoint(botpage, API.listQuotes, () => ({ quotes: desk.list() })),
    endpoint(botpage, API.createQuote, async ({ body, member }) =>
      desk.create(
        body,
        body.owner_email === null
          ? { name: displayName(member), email: member.email }
          : await lookupOwner(body.owner_email),
        displayName(member)
      )
    ),
    endpoint(botpage, API.getQuote, ({ param }) => desk.get(param("id"))),
    endpoint(botpage, API.updateQuote, async ({ body, member, param }) =>
      desk.update(
        param("id"),
        body,
        // No owner picked while editing keeps the quote's owner.
        body.owner_email === null ? null : await lookupOwner(body.owner_email),
        displayName(member)
      )
    ),
    endpoint(botpage, API.submitQuote, ({ member, param }) =>
      desk.submit(param("id"), displayName(member))
    ),
    endpoint(botpage, API.sendQuote, ({ member, param }) =>
      desk.send(param("id"), displayName(member))
    ),
    endpoint(botpage, API.signQuote, ({ member, param }) =>
      desk.sign(param("id"), `customer (recorded by ${displayName(member)})`)
    ),
    endpoint(botpage, API.quarter, ({ query }) => desk.quarter(query.quarter ?? undefined)),
    endpoint(botpage, API.reset, () => desk.reset()),
  ]
}
