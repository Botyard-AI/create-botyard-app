// Approver settings and the decisions people make on quotes. Who may decide
// is configuration (data/settings.json), checked against the signed-in viewer:
// nobody can approve for a role they have not been given.
//
// Two rules hold for every change here:
// - Authority belongs to a member's user id, which never changes. An email
//   address can be reassigned to someone else.
// - Every change runs through `change` (endpoint.ts), which checks the viewer
//   again after the last await, just before the change, so authority cannot
//   outlive a removal or demotion that lands while the request waits on the
//   body or the directory.
import type { BotPage } from "@botyard/botpage"
import type { ToolCaller } from "@botyard/runtime"
import { API } from "../shared/api.ts"
import { HUMAN_ROLES, type DeskSettings, type MemberOption } from "../shared/types.ts"
import { change, endpoint, nothing } from "./endpoint.ts"
import { HttpError, type Route } from "./http.ts"
import { listOrgBots } from "./org.ts"
import type { QuoteDesk } from "./quotes/desk.ts"
import { ROLE_LABEL } from "./quotes/desk.ts"
import type { SettingsStore } from "./quotes/settings.ts"
import { displayName } from "./routes.ts"

/** Org roles that may change who approves. */
export const SETTINGS_EDITORS = ["owner", "admin"] as const

export type ApprovalDeps = {
  desk: QuoteDesk
  settings: SettingsStore
  botpage: BotPage
  tools: ToolCaller
}

/** Every reviewer bot and approver must exist in the org. */
async function checkSettings(next: DeskSettings, { botpage, tools }: ApprovalDeps): Promise<void> {
  if (next.reviewer_bot !== null) {
    const bots = await listOrgBots(tools)
    if (!bots.some((b) => b.slug === next.reviewer_bot))
      throw new HttpError(400, `${next.reviewer_bot} is not a bot in this org`)
  }
  for (const role of HUMAN_ROLES) {
    for (const userId of next.approvers[role]) {
      const found = await botpage.members.lookup(userId)
      if (found?.userId !== userId)
        throw new HttpError(400, `${userId} is not a member of this org`)
    }
  }
}

/** The configured approvers who are still members, to show by name. */
async function people(settings: DeskSettings, botpage: BotPage): Promise<MemberOption[]> {
  const ids = new Set(HUMAN_ROLES.flatMap((role) => settings.approvers[role]))
  return (await botpage.members.list())
    .filter((m) => ids.has(m.userId))
    .map((m) => ({ user_id: m.userId, name: displayName(m), email: m.email }))
}

export function approvalRoutes(deps: ApprovalDeps): Route[] {
  const { desk, settings, botpage, tools } = deps
  return [
    endpoint(deps, API.settings, async ({ member }) => {
      const current = settings.get()
      return {
        settings: current,
        can_edit: SETTINGS_EDITORS.some((r) => r === member.role),
        my_roles: settings.rolesOf(member.userId),
        people: await people(current, botpage),
      }
    }),
    change(
      deps,
      API.saveSettings,
      {
        prepare: ({ body }) => checkSettings(body, deps),
        apply: ({ body }) => settings.set(body),
      },
      SETTINGS_EDITORS
    ),
    endpoint(deps, API.bots, async () => ({ bots: await listOrgBots(tools) })),
    change(deps, API.decideQuote, {
      prepare: nothing,
      // Roles are read from the settings for the fresh viewer, by user id.
      apply: ({ body: { role, decision, note }, member, param }) => {
        if (!settings.rolesOf(member.userId).includes(role))
          throw new HttpError(403, `You are not a ${ROLE_LABEL[role].toLowerCase()} approver`)
        return desk.decide(param("id"), role, decision, note, displayName(member))
      },
    }),
    change(deps, API.commentQuote, {
      prepare: nothing,
      apply: ({ body, member, param }) => desk.comment(param("id"), displayName(member), body.text),
    }),
  ]
}
