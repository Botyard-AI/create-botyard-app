import { createBotPage } from "@botyard/botpage"
import { OutcomeUnknownError, ToolError } from "@botyard/runtime"
import { describe, expect, test } from "vitest"
import { MEMBER_CACHE } from "../server/members.ts"
import { Notifier, pageUrl, type Notice } from "../server/notify.ts"
import type { QuoteDesk } from "../server/quotes/desk.ts"
import { EMPTY_SETTINGS, SettingsStore } from "../server/quotes/settings.ts"
import { HandoffStore } from "../server/review/handoffs.ts"
import { reviewRound } from "../server/review/relay.ts"
import type { QuoteInput } from "../shared/types.ts"
import { memoryDesk, mockRuntime } from "./helpers.ts"

const ORIGIN = "0b6c1c9e-3d1a-4f7e-9a51-2f0f3c2b9d10"
const ADA = { name: "Ada Lovelace", email: "ada@example.com" } // user-ada in fixtures/dev.json
const INPUT: QuoteInput = {
  owner_email: null,
  account_id: "ACC-1001",
  territory: "Scranton",
  region: "Northeast",
  delivery_option: "STD",
  terms: "NET45",
  lines: [{ sku: "PPR-A4-80", qty: 100, unit_price_eur: null }],
  order_discount_pct: 3,
  order_discount_reason: "multi-year contract",
}

type Sent = { user_ids: unknown; subject: unknown; body: unknown; target: unknown }

/** A notifier on the seed desk; Grace approves for finance, Ada for business. */
function setup(
  fail: Error[] = [],
  notices: readonly Notice[] = [],
  save?: (notices: readonly Notice[]) => void
) {
  const sent: Sent[] = []
  const counter = { calls: 0 }
  const saved: (readonly Notice[])[] = []
  const tools = mockRuntime({
    notify_human: (args) => {
      counter.calls++
      const err = fail.shift()
      if (err !== undefined) throw err
      sent.push({
        user_ids: args["user_ids"],
        subject: args["subject"],
        body: args["body"],
        target: args["target"],
      })
      return { notification_id: "n-1" }
    },
  })
  const desk = memoryDesk()
  const settings = new SettingsStore({
    settings: { ...EMPTY_SETTINGS, approvers: { finance: ["user-grace"], business: ["user-ada"] } },
  })
  const handoffs = new HandoffStore()
  const log: string[] = []
  const notifier = new Notifier({
    desk,
    settings,
    handoffs,
    botpage: createBotPage({ tools, env: {}, members: MEMBER_CACHE }),
    tools,
    origin: ORIGIN,
    pageUrl: "https://desk.example.org",
    notices,
    save: save ?? ((n) => saved.push(n)),
    log: (line) => log.push(line),
  })
  return {
    desk,
    settings,
    handoffs,
    notifier,
    sent,
    saved,
    log,
    get calls() {
      return counter.calls
    },
  }
}

/** Ada's quote, through finance into business review. */
function toBusiness(desk: QuoteDesk): string {
  const { id } = desk.create(INPUT, ADA, ADA.name)
  desk.submit(id, ADA.name)
  desk.decide(id, "bot_review", "approve", "", "Grace")
  desk.decide(id, "finance", "approve", "", "Grace")
  return id
}

describe("notifications", () => {
  test("business approvers are told once, in a new thread, with a link", async () => {
    const t = setup()
    const id = toBusiness(t.desk)
    await t.notifier.tick()
    await t.notifier.tick()
    expect(t.sent).toEqual([
      {
        user_ids: ["user-ada"],
        subject: `${id} needs your business sign-off`,
        body: t.sent[0]?.body,
        target: { kind: "new", title: `Quote desk · ${id}`, origin_conversation_id: ORIGIN },
      },
    ])
    expect(String(t.sent[0]?.body)).toContain(`Open it: https://desk.example.org/quotes/${id}`)
    expect(t.saved.at(-1)?.map((n) => n.outcome)).toEqual(["sent"])
  })

  test("finance is told only once the reviewer bot has answered", async () => {
    const t = setup()
    const { id } = t.desk.create(INPUT, ADA, ADA.name)
    t.desk.submit(id, ADA.name)
    await t.notifier.tick()
    expect(t.sent).toEqual([])
    const round = reviewRound(t.desk.get(id)) ?? ""
    t.handoffs.set({
      kind: "answered",
      quote_id: id,
      round,
      since: "2026-11-10T09:00:00Z",
      reviewer: "Reviewer Bot",
      decision: "approve",
      note: "fine",
    })
    await t.notifier.tick()
    expect(t.sent.map((s) => s.user_ids)).toEqual([["user-grace"]])
    expect(String(t.sent[0]?.body)).toContain("reviewer bot's recommendation (approve)")
  })

  test("the owner is told about requested changes, found by email", async () => {
    const t = setup()
    const { id } = t.desk.create(INPUT, ADA, ADA.name)
    t.desk.submit(id, ADA.name)
    t.desk.decide(id, "bot_review", "reject", "max 3%", "Grace")
    await t.notifier.tick()
    expect(t.sent.map((s) => [s.user_ids, s.subject])).toEqual([
      [["user-ada"], `${id}: changes requested`],
    ])
  })

  test("finance signed first is still told when the reviewer answers", async () => {
    const t = setup()
    const { id } = t.desk.create(INPUT, ADA, ADA.name)
    t.desk.submit(id, ADA.name)
    t.desk.decide(id, "finance", "approve", "", "Grace")
    await t.notifier.tick()
    expect(t.sent).toEqual([])
    t.handoffs.set({
      kind: "manual",
      quote_id: id,
      round: reviewRound(t.desk.get(id)) ?? "",
      since: "2026-11-10T09:00:00Z",
      reason: "no board",
      instruction: null,
    })
    await t.notifier.tick()
    expect(t.sent.map((s) => s.subject)).toEqual([`${id} needs your finance sign-off`])
    expect(String(t.sent[0]?.body)).toContain("record the reviewer step (finance has signed off)")
  })

  test("a reviewer step recorded before any answer tells finance once", async () => {
    const t = setup()
    const { id } = t.desk.create(INPUT, ADA, ADA.name)
    t.desk.submit(id, ADA.name)
    t.desk.decide(id, "bot_review", "approve", "", "Grace")
    await t.notifier.tick()
    await t.notifier.tick()
    expect(t.sent.map((s) => s.subject)).toEqual([`${id} needs your finance sign-off`])
    expect(String(t.sent[0]?.body)).toContain("sign off as finance (the reviewer step is recorded)")
  })

  test.each([
    ["a send that worked", []],
    ["a send whose outcome is unknown", [new OutcomeUnknownError("timed out")]],
  ])("a failed save does not resend %s", async (_name, fail) => {
    const t = setup([...fail], [], () => {
      throw new Error("disk full")
    })
    toBusiness(t.desk)
    await t.notifier.tick()
    await t.notifier.tick()
    expect(t.calls).toBe(1)
    expect(t.log.some((l) => l.includes("saving notices failed: disk full"))).toBe(true)
  })

  test("a resubmission is a new notice", async () => {
    const t = setup()
    const id = toBusiness(t.desk)
    await t.notifier.tick()
    t.desk.decide(id, "business", "reject", "no", "Ada")
    await t.notifier.tick()
    t.desk.submit(id, ADA.name)
    t.desk.decide(id, "bot_review", "approve", "", "Grace")
    t.desk.decide(id, "finance", "approve", "", "Grace")
    await t.notifier.tick()
    expect(t.sent.map((s) => s.subject)).toEqual([
      `${id} needs your business sign-off`,
      `${id}: changes requested`,
      `${id} needs your business sign-off`,
    ])
  })

  test("nobody to tell is logged once; approvers picked later are told", async () => {
    const t = setup()
    t.settings.set({ ...EMPTY_SETTINGS })
    toBusiness(t.desk)
    await t.notifier.tick()
    await t.notifier.tick()
    expect(t.sent).toEqual([])
    expect(t.log.filter((l) => l.includes("nobody to tell"))).toHaveLength(1)
    t.settings.set({ ...EMPTY_SETTINGS, approvers: { finance: [], business: ["user-ada"] } })
    await t.notifier.tick()
    expect(t.sent.map((s) => s.user_ids)).toEqual([["user-ada"]])
  })

  test("a failed send is retried, at most 3 times", async () => {
    const t = setup([new ToolError("no"), new ToolError("no"), new ToolError("no")])
    toBusiness(t.desk)
    for (let i = 0; i < 5; i++) await t.notifier.tick()
    expect(t.sent).toEqual([])
    expect(t.saved.at(-1)?.map((n) => n.outcome)).toEqual(["failed"])
  })

  test("a send whose outcome is unknown is not repeated", async () => {
    const t = setup([new OutcomeUnknownError("timed out")])
    toBusiness(t.desk)
    await t.notifier.tick()
    await t.notifier.tick()
    expect(t.sent).toEqual([])
    expect(t.saved.at(-1)?.map((n) => n.outcome)).toEqual(["unknown"])
  })

  test("notices saved before a restart are not sent again", async () => {
    const first = setup()
    toBusiness(first.desk)
    await first.notifier.tick()
    const again = setup([], first.saved.at(-1))
    toBusiness(again.desk)
    await again.notifier.tick()
    expect(again.sent).toEqual([])
  })
})

test("the page URL must be https", () => {
  expect(pageUrl(undefined)).toBeNull()
  expect(pageUrl("https://desk.example.org/")).toBe("https://desk.example.org")
  expect(() => pageUrl("http://desk.example.org")).toThrow("https")
  for (const bad of [
    "https://user:secret@desk.example.org",
    "https://desk.example.org/?token=x",
    "https://desk.example.org/#x",
  ])
    expect(() => pageUrl(bad)).toThrow("must not have")
})
