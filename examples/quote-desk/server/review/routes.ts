// The reviewer handoff on the API: its status for Settings, creating a review
// board, and where a quote's handoff stands.
import {
  OutcomeUnknownError,
  ToolError,
  UnknownToolError,
  type Runtime,
  type ToolCaller,
} from "@botyard/runtime"
import { API } from "../../shared/api.ts"
import type { DeskSettings } from "../../shared/types.ts"
import { change, endpoint } from "../endpoint.ts"
import { HttpError, type Route } from "../http.ts"
import { confirmMember, type Guard } from "../members.ts"
import type { QuoteDesk } from "../quotes/desk.ts"
import type { SettingsStore } from "../quotes/settings.ts"
import { checkSetup, type ReviewRelay, type ReviewSetup } from "./relay.ts"
import { REVIEW_BOARD_NAME, createReviewBoard, missingColumns, myBoards } from "./workforce.ts"

/** Org roles that may change the settings; see approvals.ts. */
const EDITORS = ["owner", "admin"] as const

/** The tools the handoff calls, a check for whether one is assigned, and who this bot is. */
export type ReviewTools = ToolCaller & Pick<Runtime, "resolveToolName" | "getIdentity">

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

/**
 * The review board, created once. Board names are unique in an org, so this
 * first picks up a "Quote desk reviews" board this bot is already on: pressing
 * the button again after an error, a lost answer or a failed save never makes
 * a second board.
 */
async function adoptOrCreateBoard(tools: ToolCaller): Promise<string> {
  const existing = (await myBoards(tools)).find((b) => b.name === REVIEW_BOARD_NAME)
  if (existing !== undefined) {
    const missing = missingColumns(existing)
    if (missing.length > 0)
      throw new HttpError(
        409,
        `Board ${existing.slug} is there but is missing the columns ${missing.join(", ")}`
      )
    return existing.slug
  }
  try {
    return await createReviewBoard(tools)
  } catch (err) {
    if (err instanceof OutcomeUnknownError)
      throw new HttpError(
        503,
        "Creating the board may or may not have worked. Press Create review board again: " +
          "a board it made is picked up, never made twice"
      )
    if (err instanceof ToolError)
      throw new HttpError(
        409,
        `The board could not be created. A board named "${REVIEW_BOARD_NAME}" may exist ` +
          "without this bot on it: have this bot join it, or pick another board"
      )
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
        // Creating a board is a change on the platform: check the editor afresh
        // first. If anything fails after the board exists (change() checks the
        // editor again, or the save fails), it is left in place, and pressing
        // the button again picks it up (adoptOrCreateBoard).
        prepare: async ({ member }) => {
          if (!(await hasTool(tools, "create_workforce")))
            throw new HttpError(
              403,
              "This bot can't create boards: assign it create_workforce, or pick an existing board"
            )
          await confirmMember(tools, member, EDITORS)
          return adoptOrCreateBoard(tools)
        },
        apply: (_ctx, slug) => {
          try {
            return settings.set({ ...settings.get(), review_board: slug })
          } catch {
            throw new HttpError(
              500,
              `Board ${slug} is ready, but saving it as the review board failed. Press Create ` +
                "review board again to pick it up"
            )
          }
        },
      },
      EDITORS
    ),
    endpoint(deps, API.quoteHandoff, ({ param }) => ({
      handoff: relay.state(desk.get(param("id"))),
    })),
  ]
}
