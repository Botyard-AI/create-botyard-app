import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, test } from "vitest"
import type { QuoteInput } from "../shared/types.ts"
import { CRM_SEED } from "../server/quotes/crm-seed.ts"
import { DeskError, QuoteDesk, type DeskState } from "../server/quotes/desk.ts"
import {
  emptyApprovals,
  nextStatus,
  quarterEnd,
  quarterOf,
  rolesAt,
  signBy,
} from "../server/quotes/engine.ts"
import { ERP_SEED } from "../server/quotes/erp-seed.ts"
import { ParseError, parseDeskState, parseQuoteInput } from "../server/quotes/parse.ts"
import { loadState, saveState } from "../server/quotes/store.ts"
import {
  parseMeta,
  parsePricing,
  parseQuarter,
  parseQuoteRecord,
  parseQuoteList,
  parseQuoteView,
} from "../shared/parse.ts"
import { isRecord } from "../shared/narrow.ts"
import { memoryDesk } from "./helpers.ts"

const ME = { name: "Ada Lovelace", email: "ada@example.com" }

/** DEMO-SCRIPT step 1: Schrute Farms, 100 reams of copy paper, Net 60, 8% "competitor match". */
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

/** DEMO-SCRIPT step 4: the revision, 3% "multi-year paper contract", Net 45. */
const STEP_4: QuoteInput = {
  ...STEP_1,
  terms: "NET45",
  order_discount_pct: 3,
  order_discount_reason: "multi-year paper contract",
}

describe("pricing (the demo script's numbers)", () => {
  test("step 1: tier price, discount and both flags", () => {
    const p = memoryDesk().preview(STEP_1)
    expect(p.lines[0]?.unit_price_eur).toBe(20.4)
    expect(p.subtotal_eur).toBe(2040)
    expect(p.order_discount_eur).toBe(163.2)
    expect(p.margin_pct).toBe(24.3)
    expect(p.worst_discount_pct).toBe(14.3)
    expect(p.below_floor).toBe(true)
    expect(p.escalate).toBe(true)
    expect(p.delivery_cost_eur).toBe(45)
    expect(p.flags).toEqual([
      "margin 24.3% is below the 25% floor",
      "discount 14.3% is above the 10% escalation level",
    ])
  })

  test("step 4: the revision passes every rule", () => {
    const p = memoryDesk().preview(STEP_4)
    expect(p.margin_pct).toBe(28.2)
    expect(p.worst_discount_pct).toBe(9.6)
    expect(p.flags).toEqual([])
  })

  test("a hand-agreed unit price replaces the tier price", () => {
    const p = memoryDesk().preview({
      ...STEP_4,
      lines: [{ sku: "PPR-A4-80", qty: 100, unit_price_eur: 22 }],
    })
    expect(p.lines[0]?.unit_price_eur).toBe(22)
  })

  test("credit: an account on watch is referred to finance", () => {
    const p = memoryDesk().preview({ ...STEP_4, account_id: "ACC-1002" })
    expect(p.credit.decision).toBe("refer")
    expect(p.flags).toContain("credit: account is on watch; finance review needed")
  })
})

describe("dates", () => {
  test("quarters and the sign-by buffer", () => {
    expect(quarterOf("2026-11-10")).toBe("2026-Q4")
    expect(quarterEnd("2026-Q4")).toBe("2026-12-31")
    // Five working days back from Thursday 31 December 2026.
    expect(signBy("2026-11-10", 5)).toBe("2026-12-24")
    expect(signBy("2026-12-30", 5)).toBe("2026-12-30")
  })
})

describe("workflow", () => {
  test("the demo script's path from draft to signed", () => {
    const desk = memoryDesk()
    const q = desk.create(STEP_1, ME, ME.name)
    expect(q.id).toBe("Q-2026-0202")
    expect(q.status).toBe("draft")

    expect(desk.submit(q.id, ME.name).status).toBe("finance_review")
    expect(desk.get(q.id).progress.next).toBe("bot_review")

    // Step 3: the reviewer bot asks for changes; back to draft, approvals cleared.
    const rejected = desk.decide(
      q.id,
      "bot_review",
      "reject",
      "Margin under the floor. Max 3%, Net 45.",
      "Reviewer (bot)"
    )
    expect(rejected.status).toBe("draft")
    expect(rejected.progress.phase).toBe("changes_requested")
    expect(rejected.progress.detail).toBe("Margin under the floor. Max 3%, Net 45.")
    expect(rejected).not.toHaveProperty("priced_on")
    expect(rejected).not.toHaveProperty("sign_by")

    // Step 4: edit and resubmit.
    desk.update(q.id, STEP_4, ME, ME.name)
    desk.submit(q.id, ME.name)
    desk.decide(q.id, "bot_review", "approve", "OK at 28.2%.", "Reviewer (bot)")
    expect(desk.get(q.id).progress.next).toBe("finance")
    // Steps 5 and 6: finance, then business.
    expect(desk.decide(q.id, "finance", "approve", "", "Finance person").status).toBe(
      "business_review"
    )
    expect(desk.decide(q.id, "business", "approve", "", "Business person").status).toBe("approved")

    // Step 7: record the send, then the signature.
    const sent = desk.send(q.id, ME.name)
    expect(sent.status).toBe("sent")
    if (sent.status !== "sent") throw new Error("not sent")
    expect(sent.email.to).toMatch(/\.invalid$/)
    const signed = desk.sign(q.id, "customer")
    expect(signed.status).toBe("signed")
    expect(signed.events.map((e) => e.type)).toEqual([
      "created",
      "status",
      "approval",
      "status",
      "edited",
      "status",
      "approval",
      "approval",
      "status",
      "approval",
      "status",
      "status",
      "status",
    ])
  })

  test("submitted numbers are frozen; drafts are priced live", () => {
    const desk = memoryDesk()
    const q = desk.submit(desk.create(STEP_1, ME, ME.name).id, ME.name)
    expect(q).toMatchObject({ priced_on: "2026-11-10", sign_by: "2026-12-24" })
    expect(q.pricing.total_eur).toBe(1921.8)
  })

  test("refuses moves the workflow does not allow", () => {
    const desk = memoryDesk()
    const q = desk.create(STEP_1, ME, ME.name)
    expect(() => desk.decide(q.id, "finance", "approve", "", "x")).toThrow(DeskError)
    desk.submit(q.id, ME.name)
    expect(() => desk.update(q.id, STEP_4, ME, ME.name)).toThrow(/only drafts can be edited/)
    expect(() => desk.submit(q.id, ME.name)).toThrow(/only drafts can be submitted/)
    expect(() => desk.decide(q.id, "business", "approve", "", "x")).toThrow(
      /does not decide at finance_review/
    )
    desk.decide(q.id, "finance", "approve", "", "x")
    expect(() => desk.decide(q.id, "finance", "approve", "", "x")).toThrow(/already decided/)
    expect(() => desk.send(q.id, ME.name)).toThrow(/must be approved/)
    expect(() => desk.get("Q-2026-9999")).toThrow(/no quote/)
  })

  test("refuses input that names things the ERP does not have", () => {
    const desk = memoryDesk()
    expect(() => desk.create({ ...STEP_1, account_id: "ACC-0" }, ME, ME.name)).toThrow(
      /unknown account/
    )
    expect(() =>
      desk.create(
        { ...STEP_1, lines: [{ sku: "NOPE", qty: 1, unit_price_eur: null }] },
        ME,
        ME.name
      )
    ).toThrow(/unknown sku/)
    expect(() => desk.create({ ...STEP_1, lines: [] }, ME, ME.name)).toThrow(/at least one line/)
    expect(() => desk.create({ ...STEP_1, order_discount_pct: 51 }, ME, ME.name)).toThrow(
      /between 0% and 50%/
    )
  })

  test("records who created a quote for someone else", () => {
    const q = memoryDesk().create(
      STEP_1,
      { name: "Grace Hopper", email: "grace@example.com" },
      ME.name
    )
    expect(q.events[0]).toMatchObject({
      type: "created",
      by: ME.name,
      on_behalf_of: "Grace Hopper",
    })
  })

  test("reset brings back the seed, and new ids start at 0202", () => {
    const desk = memoryDesk()
    desk.create(STEP_1, ME, ME.name)
    expect(desk.reset()).toEqual({ quotes: 2 })
    expect(desk.create(STEP_1, ME, ME.name).id).toBe("Q-2026-0202")
  })

  test("quarter close counts a signed quote as committed", () => {
    const desk = memoryDesk()
    const before = desk.quarter().territories.find((t) => t.territory === "Scranton")
    expect(before?.days_left).toBe(51)
    const id = desk.create(STEP_4, ME, ME.name).id
    desk.submit(id, ME.name)
    for (const role of ["bot_review", "finance", "business"] as const)
      desk.decide(id, role, "approve", "", "x")
    desk.send(id, ME.name)
    desk.sign(id, "customer")
    const after = desk.quarter().territories.find((t) => t.territory === "Scranton")
    const total = desk.get(id).pricing.total_eur
    expect(after?.committed_eur).toBe((before?.committed_eur ?? 0) + total)
    expect(after?.headroom_eur).toBe((before?.headroom_eur ?? 0) - total)
  })
})

describe("parsing untrusted input", () => {
  const body = { ...STEP_1, lines: [{ sku: "PPR-A4-80", qty: 100 }] }

  test("accepts a builder body", () => {
    expect(parseQuoteInput(body)).toEqual(STEP_1)
  })

  test.each([
    [{ ...body, lines: [{ sku: "PPR-A4-80", qty: 1.5 }] }, /lines\[0\]\.qty/],
    [{ ...body, lines: [{ sku: "PPR-A4-80", qty: "100" }] }, /lines\[0\]\.qty/],
    [
      {
        ...body,
        lines: [
          { sku: "A", qty: 1 },
          { sku: "A", qty: 2 },
        ],
      },
      /each product may appear once/,
    ],
    [
      { ...body, lines: Array.from({ length: 51 }, (_, i) => ({ sku: String(i), qty: 1 })) },
      /at most 50/,
    ],
    [{ ...body, account_id: 7 }, /body\.account_id/],
    [{ ...body, order_discount_reason: "x".repeat(201) }, /order_discount_reason/],
    [[], /body: must be an object/],
  ])("refuses %#", (bad, message) => {
    expect(() => parseQuoteInput(bad)).toThrow(message)
  })

  test("the state file round-trips, and a broken one is refused", () => {
    const desk = memoryDesk()
    desk.decide(desk.list()[1]?.id ?? "", "bot_review", "approve", "fine", "x")
    const dir = mkdtempSync(path.join(tmpdir(), "qd-"))
    try {
      const file = path.join(dir, "state.json")
      expect(loadState(file)).toBeNull()
      saveState(file, desk.state())
      const loaded = loadState(file)
      expect(loaded).toEqual(desk.state())
      const again = new QuoteDesk({ erp: ERP_SEED, crm: CRM_SEED, state: loaded })
      expect(again.list()).toEqual(desk.list())

      writeFileSync(file, readFileSync(file, "utf8").replace('"version": 1', '"version": 2'))
      expect(() => loadState(file)).toThrow(ParseError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a state with an unknown event type is refused", () => {
    const state: DeskState = memoryDesk().state()
    const text = JSON.stringify({ version: 1, ...state }).replace(
      '"type":"created"',
      '"type":"teleported"'
    )
    const bad: unknown = JSON.parse(text)
    expect(() => parseDeskState(bad)).toThrow(/events\[0\]\.type/)
  })
})

describe("review stages", () => {
  const yes = { decision: "approve", note: "", by: "x", at: "2026-11-10" } as const

  test("each stage has its own deciders", () => {
    expect(rolesAt("finance_review")).toEqual(["bot_review", "finance"])
    expect(rolesAt("business_review")).toEqual(["business"])
  })

  test.each([
    ["finance_review", {}, "finance_review"],
    ["finance_review", { bot_review: yes }, "finance_review"],
    ["finance_review", { bot_review: yes, finance: yes }, "business_review"],
    ["business_review", { bot_review: yes, finance: yes }, "business_review"],
    ["business_review", { bot_review: yes, finance: yes, business: yes }, "approved"],
  ] as const)("%s with %o moves to %s", (stage, given, to) => {
    expect(nextStatus(stage, { ...emptyApprovals(), ...given })).toBe(to)
  })
})

describe("each status carries exactly its own fields", () => {
  /** A quote at each status, as stored. */
  function quotes(): Record<string, unknown> {
    const desk = memoryDesk()
    const id = desk.create(STEP_4, ME, ME.name).id
    const at: Record<string, unknown> = { draft: desk.state().quotes.at(-1) }
    desk.submit(id, ME.name)
    at["finance_review"] = desk.state().quotes.at(-1)
    desk.decide(id, "bot_review", "approve", "", "bot")
    desk.decide(id, "finance", "approve", "", "finance")
    at["business_review"] = desk.state().quotes.at(-1)
    desk.decide(id, "business", "approve", "", "business")
    at["approved"] = desk.state().quotes.at(-1)
    desk.send(id, ME.name)
    at["sent"] = desk.state().quotes.at(-1)
    desk.sign(id, "customer")
    at["signed"] = desk.state().quotes.at(-1)
    return at
  }

  /** The stored quote at `status`, as JSON, with `change` applied. */
  function stored(
    status: string,
    change: (r: Readonly<Record<string, unknown>>) => Record<string, unknown>
  ): unknown {
    const json: unknown = JSON.parse(JSON.stringify(quotes()[status]))
    if (!isRecord(json)) throw new Error("not a record")
    return change(json)
  }

  test.each(["draft", "finance_review", "business_review", "approved", "sent", "signed"])(
    "a %s quote round-trips",
    (status) => {
      const q = parseQuoteRecord(
        stored(status, (r) => ({ ...r })),
        "q"
      )
      expect(q.status).toBe(status)
    }
  )

  test.each([
    ["a signed quote without its signature date", "signed", "signed_at", undefined, /signed_at/],
    ["a sent quote without its email", "sent", "email", undefined, /email/],
    ["a submitted quote without frozen numbers", "approved", "priced_on", undefined, /priced_on/],
    ["a draft with frozen numbers", "draft", "priced_on", "2026-11-10", /draft quote has none/],
    ["a draft with a null sign-by date", "draft", "sign_by", null, /draft quote has none/],
    ["an approved quote with an email", "approved", "email", { to: "x" }, /approved quote/],
  ])("refuses %s", (_name, status, key, value, message) => {
    const bad = stored(status, (r) =>
      value === undefined
        ? Object.fromEntries(Object.entries(r).filter(([k]) => k !== key))
        : { ...r, [key]: value }
    )
    expect(() => parseQuoteRecord(bad, "q")).toThrow(message)
  })

  const approval = { decision: "approve", note: "", by: "x", at: "2026-11-10" }
  test.each([
    ["a draft with an approval", "draft", { bot_review: approval }],
    [
      "finance review with a rejection kept",
      "finance_review",
      { bot_review: { ...approval, decision: "reject" } },
    ],
    [
      "finance review with every finance approval in",
      "finance_review",
      { bot_review: approval, finance: approval },
    ],
    ["finance review with a business decision", "finance_review", { business: approval }],
    ["business review without finance approval", "business_review", { finance: null }],
    ["a signed quote missing an approval", "signed", { business: null }],
  ])("refuses %s", (_name, status, patch) => {
    const bad = stored(status, (r) => ({
      ...r,
      approvals: { ...(isRecord(r["approvals"]) ? r["approvals"] : {}), ...patch },
    }))
    expect(() => parseQuoteRecord(bad, "q")).toThrow(/approvals/)
  })
})

describe("the UI's parsers read what the API sends", () => {
  test("meta, pricing, quote, list and quarter round-trip through JSON", () => {
    const desk = memoryDesk()
    const id = desk.create(STEP_1, ME, ME.name).id
    desk.submit(id, ME.name)
    desk.decide(id, "bot_review", "reject", "Max 3%.", "Reviewer (bot)")
    const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

    expect(parseMeta(wire(desk.meta()))).toEqual(desk.meta())
    expect(parsePricing(wire(desk.preview(STEP_1)))).toEqual(desk.preview(STEP_1))
    expect(parseQuoteView(wire(desk.get(id)))).toEqual(desk.get(id))
    expect(parseQuoteList(wire({ quotes: desk.list() }))).toEqual({ quotes: desk.list() })
    expect(parseQuarter(wire(desk.quarter()))).toEqual(desk.quarter())
  })
})

describe("a failed save changes nothing", () => {
  /** A desk saving to a real file, with a switch that makes the next saves fail. */
  function fileDesk(dir: string) {
    const file = path.join(dir, "state.json")
    const disk = { full: false }
    const open = () =>
      new QuoteDesk({
        erp: ERP_SEED,
        crm: CRM_SEED,
        state: loadState(file),
        now: () => new Date("2026-11-10T09:00:00Z"),
        save: (state) => {
          if (disk.full) throw new Error("disk full")
          saveState(file, state)
        },
      })
    return { file, disk, open }
  }

  test("submit: read, retry and restart all see the draft until a save succeeds", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qd-"))
    try {
      const { disk, open } = fileDesk(dir)
      const desk = open()
      disk.full = true
      expect(() => desk.submit("Q-2026-0201", "Ada")).toThrow("disk full")
      expect(desk.get("Q-2026-0201").status).toBe("draft")
      expect(open().get("Q-2026-0201").status).toBe("draft")

      disk.full = false
      expect(desk.submit("Q-2026-0201", "Ada").status).toBe("finance_review")
      expect(open().get("Q-2026-0201").status).toBe("finance_review")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("create and reset: no id is used up and no quote is lost", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qd-"))
    try {
      const { disk, open } = fileDesk(dir)
      const desk = open()
      disk.full = true
      expect(() => desk.create(STEP_1, { name: "Ada", email: null }, "Ada")).toThrow("disk full")
      expect(desk.list()).toHaveLength(2)

      disk.full = false
      expect(desk.create(STEP_1, { name: "Ada", email: null }, "Ada").id).toBe("Q-2026-0202")

      disk.full = true
      expect(() => desk.reset()).toThrow("disk full")
      expect(desk.list()).toHaveLength(3)
      expect(open().list()).toHaveLength(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a desk that cannot save its first state refuses to start", () => {
    expect(
      () =>
        new QuoteDesk({
          erp: ERP_SEED,
          crm: CRM_SEED,
          save: () => {
            throw new Error("read-only")
          },
        })
    ).toThrow("read-only")
  })

  test("a failed rename leaves no temporary file behind", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qd-"))
    try {
      // A directory where the state file should be makes the rename fail.
      const file = path.join(dir, "state.json")
      mkdirSync(path.join(file, "occupied"), { recursive: true })
      expect(() => {
        saveState(file, memoryDesk().state())
      }).toThrow()
      expect(readdirSync(dir)).toEqual(["state.json"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
