// The reviewer handoff on the API: its status for Settings, creating a review
// board, and where a quote's handoff stands.
import { UnknownToolError, type Runtime, type ToolCaller } from "@botyard/runtime"
import { API } from "../../shared/api.ts"
import type { DeskSettings } from "../../shared/types.ts"
import { change, endpoint } from "../endpoint.ts"
import { HttpError, type Route } from "../http.ts"
import { confirmMember, type Guard } from "../members.ts"
import type { QuoteDesk } from "../quotes/desk.ts"
import type { SettingsStore } from "../quotes/settings.ts"
import { checkSetup, type ReviewRelay, type ReviewSetup } from "./relay.ts"
import { createReviewBoard, missingColumns, myBoards } from "./workforce.ts"

/** Org roles that may change the settings; see approvals.ts. */
const EDITORS = ["owner", "admin"] as const

/** The tools the handoff calls, plus a check for whether one is assigned. */
export type ReviewTools = ToolCaller & Pick<Runtime, "resolveToolName">

export type ReviewDeps = Guard & {
  readonly tools: ReviewTools
  readonly desk: QuoteDesk
  readonly settings: SettingsStore
  readonly relay: ReviewRelay
  readonly fileHosts: ReadonlySet<string>
}

/** A board and a handoff thread being saved must exist for this bot. */
export async function checkReviewSettings(next: DeskSettings, tools: ToolCaller): Promise<void> {
  if (next.review_board !== null) {
    const board = (await myBoards(tools)).find((b) => b.slug === next.review_board)
    if (board === undefined)
      throw new HttpError(400, `This bot is not a member of board ${next.review_board}`)
    const missing = missingColumns(board)
    if (missing.length > 0)
      throw new HttpError(400, `Board ${board.slug} is missing the columns ${missing.join(", ")}`)
  }
  if (next.handoff_thread !== null) {
    try {
      await tools.call("get_conversation", { conversation_id: next.handoff_thread })
    } catch {
      throw new HttpError(400, "The handoff thread is not a conversation of this bot")
    }
  }
}

async function hasTool(tools: ReviewTools, name: string): Promise<boolean> {
  try {
    await tools.resolveToolName(name)
    return true
  } catch (err) {
    if (err instanceof UnknownToolError) return false
    throw err
  }
}

function setupView(setup: ReviewSetup) {
  return setup.kind === "ready"
    ? { kind: setup.kind, board: setup.board, reviewer: setup.reviewer.name }
    : setup
}

export function reviewRoutes(deps: ReviewDeps): Route[] {
  const { tools, desk, settings, relay, fileHosts } = deps
  return [
    endpoint(deps, API.review, async () => ({
      setup: setupView(await checkSetup(tools, settings.get())),
      can_create_board: await hasTool(tools, "create_workforce"),
      boards: (await myBoards(tools)).map((b) => ({
        slug: b.slug,
        name: b.name,
        missing_columns: missingColumns(b),
      })),
      file_hosts: [...fileHosts],
    })),
    change(
      deps,
      API.createReviewBoard,
      {
        // Creating a board is a change on the platform: check the editor afresh first.
        prepare: async ({ member }) => {
          if (!(await hasTool(tools, "create_workforce")))
            throw new HttpError(
              403,
              "This bot can't create boards: assign it create_workforce, or pick an existing board"
            )
          await confirmMember(tools, member, EDITORS)
          return createReviewBoard(tools)
        },
        apply: (_ctx, slug) => settings.set({ ...settings.get(), review_board: slug }),
      },
      EDITORS
    ),
    endpoint(deps, API.quoteHandoff, ({ param }) => ({
      handoff: relay.state(desk.get(param("id"))),
    })),
  ]
}
