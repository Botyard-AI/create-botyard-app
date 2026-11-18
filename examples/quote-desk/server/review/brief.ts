// The brief the reviewer bot gets for a quote in finance review: the frozen
// numbers, the flags, and the ERP context a finance reviewer checks (credit,
// payment terms, the territory's budget). Everything comes from the desk's
// own data; nothing here calls out.
import { eur } from "../../shared/money.ts"
import type { Customer, QuarterRow, QuoteView } from "../../shared/types.ts"

export type BriefContext = {
  readonly quote: QuoteView
  /** The customer's ERP record, when the desk has one. */
  readonly customer: Customer | undefined
  /** The quote's territory in the quarter it must be signed in. */
  readonly budget: QuarterRow | undefined
  /** How the reviewer gives its verdict back. Depends on the channel. */
  readonly answer: string
}

const pct = (n: number): string => `${String(n)}%`

function lineText(l: QuoteView["pricing"]["lines"][number]): string {
  return (
    `- ${String(l.qty)} × ${l.name}: ${eur(l.unit_price_eur)} each ` +
    `(list ${eur(l.list_price_eur)}, effective discount ${pct(l.effective_discount_pct)}, ` +
    `margin ${pct(l.margin_pct)})`
  )
}

function deliveryText(p: QuoteView["pricing"]): string {
  const d = p.delivery
  return d.kind === "estimate"
    ? `${d.option}, ${eur(p.delivery_cost_eur)}, earliest ${d.earliest_delivery}`
    : `${d.option}: no estimate (${d.error})`
}

function customerText(c: Customer | undefined, terms: string): string[] {
  if (c === undefined) return ["- Customer: not in the ERP"]
  const available = c.credit_limit_eur - c.open_ar_eur
  return [
    `- Standing: ${c.standing}. Default terms ${c.default_terms}; this quote asks for ${terms}.`,
    `- Credit limit ${eur(c.credit_limit_eur)}, open receivables ${eur(c.open_ar_eur)}, ` +
      `available ${eur(available)}.`,
  ]
}

function budgetText(b: QuarterRow | undefined): string {
  if (b === undefined) return "- Budget: none on file for this territory and quarter"
  return (
    `- Budget ${b.territory} ${b.quarter}: ${eur(b.budget_eur)}, committed ` +
    `${eur(b.committed_eur)}, headroom ${eur(b.headroom_eur)}, ${String(b.days_left)} days left.`
  )
}

/** The brief, as Markdown. Fictional demo data only. */
export function brief({ quote: q, customer, budget, answer }: BriefContext): string {
  const p = q.pricing
  const reason = q.order_discount_reason === "" ? "no reason given" : `"${q.order_discount_reason}"`
  const flags = p.flags.length === 0 ? ["- None"] : p.flags.map((f) => `- ${f}`)
  return [
    `## Finance review: ${q.id} (${q.account})`,
    "",
    "The Quote desk needs your finance verdict on this quote. Fictional demo data.",
    "",
    "**Quote**",
    `- Owner: ${q.owner.name}. Customer: ${q.account} (${q.account_id}). ` +
      `Territory: ${q.territory}. Region: ${q.region}.`,
    ...p.lines.map(lineText),
    `- Order discount: ${pct(q.order_discount_pct)} (${reason}).`,
    `- Net revenue ${eur(p.revenue_eur)}, cost ${eur(p.cost_eur)}. **Margin ${pct(p.margin_pct)}** ` +
      `against a ${pct(p.margin_floor_pct)} floor. Worst effective discount ` +
      `${pct(p.worst_discount_pct)}; escalation above ${pct(p.discount_escalation_pct)}.`,
    `- Delivery: ${deliveryText(p)}. Total **${eur(p.total_eur)}**.`,
    `- Payment terms: ${q.terms}. Credit check: ${p.credit.decision} (${p.credit.reason}).`,
    "",
    "**Flags**",
    ...flags,
    "",
    "**ERP context**",
    ...customerText(customer, q.terms),
    budgetText(budget),
    "",
    answer,
  ].join("\n")
}
