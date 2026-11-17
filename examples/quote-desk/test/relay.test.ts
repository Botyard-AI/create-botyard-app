import { OutcomeUnknownError, ToolError, TransportError, type MockHandler } from "@botyard/runtime"
import { describe, expect, test } from "vitest"
import { HandoffStore } from "../server/review/handoffs.ts"
import { NOT_SET_UP, ReviewRelay, checkSetup } from "../server/review/relay.ts"
import { REVIEW_COLUMNS } from "../server/review/workforce.ts"
import { EMPTY_SETTINGS, SettingsStore } from "../server/quotes/settings.ts"
import type { QuoteDesk } from "../server/quotes/desk.ts"
import type { DeskSettings, QuoteInput } from "../shared/types.ts"
import { memoryDesk, mockRuntime } from "./helpers.ts"

const ME = { name: "Ada Lovelace", email: "ada@example.com" }
const STEP_1: QuoteInput = {
  owner_email: null,
  account_id: "ACC-1001",
  territory: "Scranton",
  region: "Northeast",
  delivery_option: "STD",
  terms: "NET60",
  lines: [{ sku: "PPR-A4-80", qty: 100, unit_price_eur: null }],
  order_discount_pct: 8,
  order_discount_reason: "competitor match",
}
const FILES = "files.example.org"
/** A presigned link carries a credential; it must never be shown or logged. */
const SECRET = "X-Amz-Signature=deadbeef"
const SETUP: DeskSettings = {
  ...EMPTY_SETTINGS,
  reviewer_bot: "reviewer-bot",
  review_board: "quote-reviews",
}

type Task = {
  id: string
  number: number
  title: string
  column_id: string
  files: Record<string, string>
}

/** The platform as the relay sees it: one board, its members, its tasks and files. */
class FakePlatform {
  boards = [{ slug: "quote-reviews", name: "Quote reviews", columns: [...REVIEW_COLUMNS] }]
  members = ["bot-host", "bot-reviewer"]
  tasks: Task[] = []
  calls: { tool: string; args: Record<string, unknown> }[] = []
  /** Errors to throw, by tool, consumed one per call. */
  failures: Record<string, Error[]> = {}

  /** The mock runtime, with each workforce tool answered from this platform. */
  readonly runtime = mockRuntime(
    Object.fromEntries(
      [
        "list_my_workforces",
        "get_workforce_members",
        "create_task",
        "get_task",
        "list_task_files",
        "send_message_to_bot",
      ].map((tool): [string, MockHandler] => [tool, (args) => this.#handle(tool, args)])
    )
  )

  #handle(tool: string, args: Record<string, unknown>): unknown {
    this.calls.push({ tool, args })
    const fail = this.failures[tool]?.shift()
    if (fail !== undefined) throw fail
    return this.#answer(tool, args)
  }

  /** Calls of `tool`, all or about one quote. The seed data has a quote in review of its own. */
  count(tool: string, quoteId?: string): number {
    return this.calls.filter(
      (c) => c.tool === tool && (quoteId === undefined || this.#about(c.args, quoteId))
    ).length
  }

  /** The latest task for a quote. */
  task(quoteId: string): Task {
    const t = this.tasks.filter((x) => x.title.includes(quoteId)).at(-1)
    if (t === undefined) throw new Error(`no task for ${quoteId}`)
    return t
  }

  #about(args: Record<string, unknown>, quoteId: string): boolean {
    if (typeof args["title"] === "string") return args["title"].includes(quoteId)
    const t = this.tasks.find((x) => x.number === args["task_number"] || x.id === args["task_id"])
    return t?.title.includes(quoteId) ?? false
  }

  #answer(tool: string, args: Record<string, unknown>): unknown {
    switch (tool) {
      case "list_my_workforces":
        return { total: this.boards.length, boards: this.boards }
      case "get_workforce_members":
        return { members: this.members.map((id) => ({ bot_id: id, bot_name: id, bot_slug: id })) }
      case "create_task": {
        const t = {
          id: `task-${String(this.tasks.length + 1)}`,
          number: 100 + this.tasks.length,
          title: String(args["title"]),
          column_id: "review",
          files: {},
        }
        this.tasks.push(t)
        return { id: t.id, number: t.number, column_id: t.column_id }
      }
      case "get_task": {
        const t = this.tasks.find((x) => x.number === args["task_number"])
        if (t === undefined) throw new ToolError("Task not found")
        return { id: t.id, number: t.number, column_id: t.column_id }
      }
      case "list_task_files": {
        const t = this.tasks.find((x) => x.id === args["task_id"])
        return {
          result: Object.keys(t?.files ?? {}).map((name, i) => ({
            id: `file-${String(i)}`,
            filename: name,
            content_length: 10,
            download_url: `https://${FILES}/${name}?${SECRET}`,
          })),
        }
      }
      case "send_message_to_bot":
        return { status: "delivered" }
      default:
        throw new TransportError(`no tool ${tool}`)
    }
  }
}

/** A fetch that serves the fake platform's task files. */
function storage(platform: FakePlatform) {
  return async (url: string): Promise<Response> => {
    const name = new URL(url).pathname.slice(1)
    const body = platform.tasks.flatMap((t) => (name in t.files ? [t.files[name]] : [])).at(-1)
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body)
  }
}

function setup(settings: DeskSettings = SETUP, fileHosts: readonly string[] = [FILES]) {
  const platform = new FakePlatform()
  const desk = memoryDesk()
  const handoffs = new HandoffStore()
  let now = new Date("2026-11-10T09:00:00Z")
  const logs: string[] = []
  const relay = new ReviewRelay({
    desk,
    settings: new SettingsStore({ settings }),
    handoffs,
    tools: platform.runtime,
    fileHosts: new Set(fileHosts),
    fetch: storage(platform),
    now: () => now,
    log: (line) => logs.push(line),
  })
  const later = (ms: number) => {
    now = new Date(now.getTime() + ms)
  }
  const submit = () => desk.submit(desk.create(STEP_1, ME, ME.name).id, ME.name).id
  return { platform, desk, handoffs, relay, later, submit, logs }
}

function verdict(id: string, decision: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ quote_id: id, decision, note: "Margin below floor; 3% max.", ...extra })
}

const history = (desk: QuoteDesk, id: string) =>
  desk
    .get(id)
    .events.map((e) => ("note" in e ? e.note : ""))
    .join("\n")

describe("handing a quote to the reviewer bot", () => {
  test("without a board, the reviewer step is manual and nothing is created", async () => {
    const { platform, relay, desk, submit } = setup({ ...SETUP, review_board: null })
    const id = submit()
    await relay.tick()
    expect(relay.state(desk.get(id))).toMatchObject({ kind: "manual", reason: NOT_SET_UP })
    expect(platform.count("create_task", id)).toBe(0)
    expect(platform.count("list_my_workforces")).toBe(0)
  })

  test("a reviewer that isn't on the board gets no task, and the page says how to fix it", async () => {
    const { platform, relay, desk, submit } = setup()
    platform.members = ["bot-host"]
    const id = submit()
    await relay.tick()
    expect(relay.state(desk.get(id))).toMatchObject({
      kind: "manual",
      reason: "Reviewer Bot is not a member of board quote-reviews.",
      instruction: expect.stringContaining("join_workforce") as unknown,
    })
    expect(platform.count("create_task", id)).toBe(0)
  })

  test("a board without the review columns gets no task", async () => {
    const { platform, relay, desk, submit } = setup()
    platform.boards[0] = {
      slug: "quote-reviews",
      name: "Quote reviews",
      columns: [REVIEW_COLUMNS[0]],
    }
    const id = submit()
    await relay.tick()
    expect(relay.state(desk.get(id))).toMatchObject({ kind: "manual" })
    expect(platform.count("create_task", id)).toBe(0)
  })

  test("the reviewer's approval is recorded as its decision", async () => {
    const { platform, relay, desk, later, submit } = setup()
    const id = submit()
    await relay.tick()
    const create = platform.calls.find((c) => c.tool === "create_task")?.args
    expect(create).toMatchObject({
      workforce_slug: "quote-reviews",
      column_id: "review",
      assignee_bot_ids: ["bot-reviewer"],
    })
    expect(String(create?.["description"])).toContain(`## Finance review: ${id}`)
    expect(String(create?.["description"])).toContain("verdict.json")
    expect(relay.state(desk.get(id))).toMatchObject({
      kind: "task",
      task_number: 100,
      column: "review",
    })
    expect(history(desk, id)).toContain(
      `task #${String(platform.task(id).number)} on board quote-reviews`
    )
    // No handoff thread: no nudge, and nothing logged.
    expect(platform.count("send_message_to_bot")).toBe(0)

    platform.task(id).files["verdict.json"] = verdict(id, "approve", {
      analysis: "Credit is fine.",
    })
    platform.task(id).column_id = "approved"
    later(15_000)
    await relay.tick()
    const q = desk.get(id)
    expect(q.approvals.bot_review).toMatchObject({
      decision: "approve",
      note: "Margin below floor; 3% max.",
      by: "reviewer-bot (bot)",
    })
    expect(history(desk, id)).toContain("Credit is fine.")
    expect(relay.state(q)).toEqual({ kind: "none" })
  })

  test("changes requested sends the quote back to its owner", async () => {
    const { platform, relay, desk, later, submit } = setup()
    const id = submit()
    await relay.tick()
    platform.task(id).files["verdict.json"] = verdict(id, "reject")
    platform.task(id).column_id = "changes-requested"
    later(15_000)
    await relay.tick()
    expect(desk.get(id).status).toBe("draft")
  })

  test("a resubmitted quote gets a new task", async () => {
    const { platform, relay, desk, later, submit } = setup()
    const id = submit()
    await relay.tick()
    platform.task(id).files["verdict.json"] = verdict(id, "reject")
    platform.task(id).column_id = "changes-requested"
    later(15_000)
    await relay.tick()
    desk.submit(id, ME.name)
    later(1000)
    await relay.tick()
    expect(platform.count("create_task", id)).toBe(2)
    expect(relay.state(desk.get(id))).toMatchObject({
      kind: "task",
      task_number: platform.task(id).number,
    })
  })

  test("with a handoff thread, the reviewer is nudged from it", async () => {
    const thread = "0edf1856-7305-46b8-9861-324cae35f7dd"
    const { platform, relay, submit } = setup({ ...SETUP, handoff_thread: thread })
    submit()
    await relay.tick()
    expect(platform.calls.find((c) => c.tool === "send_message_to_bot")?.args).toMatchObject({
      bot_slug: "reviewer-bot",
      origin_conversation_id: thread,
    })
  })

  test("a create whose outcome is unknown is never retried", async () => {
    const { platform, relay, desk, later, submit } = setup()
    platform.failures["create_task"] = [new OutcomeUnknownError("timed out")]
    const id = submit()
    await relay.tick()
    later(60_000)
    await relay.tick()
    expect(platform.count("create_task", id)).toBe(1)
    expect(relay.state(desk.get(id))).toMatchObject({ kind: "manual" })
  })

  test("a platform it can't reach yet is tried again on the next pass", async () => {
    const { platform, relay, desk, submit } = setup()
    platform.failures["create_task"] = [new TransportError("down")]
    const id = submit()
    await relay.tick()
    expect(relay.state(desk.get(id))).toEqual({ kind: "pending" })
    await relay.tick()
    expect(relay.state(desk.get(id))).toMatchObject({ kind: "task" })
  })
})

describe("waiting for the verdict", () => {
  test("tasks are read only when due, with the wait doubling, and only for quotes in review", async () => {
    const { platform, relay, desk, later, submit } = setup()
    const id = submit()
    desk.create(STEP_1, ME, ME.name) // a draft: never looked at
    await relay.tick()
    await relay.tick() // not due yet
    expect(platform.count("get_task", id)).toBe(0)
    later(15_000)
    await relay.tick() // due: read, next wait 30 s
    later(15_000)
    await relay.tick() // not due
    expect(platform.count("get_task", id)).toBe(1)
    later(15_000)
    await relay.tick()
    expect(platform.count("get_task", id)).toBe(2)
    expect(platform.count("create_task", id)).toBe(1)
  })

  test("a moved task without verdict.json waits for the file", async () => {
    const { platform, relay, desk, later, submit } = setup()
    const id = submit()
    await relay.tick()
    platform.task(id).column_id = "approved"
    later(15_000)
    await relay.tick()
    expect(relay.state(desk.get(id))).toMatchObject({
      kind: "task",
      detail: "Moved to Approved; waiting for verdict.json.",
    })
    platform.task(id).files["verdict.json"] = verdict(id, "approve")
    later(30_000)
    await relay.tick()
    expect(desk.get(id).approvals.bot_review?.decision).toBe("approve")
  })

  test("a verdict that contradicts its column is not recorded", async () => {
    const { platform, relay, desk, later, submit } = setup()
    const id = submit()
    await relay.tick()
    platform.task(id).files["verdict.json"] = verdict(id, "reject")
    platform.task(id).column_id = "approved"
    later(15_000)
    await relay.tick()
    expect(desk.get(id).approvals.bot_review).toBeNull()
    expect(relay.state(desk.get(id))).toMatchObject({
      kind: "manual",
      reason: 'verdict.json: decision "reject" but the task is in approved',
    })
  })

  test("a link to a host that isn't allowed is refused, and never shown", async () => {
    const { platform, relay, desk, later, submit, logs } = setup(SETUP, ["other.example.org"])
    const id = submit()
    await relay.tick()
    platform.task(id).files["verdict.json"] = verdict(id, "approve")
    platform.task(id).column_id = "approved"
    later(15_000)
    await relay.tick()
    const state = relay.state(desk.get(id))
    expect(state).toMatchObject({
      kind: "manual",
      reason: `verdict.json can't be read: ${FILES} is not in QUOTE_DESK_FILE_HOSTS.`,
    })
    expect(desk.get(id).approvals.bot_review).toBeNull()
    for (const text of [JSON.stringify(state), history(desk, id), ...logs])
      expect(text).not.toContain(SECRET)
  })
})

describe("a handoff lost mid-review", () => {
  test("a board that disappears returns the quote to manual review, with why and when", async () => {
    const { platform, relay, desk, later, submit } = setup()
    const id = submit()
    await relay.tick()
    platform.boards = []
    platform.tasks = []
    later(15_000)
    await relay.tick()
    expect(relay.state(desk.get(id))).toMatchObject({
      kind: "manual",
      reason: "Board quote-reviews is gone, or this bot was removed from it.",
      since: "2026-11-10T09:00:15.000Z",
    })
    expect(history(desk, id)).toContain(
      "Reviewer handoff stopped (task #100 on board quote-reviews)"
    )
  })

  test("a task that can't be read three times running counts as gone", async () => {
    const { platform, relay, desk, later, submit } = setup()
    const id = submit()
    await relay.tick()
    platform.tasks = []
    for (const wait of [15_000, 30_000, 60_000]) {
      later(wait)
      await relay.tick()
    }
    expect(relay.state(desk.get(id))).toMatchObject({ kind: "manual" })
  })

  test("transport trouble is not a lost task", async () => {
    const { platform, relay, desk, later, submit } = setup()
    const id = submit()
    await relay.tick()
    platform.failures["get_task"] = [1, 2, 3, 4].map(() => new TransportError("down"))
    for (const wait of [15_000, 30_000, 60_000, 120_000]) {
      later(wait)
      await relay.tick()
    }
    expect(relay.state(desk.get(id))).toMatchObject({ kind: "task" })
  })
})

describe("checkSetup", () => {
  test("is ready when the board, its columns and the reviewer's membership all check out", async () => {
    expect(await checkSetup(new FakePlatform().runtime, SETUP)).toMatchObject({
      kind: "ready",
      board: "quote-reviews",
      reviewer: { id: "bot-reviewer" },
    })
  })
})
