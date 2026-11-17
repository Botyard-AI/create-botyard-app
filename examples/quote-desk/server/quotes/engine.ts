// Pricing, delivery, credit and approval rules. Pure functions, no I/O.
// Dates are ISO calendar dates (YYYY-MM-DD).
import {
  BUSINESS_ROLES,
  FINANCE_ROLES,
  type ApproverRole,
  type Approvals,
  type CreditDecision,
  type Customer,
  type DeliveryEstimate,
  type DeliveryLine,
  type Erp,
  type Line,
  type PricedLine,
  type Pricing,
  type QuarterRow,
  type QuoteRecord,
  type ReviewStage,
} from "../../shared/types.ts"

/** Highest order discount anyone may type in, in percent. */
export const MAX_ORDER_DISCOUNT_PCT = 50

/** Statuses that count towards a quarter's pipeline. */

export const round2 = (n: number): number => Math.round(n * 100) / 100
const pct = (num: number, den: number): number => (den ? Math.round((1000 * num) / den) / 10 : 0)
const sum = (xs: readonly number[]): number => round2(xs.reduce((s, x) => s + x, 0))

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000)
}

/** "2026-11-10" → "2026-Q4". */
export function quarterOf(iso: string): string {
  const year = iso.slice(0, 4)
  const month = Number(iso.slice(5, 7))
  return `${year}-Q${String(Math.ceil(month / 3))}`
}

/** Last day of a quarter: "2026-Q4" → "2026-12-31". */
export function quarterEnd(quarter: string): string {
  const [year, q] = quarter.split("-Q").map(Number)
  // Day 0 of the month after the quarter's last month is that month's last day.
  return new Date(Date.UTC(year ?? 0, (q ?? 0) * 3, 0)).toISOString().slice(0, 10)
}

/** The quarter end, moved back by N working days (weekends skipped), and never before today. */
export function signBy(today: string, bufferWorkingDays: number): string {
  let d = quarterEnd(quarterOf(today))
  let left = bufferWorkingDays
  while (left > 0) {
    d = addDays(d, -1)
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay()
    if (dow !== 0 && dow !== 6) left -= 1
  }
  return d > today ? d : today
}

function product(erp: Erp, sku: string) {
  const p = erp.products.find((x) => x.sku === sku)
  if (p === undefined) throw new RangeError(`unknown sku ${sku}`)
  return p
}

/** List price, or the best tier price the quantity reaches. */
export function unitPrice(erp: Erp, sku: string, qty: number): number {
  let price = product(erp, sku).list_price_eur
  const tiers = erp.price_tiers.filter((t) => t.sku === sku).sort((a, b) => a.min_qty - b.min_qty)
  for (const t of tiers) if (qty >= t.min_qty) price = t.unit_price_eur
  return price
}

/** Days until `need` units arrive at a warehouse from open POs, or null if they never do. */
function poWait(erp: Erp, sku: string, warehouse: string, need: number, today: string) {
  let cumulative = 0
  const pos = erp.purchase_orders
    .filter((p) => p.sku === sku && p.warehouse === warehouse && p.status === "open")
    .sort((a, b) => a.expected_date.localeCompare(b.expected_date))
  for (const po of pos) {
    cumulative += po.qty
    if (cumulative >= need) {
      return { days: daysBetween(today, po.expected_date), reason: `covered by ${po.po_id}` }
    }
  }
  return null
}

function bestLane(
  erp: Erp,
  line: { sku: string; qty: number },
  region: string,
  option: string,
  today: string
): DeliveryLine | null {
  const leadDays = product(erp, line.sku).supplier_lead_days
  let best: DeliveryLine | null = null
  for (const lane of erp.delivery_lanes) {
    if (lane.option_code !== option || lane.region !== region) continue
    const row = erp.stock.find((s) => s.sku === line.sku && s.warehouse === lane.warehouse)
    if (row === undefined) continue
    const available = row.on_hand - row.reserved
    let wait = { days: 0, reason: "in stock" }
    if (available < line.qty) {
      wait = poWait(erp, line.sku, lane.warehouse, line.qty - available, today) ?? {
        days: leadDays,
        reason: "not covered by open POs; supplier lead time",
      }
    }
    const date = addDays(today, Math.max(0, wait.days) + lane.transit_days)
    if (best === null || date < best.earliest_delivery) {
      best = {
        sku: line.sku,
        qty: line.qty,
        warehouse: lane.warehouse,
        earliest_delivery: date,
        reason: `${wait.reason} at ${lane.warehouse}`,
      }
    }
  }
  return best
}

/** Earliest delivery per line, from stock, open POs and lane transit days. */
export function estimateDelivery(
  erp: Erp,
  lines: readonly { sku: string; qty: number }[],
  region: string,
  option: string,
  today: string
): DeliveryEstimate {
  const opt = erp.delivery_options.find((o) => o.code === option)
  if (opt === undefined)
    return { kind: "unavailable", option, error: `unknown delivery option ${option}` }
  const results: DeliveryLine[] = []
  for (const line of lines) {
    const best = bestLane(erp, line, region, option, today)
    if (best === null) {
      return {
        kind: "unavailable",
        option,
        error: `no lane for ${line.sku} to ${region} via ${option}`,
      }
    }
    results.push(best)
  }
  const latest = results.reduce<string>(
    (d, l) => (l.earliest_delivery > d ? l.earliest_delivery : d),
    today
  )
  return {
    kind: "estimate",
    option,
    delivery_cost_eur: opt.cost_eur,
    earliest_delivery: latest,
    lines: results,
  }
}

export function creditDecision(customer: Customer | undefined, amount: number): CreditDecision {
  if (customer === undefined) return { decision: "refer", reason: "unknown account" }
  if (customer.standing === "hold") return { decision: "decline", reason: "account is on hold" }
  if (round2(customer.open_ar_eur + amount) > customer.credit_limit_eur) {
    return { decision: "refer", reason: "order takes the account over its credit limit" }
  }
  if (customer.standing === "watch") {
    return { decision: "refer", reason: "account is on watch; finance review needed" }
  }
  return { decision: "approve", reason: "within credit limit and in good standing" }
}

type Priceable = Pick<
  QuoteRecord,
  "account_id" | "region" | "delivery_option" | "lines" | "order_discount_pct"
>

function priceLines(erp: Erp, lines: readonly Line[], orderPct: number): PricedLine[] {
  return lines.map((l) => {
    const p = product(erp, l.sku)
    const unit =
      l.unit_price_eur !== null && l.unit_price_eur > 0
        ? l.unit_price_eur
        : unitPrice(erp, l.sku, l.qty)
    const revenue = unit * l.qty
    const cost = p.unit_cost_eur * l.qty
    const effectiveUnit = unit * (1 - orderPct / 100)
    return {
      sku: l.sku,
      name: p.name,
      qty: l.qty,
      unit_price_eur: round2(unit),
      list_price_eur: p.list_price_eur,
      revenue_eur: round2(revenue),
      cost_eur: round2(cost),
      margin_pct: pct(revenue - cost, revenue),
      discount_pct: pct(p.list_price_eur - unit, p.list_price_eur),
      effective_discount_pct: pct(p.list_price_eur - effectiveUnit, p.list_price_eur),
    }
  })
}

/** Full pricing for a quote as of `today`. */
export function priceQuote(erp: Erp, quote: Priceable, today: string): Pricing {
  const orderPct = Math.min(Math.max(quote.order_discount_pct, 0), MAX_ORDER_DISCOUNT_PCT)
  const lines = priceLines(erp, quote.lines, orderPct)
  // The order discount applies to the line subtotal, before delivery.
  const subtotal = sum(lines.map((l) => l.revenue_eur))
  const orderDiscount = round2((subtotal * orderPct) / 100)
  const revenue = round2(subtotal - orderDiscount)
  const cost = sum(lines.map((l) => l.cost_eur))
  const margin = pct(revenue - cost, revenue)
  const worstDiscount = lines.reduce((m, l) => Math.max(m, l.effective_discount_pct), 0)
  const floor = erp.settings.margin_floor_pct
  const escalation = erp.settings.discount_escalation_pct

  const delivery = estimateDelivery(erp, quote.lines, quote.region, quote.delivery_option, today)
  const deliveryCost = delivery.kind === "estimate" ? delivery.delivery_cost_eur : 0
  const total = round2(revenue + deliveryCost)
  const credit = creditDecision(
    erp.customers.find((c) => c.account_id === quote.account_id),
    total
  )
  const slips =
    delivery.kind === "estimate" && delivery.earliest_delivery > quarterEnd(quarterOf(today))

  const flags: string[] = []
  if (margin < floor) flags.push(`margin ${String(margin)}% is below the ${String(floor)}% floor`)
  if (worstDiscount > escalation) {
    flags.push(
      `discount ${String(worstDiscount)}% is above the ${String(escalation)}% escalation level`
    )
  }
  if (credit.decision !== "approve") flags.push(`credit: ${credit.reason}`)
  if (delivery.kind === "unavailable") flags.push(`delivery: ${delivery.error}`)
  else if (slips) flags.push(`delivery lands ${delivery.earliest_delivery}, after quarter end`)

  return {
    lines,
    subtotal_eur: subtotal,
    order_discount_pct: orderPct,
    order_discount_eur: orderDiscount,
    revenue_eur: revenue,
    cost_eur: cost,
    margin_pct: margin,
    margin_floor_pct: floor,
    below_floor: margin < floor,
    worst_discount_pct: worstDiscount,
    discount_escalation_pct: escalation,
    escalate: worstDiscount > escalation,
    delivery,
    delivery_cost_eur: deliveryCost,
    credit,
    total_eur: total,
    slips_next_quarter: slips,
    flags,
  }
}

export function emptyApprovals(): Approvals {
  return { bot_review: null, finance: null, business: null }
}

/** The roles that decide at a review stage. */
export function rolesAt(stage: ReviewStage): readonly ApproverRole[] {
  return stage === "finance_review" ? FINANCE_ROLES : BUSINESS_ROLES
}

/** Where a quote goes once every role at its stage has approved. */
export function nextStatus(stage: ReviewStage, approvals: Approvals): ReviewStage | "approved" {
  if (!rolesAt(stage).every((r) => approvals[r]?.decision === "approve")) return stage
  return stage === "finance_review" ? "business_review" : "approved"
}

/** Quarter-close view: budget, signed, pipeline and headroom per territory. */
export function quarterPanel(
  erp: Erp,
  quotes: readonly { record: QuoteRecord; total_eur: number }[],
  quarter: string,
  today: string
): QuarterRow[] {
  const end = quarterEnd(quarter)
  const daysLeft = Math.max(0, daysBetween(today, end))
  return erp.budgets
    .filter((b) => b.quarter === quarter)
    .map((b) => {
      const mine = quotes.filter((q) => q.record.territory === b.territory)
      const signed = sum(
        mine.map(({ record: r, total_eur }) =>
          r.status === "signed" && quarterOf(r.signed_at) === quarter ? total_eur : 0
        )
      )
      const pipeline = sum(
        mine.map(({ record: r, total_eur }) =>
          r.status !== "draft" && r.status !== "signed" && quarterOf(r.sign_by) === quarter
            ? total_eur
            : 0
        )
      )
      const committed = round2(b.committed_eur + signed)
      return {
        territory: b.territory,
        quarter,
        budget_eur: b.budget_eur,
        signed_eur: signed,
        pipeline_eur: pipeline,
        committed_eur: committed,
        headroom_eur: round2(b.budget_eur - committed),
        used_pct: pct(committed, b.budget_eur),
        covered_by_pipeline: committed + pipeline >= b.budget_eur,
        quarter_end: end,
        days_left: daysLeft,
      }
    })
}
