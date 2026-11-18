import { OutcomeUnknownError, ToolError, TransportError, type MockHandler } from "@botyard/runtime"
import { describe, expect, test } from "vitest"
import { EMPTY_SETTINGS, SettingsStore } from "../server/quotes/settings.ts"
import { HandoffStore } from "../server/review/handoffs.ts"
import { NOT_SET_UP, ReviewRelay } from "../server/review/relay.ts"
import { REVIEW_COLUMNS } from "../server/review/workforce.ts"
import type { DeskSettings } from "../shared/types.ts"
import { asViewer, memoryDesk, mockRuntime, startApp } from "./helpers.ts"
import fixtures from "../fixtures/dev.json" with { type: "json" }

const ADA = "ada@example.com" // owner in fixtures/dev.json
const GRACE = "grace@example.com" // member
const THREAD = "0b6c1c9e-3d1a-4f7e-9a51-2f0f3c2b9d10"

function send(viewer: string, method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "x-forwarded-user": viewer, "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  }
}

async function json(res: Response): Promise<unknown> {
  return res.json()
}

const BOARDS = [
  { slug: "quote-reviews", name: "Quote reviews", columns: [...REVIEW_COLUMNS] },
  { slug: "general", name: "General", columns: [{ id: "todo", name: "To do" }] },
]

/** What the fake platform does around create_workforce. */
type Trouble = {
  /** The create works, but its answer is lost. */
  lostAck?: boolean
  /** The create is refused (e.g. the name is taken by a board this bot isn't on). */
  refused?: boolean
  /** After the create, Ada is no longer an owner. */
  demoteAfter?: boolean
  /** After the create, the member directory can't be reached. */
  directoryDownAfter?: boolean
}

/**
 * The workforce tools, answered from BOARDS plus the boards created.
 * `create_workforce` only when `canCreate`.
 */
function platform(canCreate: boolean, trouble: Trouble = {}) {
  const created: Record<string, unknown>[] = []
  const boards = [...BOARDS]
  const members = fixtures.tools.list_org_members.result
  const handlers: Record<string, MockHandler> = {
    list_my_workforces: () => ({ total: boards.length, boards }),
    get_workforce_members: () => ({
      members: [{ bot_id: "bot-reviewer", bot_name: "Reviewer Bot", bot_slug: "reviewer-bot" }],
    }),
    get_conversation: (args) => {
      if (args["conversation_id"] !== THREAD) throw new ToolError("Conversation not found")
      return { id: THREAD }
    },
    list_org_members: () => {
      if (created.length === 0) return members
      if (trouble.directoryDownAfter === true) throw new TransportError("directory down")
      if (trouble.demoteAfter !== true) return members
      return {
        ...members,
        members: members.members.map((m) =>
          m.user_id === "user-ada" ? { ...m, role_id: "member" } : m
        ),
      }
    },
    ...(canCreate && {
      create_workforce: (args: Record<string, unknown>) => {
        if (trouble.refused === true) throw new ToolError("A workforce named that already exists.")
        created.push(args)
        boards.push({
          slug: "quote-desk-reviews",
          name: "Quote desk reviews",
          columns: [...REVIEW_COLUMNS],
        })
        if (trouble.lostAck === true) throw new OutcomeUnknownError("timed out")
        return { id: "wf-1", slug: "quote-desk-reviews" }
      },
    }),
  }
  return { tools: mockRuntime(handlers), created, boards }
}

async function app(
  canCreate = false,
  initial: DeskSettings = EMPTY_SETTINGS,
  trouble: Trouble = {},
  save?: (s: DeskSettings) => void
) {
  const { tools, created, boards } = platform(canCreate, trouble)
  const desk = memoryDesk()
  const settings = new SettingsStore({ settings: { ...initial }, ...(save && { save }) })
  const handoffs = new HandoffStore()
  const relay = new ReviewRelay({
    desk,
    settings,
    handoffs,
    tools,
    fileHosts: new Set(),
    now: () => new Date("2026-11-10T09:00:00Z"),
  })
  const fileHosts = new Set(["files.example.org"])
  const base = await startApp({ desk, settings, tools, relay, fileHosts })
  return { base, settings, created, relay, boards, trouble }
}

describe("review setup", () => {
  test("is off until a board is picked; lists this bot's boards and what each lacks", async () => {
    const { base } = await app()
    expect(await json(await fetch(`${base}/api/review`, asViewer(GRACE)))).toEqual({
      setup: { kind: "off", reason: NOT_SET_UP, instruction: null },
      can_create_board: false,
      boards: [
        { slug: "quote-reviews", name: "Quote reviews", missing_columns: [] },
        {
          slug: "general",
          name: "General",
          missing_columns: [
            "Review (review)",
            "Approved (approved)",
            "Changes requested (changes-requested)",
          ],
        },
      ],
      file_hosts: ["files.example.org"],
    })
  })

  test("is ready with a board that has the columns and the reviewer on it", async () => {
    const { base } = await app(false, {
      ...EMPTY_SETTINGS,
      reviewer_bot: "reviewer-bot",
      review_board: "quote-reviews",
    })
    expect(await json(await fetch(`${base}/api/review`, asViewer(GRACE)))).toMatchObject({
      setup: { kind: "ready", board: "quote-reviews", reviewer: "Reviewer Bot" },
    })
  })

  test("without create_workforce, the board button is refused and says what to assign", async () => {
    const { base, created } = await app(false)
    const res = await fetch(`${base}/api/review/board`, send(ADA, "POST"))
    expect(res.status).toBe(403)
    expect(await json(res)).toEqual({
      error: "This bot can't create boards: assign it create_workforce, or pick an existing board",
    })
    expect(created).toEqual([])
  })

  test("an owner creates the review board, which becomes the setting", async () => {
    const { base, settings, created } = await app(true)
    expect(await json(await fetch(`${base}/api/review`, asViewer(ADA)))).toMatchObject({
      can_create_board: true,
    })
    const res = await fetch(`${base}/api/review/board`, send(ADA, "POST"))
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ review_board: "quote-desk-reviews" })
    expect(settings.get().review_board).toBe("quote-desk-reviews")
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      columns: REVIEW_COLUMNS.map((c) => ({ id: c.id, name: c.name })),
    })
  })

  test("a member who is not an owner or admin cannot create it", async () => {
    const { base, created } = await app(true)
    const res = await fetch(`${base}/api/review/board`, send(GRACE, "POST"))
    expect(res.status).toBe(403)
    expect(created).toEqual([])
  })

  test.each([
    [
      "a board this bot is not on",
      { review_board: "elsewhere" },
      "This bot is not a member of board elsewhere",
    ],
    [
      "a board without the review columns",
      { review_board: "general" },
      "Board general is missing the columns Review (review), Approved (approved), Changes requested (changes-requested)",
    ],
    [
      "a handoff thread that is not this bot's",
      { handoff_thread: "11111111-2222-4333-8444-555555555555" },
      "The handoff thread is not a conversation of this bot",
    ],
    ["a handoff thread that is not an id", { handoff_thread: "general" }, null],
  ])("settings refuse %s", async (_name, change, error) => {
    const { base } = await app()
    const body = { ...EMPTY_SETTINGS, ...change }
    const res = await fetch(`${base}/api/settings`, send(ADA, "PUT", body))
    expect(res.status).toBe(400)
    if (error !== null) expect(await json(res)).toEqual({ error })
  })

  test("settings save a board and a handoff thread that check out", async () => {
    const { base, settings } = await app()
    const body = { ...EMPTY_SETTINGS, review_board: "quote-reviews", handoff_thread: THREAD }
    const res = await fetch(`${base}/api/settings`, send(ADA, "PUT", body))
    expect(res.status).toBe(200)
    expect(settings.get()).toMatchObject({ review_board: "quote-reviews", handoff_thread: THREAD })
  })
})

describe("a quote's handoff", () => {
  test("is none for a draft and manual, with the reason, once the relay finds no board", async () => {
    const { base, relay } = await app()
    expect(
      await json(await fetch(`${base}/api/quotes/Q-2026-0201/handoff`, asViewer(GRACE)))
    ).toEqual({ handoff: { kind: "none" } })
    // Q-2026-0200 is seeded in finance review.
    await relay.tick()
    expect(
      await json(await fetch(`${base}/api/quotes/Q-2026-0200/handoff`, asViewer(GRACE)))
    ).toEqual({
      handoff: {
        kind: "manual",
        since: "2026-11-10T09:00:00.000Z",
        reason: NOT_SET_UP,
        instruction: null,
      },
    })
  })

  test("is refused to people outside the org and for unknown quotes", async () => {
    const { base } = await app()
    expect(
      (await fetch(`${base}/api/quotes/Q-2026-0200/handoff`, asViewer("mallory@example.com")))
        .status
    ).toBe(403)
    expect((await fetch(`${base}/api/quotes/Q-1999-0001/handoff`, asViewer(GRACE))).status).toBe(
      404
    )
  })
})

describe("creating the review board never makes two", () => {
  const create = (base: string) => fetch(`${base}/api/review/board`, send(ADA, "POST"))

  test("a board this bot already made is picked up, not made again", async () => {
    const { base, boards, created, settings } = await app(true)
    boards.push({
      slug: "quote-desk-reviews",
      name: "Quote desk reviews",
      columns: [...REVIEW_COLUMNS],
    })
    expect((await create(base)).status).toBe(200)
    expect(created).toEqual([])
    expect(settings.get().review_board).toBe("quote-desk-reviews")
  })

  test("a lost answer says so, and pressing again picks the board up", async () => {
    const { base, created, settings } = await app(true, EMPTY_SETTINGS, { lostAck: true })
    const first = await create(base)
    expect(first.status).toBe(503)
    expect(await json(first)).toEqual({
      error:
        "Creating the board may or may not have worked. Press Create review board again: " +
        "a board it made is picked up, never made twice",
    })
    expect(settings.get().review_board).toBeNull()
    expect((await create(base)).status).toBe(200)
    expect(created).toHaveLength(1)
    expect(settings.get().review_board).toBe("quote-desk-reviews")
  })

  test("a failed save names the board, and pressing again picks it up", async () => {
    let fail = true
    const { base, created, settings } = await app(true, EMPTY_SETTINGS, {}, () => {
      if (fail) throw new Error("disk full")
    })
    const first = await create(base)
    expect(first.status).toBe(500)
    expect(await json(first)).toEqual({
      error:
        "Board quote-desk-reviews is ready, but saving it as the review board failed. Press " +
        "Create review board again to pick it up",
    })
    fail = false
    expect((await create(base)).status).toBe(200)
    expect(created).toHaveLength(1)
    expect(settings.get().review_board).toBe("quote-desk-reviews")
  })

  test.each([
    ["an editor demoted while it was made", { demoteAfter: true }],
    ["a member directory that went down while it was made", { directoryDownAfter: true }],
  ])("%s saves nothing; an editor's retry picks it up", async (_name, trouble) => {
    const t = await app(true, EMPTY_SETTINGS, trouble)
    expect((await create(t.base)).ok).toBe(false)
    expect(t.settings.get().review_board).toBeNull()
    t.trouble.demoteAfter = false
    t.trouble.directoryDownAfter = false
    expect((await create(t.base)).status).toBe(200)
    expect(t.created).toHaveLength(1)
    expect(t.settings.get().review_board).toBe("quote-desk-reviews")
  })

  test("a refused create says what to do instead", async () => {
    const { base, settings } = await app(true, EMPTY_SETTINGS, { refused: true })
    const res = await create(base)
    expect(res.status).toBe(409)
    expect(JSON.stringify(await json(res))).toContain(
      "have this bot join it, or pick another board"
    )
    expect(settings.get().review_board).toBeNull()
  })
})
