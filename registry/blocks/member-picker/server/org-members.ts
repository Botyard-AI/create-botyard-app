// GET /api/members: the org's members, for the member picker.
//
// Add the route to `api` in server/app.ts:
//
//   import { orgMembersRoute } from "./org-members.ts"
//   ...
//   "GET /api/members": orgMembersRoute(botpage),
//
// Only members of the org get the list; everyone else gets 401 or 403.
//
// The list comes from `botpage.members`, which calls the `list_org_members`
// tool through @botyard/runtime and caches the answer (60 s by default, see
// `members` in createBotPage). The platform sees one listing per minute,
// however often the picker loads.
import type { IncomingMessage, ServerResponse } from "node:http"
import type { BotPage, OrgMember } from "@botyard/botpage"
import { guardFailure } from "@botyard/botpage"
import { requireMember, sendGuardFailure } from "@botyard/botpage/node"

/** One member, as the picker shows them. */
export type MemberOption = {
  readonly userId: string
  readonly name: string | null
  readonly email: string | null
  /** The org role id, such as `owner`, `admin` or `member`. */
  readonly role: string | null
}

/** The route's handler. Answers `{ members: MemberOption[] }`, sorted by name. */
export function orgMembersRoute(
  botpage: BotPage
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return requireMember(botpage, async (_req, res) => {
    let members: OrgMember[]
    try {
      members = await botpage.members.list()
    } catch (error) {
      // The directory could not be read: 503, as the guards answer.
      const failure = guardFailure(error)
      if (failure === null) throw error
      sendGuardFailure(res, failure)
      return
    }
    const options = members.map(toOption).sort(byName)
    const body = JSON.stringify({ members: options })
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    })
    res.end(body)
  })
}

function toOption(member: OrgMember): MemberOption {
  return { userId: member.userId, name: member.name, email: member.email, role: member.role }
}

function byName(a: MemberOption, b: MemberOption): number {
  const label = (m: MemberOption): string => m.name ?? m.email ?? m.userId
  return label(a).localeCompare(label(b))
}
