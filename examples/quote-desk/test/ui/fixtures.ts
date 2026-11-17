// Hand-built API shapes for UI tests. The UI project has no Node types, so
// these cannot come from the server's desk.
import type { Approval, Pricing, QuoteView } from "../../shared/types.ts"

export const pricing: Pricing = {
  lines: [],
  subtotal_eur: 2040,
  order_discount_pct: 8,
  order_discount_eur: 163.2,
  revenue_eur: 1876.8,
  cost_eur: 1420,
  margin_pct: 24.3,
  margin_floor_pct: 25,
  below_floor: true,
  worst_discount_pct: 14.3,
  discount_escalation_pct: 10,
  escalate: true,
  delivery: {
    kind: "estimate",
    option: "STD",
    delivery_cost_eur: 45,
    earliest_delivery: "2026-11-13",
    lines: [],
  },
  delivery_cost_eur: 45,
  credit: { decision: "approve", reason: "within credit limit and in good standing" },
  total_eur: 1921.8,
  slips_next_quarter: false,
  flags: [
    "margin 24.3% is below the 25% floor",
    "discount 14.3% is above the 10% escalation level",
  ],
}

export const approved = (by: string, note = ""): Approval => ({
  decision: "approve",
  note,
  by,
  at: "2026-11-10",
})

/** A quote in finance review; pass approvals to move it along. */
export function quoteInReview(approvals: Partial<QuoteView["approvals"]> = {}): QuoteView {
  return {
    id: "Q-2026-0200",
    owner: { name: "Jim Halpert", email: null },
    account_id: "ACC-1001",
    account: "Schrute Farms B&B",
    territory: "Scranton",
    region: "Northeast",
    delivery_option: "STD",
    terms: "NET60",
    lines: [{ sku: "PPR-A4-80", qty: 100, unit_price_eur: null }],
    order_discount_pct: 8,
    order_discount_reason: "competitor match",
    created_at: "2026-11-10",
    status: "finance_review",
    priced_on: "2026-11-10",
    sign_by: "2026-12-24",
    approvals: { bot_review: null, finance: null, business: null, ...approvals },
    events: [],
    pricing,
    progress: {
      phase: "bot_review_waiting",
      label: "Waiting for the reviewer bot",
      detail: "",
      tone: "info",
      next: "bot_review",
    },
  }
}
