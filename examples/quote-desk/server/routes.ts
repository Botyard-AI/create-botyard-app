// The quote desk API. Every route here is for org members only: the viewer
// comes from @botyard/botpage, never from the request body, so "who did this"
// in a quote's history is always the signed-in person. Each route serves one
// entry of the API table (shared/api.ts), which fixes its method, path,
// parsers and answer type.
import type { MemberViewer } from "@botyard/botpage"
import { API } from "../shared/api.ts"
import type { Person } from "../shared/types.ts"
import { change, endpoint, nothing } from "./endpoint.ts"
import type { QuoteDesk } from "./quotes/desk.ts"
import { HttpError, type Route } from "./http.ts"
import type { Guard } from "./members.ts"

/** How a member is named in a quote's history. */
export function displayName(member: Pick<MemberViewer, "name" | "email" | "userId">): string {
  return member.name ?? member.email ?? member.userId
}

export function quoteRoutes(desk: QuoteDesk, guard: Guard): Route[] {
  const { botpage } = guard
  /** An owner a builder picked, checked against the org. */
  async function lookupOwner(email: string): Promise<Person> {
    const found = await botpage.members.lookup(email)
    if (found === null) throw new HttpError(400, `${email} is not a member of this org`)
    return { name: displayName(found), email: found.email }
  }

  return [
    endpoint(guard, API.meta, () => desk.meta()),
    endpoint(guard, API.members, async () => ({
      members: (await botpage.members.list()).map((m) => ({
        user_id: m.userId,
        name: displayName(m),
        email: m.email,
      })),
    })),
    endpoint(guard, API.preview, ({ body }) => desk.preview(body)),
    endpoint(guard, API.listQuotes, () => ({ quotes: desk.list() })),
    change(guard, API.createQuote, {
      prepare: ({ body }) => (body.owner_email === null ? null : lookupOwner(body.owner_email)),
      apply: ({ body, member }, owner) =>
        desk.create(
          body,
          owner ?? { name: displayName(member), email: member.email },
          displayName(member)
        ),
    }),
    endpoint(guard, API.getQuote, ({ param }) => desk.get(param("id"))),
    change(guard, API.updateQuote, {
      // No owner picked while editing keeps the quote's owner.
      prepare: ({ body }) => (body.owner_email === null ? null : lookupOwner(body.owner_email)),
      apply: ({ body, member, param }, owner) =>
        desk.update(param("id"), body, owner, displayName(member)),
    }),
    change(guard, API.submitQuote, {
      prepare: nothing,
      apply: ({ member, param }) => desk.submit(param("id"), displayName(member)),
    }),
    change(guard, API.sendQuote, {
      prepare: nothing,
      apply: ({ member, param }) => desk.send(param("id"), displayName(member)),
    }),
    change(guard, API.signQuote, {
      prepare: nothing,
      apply: ({ member, param }) =>
        desk.sign(param("id"), `customer (recorded by ${displayName(member)})`),
    }),
    endpoint(guard, API.quarter, ({ query }) => desk.quarter(query.quarter ?? undefined)),
    change(guard, API.reset, { prepare: nothing, apply: () => desk.reset() }),
  ]
}
