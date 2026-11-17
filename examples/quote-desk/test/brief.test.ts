import { describe, expect, test } from "vitest"
import { brief } from "../server/review/brief.ts"
import { ERP_SEED } from "../server/quotes/erp-seed.ts"
import type { QuoteInput } from "../shared/types.ts"
import { memoryDesk } from "./helpers.ts"

const ME = { name: "Ada Lovelace", email: "ada@example.com" }

/** DEMO-SCRIPT step 1: Schrute Farms, 100 reams, Net 60, 8% "competitor match". */
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

function submitted() {
  const desk = memoryDesk()
  const quote = desk.submit(desk.create(STEP_1, ME, ME.name).id, ME.name)
  const budget = desk.quarter().territories.find((t) => t.territory === quote.territory)
  const customer = ERP_SEED.customers.find((c) => c.account_id === quote.account_id)
  return { quote, budget, customer }
}

describe("the reviewer's brief", () => {
  test("carries the frozen numbers, the flags and the ERP context", () => {
    const ctx = submitted()
    const text = brief({ ...ctx, answer: "ANSWER HERE" })
    const p = ctx.quote.pricing
    expect(text).toContain(`## Finance review: ${ctx.quote.id}`)
    expect(text).toContain(`**Margin ${String(p.margin_pct)}%**`)
    expect(text).toContain('Order discount: 8% ("competitor match")')
    expect(text).toContain("Payment terms: NET60")
    for (const flag of p.flags) expect(text).toContain(`- ${flag}`)
    expect(text).toContain(`Standing: ${String(ctx.customer?.standing)}`)
    expect(text).toContain("Budget Scranton")
    expect(text.endsWith("ANSWER HERE")).toBe(true)
  })

  test("says so when the ERP has no customer or budget", () => {
    const text = brief({ ...submitted(), customer: undefined, budget: undefined, answer: "" })
    expect(text).toContain("Customer: not in the ERP")
    expect(text).toContain("Budget: none on file")
  })
})
