// GET /api/members: the org's members, for the member picker.
//
// Add the route to `api` in server/app.ts:
//
//   import { orgMembersRoute } from "./org-members.ts"
//   ...
//   "GET /api/members": orgMembersRoute(botpage),
//
// Only members of the org get the list; everyone else gets 401 or 403. Each
// member sees every member's name, email and role (src/lib/org-members-contract.ts).
//
// The list comes from `botpage.members`, which calls the `list_org_members`
// tool through @botyard/runtime and caches the answer: 60 s by default, and
// up to 5 more minutes while the platform cannot be reached (see `members`
// in createBotPage). So the platform sees one listing per minute however
// often the picker loads, and someone removed from the org can still read
// the list for that long.
import type { IncomingMessage, ServerResponse } from "node:http"
import type { BotPage } from "@botyard/botpage"
import { BotPageAuthError, guardFailure } from "@botyard/botpage"
import { requireMember, sendGuardFailure } from "@botyard/botpage/node"
import { toMembersResponse } from "../src/lib/org-members-contract.ts"

/** The route's handler. Answers a MembersResponse, sorted by name. */
export function orgMembersRoute(
  botpage: BotPage
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return requireMember(botpage, async (_req, res, viewer) => {
    try {
      const members = await botpage.members.list()
      // The guard checked the viewer against the cached list, which may have
      // been refreshed since. Check them again against the list we send.
      if (!members.some((m) => m.userId === viewer.userId)) {
        throw new BotPageAuthError("not_a_member", "You are no longer a member of this org.")
      }
      const body = JSON.stringify(toMembersResponse(members))
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      })
      res.end(body)
    } catch (error) {
      // 403 as above, or 503 when the directory cannot be read, as the guards answer.
      const failure = guardFailure(error)
      if (failure === null) throw error
      sendGuardFailure(res, failure)
    }
  })
}
