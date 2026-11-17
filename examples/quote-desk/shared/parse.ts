// Parsers for quote records (the server's state file) and API responses (the UI).
import {
  APPROVER_ROLES,
  type Approval,
  type Approvals,
  type ApproverRole,
  type CreditDecision,
  type Decision,
  type DeliveryEstimate,
  type Line,
  type MemberOption,
  type Meta,
  type Person,
  type PricedLine,
  type Pricing,
  type Progress,
  type QuarterRow,
  type QuoteEvent,
  type QuoteRecord,
  type QuoteStatus,
  type QuoteSummary,
  type QuoteView,
  type SentEmail,
  type Standing,
  type Tone,
} from "./types.ts"
import {
  ParseError,
  bool,
  items,
  num,
  oneOf,
  record,
  str,
  strOrNull,
  strings,
  type Rec,
} from "./narrow.ts"

export const STATUSES: readonly QuoteStatus[] = [
  "draft",
  "finance_review",
  "business_review",
  "approved",
  "sent",
  "signed",
]

export const MAX_LINES = 50
const MAX_QTY = 1_000_000
const DECISIONS: readonly Decision[] = ["approve", "reject"]

export function parseLine(value: unknown, at: string): Line {
  const r = record(value, at)
  const qty = num(r, "qty", at)
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
    throw new ParseError(`${at}.qty: must be a whole number from 1 to ${String(MAX_QTY)}`)
  }
  const raw = r["unit_price_eur"]
  const price = raw === null || raw === undefined ? null : num(r, "unit_price_eur", at)
  if (price !== null && (price < 0 || price > 1_000_000)) {
    throw new ParseError(`${at}.unit_price_eur: out of range`)
  }
  return { sku: str(r, "sku", at, 40), qty, unit_price_eur: price === 0 ? null : price }
}

function person(value: unknown, at: string): Person {
  const r = record(value, at)
  return { name: str(r, "name", at), email: strOrNull(r, "email", at, 320) }
}

function approval(value: unknown, at: string): Approval | null {
  if (value === null) return null
  const r = record(value, at)
  return {
    decision: oneOf(r, "decision", DECISIONS, at),
    note: str(r, "note", at, 2000),
    by: str(r, "by", at),
    at: str(r, "at", at),
  }
}

function approvals(value: unknown, at: string): Approvals {
  const r = record(value, at)
  return {
    bot_review: approval(r["bot_review"], `${at}.bot_review`),
    finance: approval(r["finance"], `${at}.finance`),
    business: approval(r["business"], `${at}.business`),
  }
}

function event(value: unknown, at: string): QuoteEvent {
  const r = record(value, at)
  const base = { at: str(r, "at", at), ts: str(r, "ts", at), by: str(r, "by", at) }
  const type = oneOf(r, "type", ["created", "edited", "status", "approval", "comment"], at)
  switch (type) {
    case "created":
      return { ...base, type, on_behalf_of: strOrNull(r, "on_behalf_of", at) }
    case "edited":
      return { ...base, type }
    case "status":
      return { ...base, type, to: oneOf(r, "to", STATUSES, at), note: str(r, "note", at, 2000) }
    case "approval":
      return {
        ...base,
        type,
        role: oneOf<ApproverRole>(r, "role", APPROVER_ROLES, at),
        decision: oneOf(r, "decision", DECISIONS, at),
        note: str(r, "note", at, 2000),
      }
    case "comment":
      return { ...base, type, note: str(r, "note", at, 2000) }
  }
}

function email(value: unknown, at: string): SentEmail | null {
  if (value === null) return null
  const r = record(value, at)
  return {
    to: str(r, "to", at, 320),
    subject: str(r, "subject", at),
    body: str(r, "body", at, 4000),
    recorded_at: str(r, "recorded_at", at),
    recorded_by: str(r, "recorded_by", at),
  }
}

function quoteFields(r: Rec, at: string): QuoteRecord {
  return {
    id: str(r, "id", at, 40),
    owner: person(r["owner"], `${at}.owner`),
    account_id: str(r, "account_id", at, 40),
    territory: str(r, "territory", at, 80),
    region: str(r, "region", at, 80),
    delivery_option: str(r, "delivery_option", at, 40),
    terms: str(r, "terms", at, 40),
    lines: items(r, "lines", at, MAX_LINES, parseLine),
    order_discount_pct: num(r, "order_discount_pct", at),
    order_discount_reason: str(r, "order_discount_reason", at),
    status: oneOf(r, "status", STATUSES, at),
    created_at: str(r, "created_at", at),
    priced_on: strOrNull(r, "priced_on", at),
    sign_by: strOrNull(r, "sign_by", at),
    approvals: approvals(r["approvals"], `${at}.approvals`),
    email: email(r["email"], `${at}.email`),
    signed_at: strOrNull(r, "signed_at", at),
    events: items(r, "events", at, 10_000, event),
  }
}

export function parseQuoteRecord(value: unknown, at: string): QuoteRecord {
  return quoteFields(record(value, at), at)
}

// ---------- API responses ----------

const TONES: readonly Tone[] = ["muted", "info", "warning", "success"]
const NEXT: readonly (ApproverRole | "owner" | "customer")[] = [
  ...APPROVER_ROLES,
  "owner",
  "customer",
]

function progress(value: unknown, at: string): Progress {
  const r = record(value, at)
  return {
    phase: str(r, "phase", at),
    label: str(r, "label", at),
    detail: str(r, "detail", at, 2000),
    tone: oneOf(r, "tone", TONES, at),
    next: r["next"] === null ? null : oneOf(r, "next", NEXT, at),
  }
}

function pricedLine(value: unknown, at: string): PricedLine {
  const r = record(value, at)
  const n = (key: string) => num(r, key, at)
  return {
    sku: str(r, "sku", at, 40),
    name: str(r, "name", at),
    qty: n("qty"),
    unit_price_eur: n("unit_price_eur"),
    list_price_eur: n("list_price_eur"),
    revenue_eur: n("revenue_eur"),
    cost_eur: n("cost_eur"),
    margin_pct: n("margin_pct"),
    discount_pct: n("discount_pct"),
    effective_discount_pct: n("effective_discount_pct"),
  }
}

function delivery(value: unknown, at: string): DeliveryEstimate {
  const r = record(value, at)
  const option = str(r, "option", at, 40)
  if (oneOf(r, "kind", ["estimate", "unavailable"], at) === "unavailable") {
    return { kind: "unavailable", option, error: str(r, "error", at) }
  }
  return {
    kind: "estimate",
    option,
    delivery_cost_eur: num(r, "delivery_cost_eur", at),
    earliest_delivery: str(r, "earliest_delivery", at),
    lines: items(r, "lines", at, MAX_LINES, (v, p) => {
      const l = record(v, p)
      return {
        sku: str(l, "sku", p),
        qty: num(l, "qty", p),
        warehouse: str(l, "warehouse", p),
        earliest_delivery: str(l, "earliest_delivery", p),
        reason: str(l, "reason", p),
      }
    }),
  }
}

function credit(value: unknown, at: string): CreditDecision {
  const r = record(value, at)
  return {
    decision: oneOf(r, "decision", ["approve", "refer", "decline"], at),
    reason: str(r, "reason", at),
  }
}

export function parsePricing(value: unknown, at = "pricing"): Pricing {
  const r = record(value, at)
  const n = (key: string) => num(r, key, at)
  return {
    lines: items(r, "lines", at, MAX_LINES, pricedLine),
    subtotal_eur: n("subtotal_eur"),
    order_discount_pct: n("order_discount_pct"),
    order_discount_eur: n("order_discount_eur"),
    revenue_eur: n("revenue_eur"),
    cost_eur: n("cost_eur"),
    margin_pct: n("margin_pct"),
    margin_floor_pct: n("margin_floor_pct"),
    below_floor: bool(r, "below_floor", at),
    worst_discount_pct: n("worst_discount_pct"),
    discount_escalation_pct: n("discount_escalation_pct"),
    escalate: bool(r, "escalate", at),
    delivery: delivery(r["delivery"], `${at}.delivery`),
    delivery_cost_eur: n("delivery_cost_eur"),
    credit: credit(r["credit"], `${at}.credit`),
    total_eur: n("total_eur"),
    slips_next_quarter: bool(r, "slips_next_quarter", at),
    flags: strings(r, "flags", at, 20),
  }
}

export function parseQuoteView(value: unknown, at = "quote"): QuoteView {
  const r = record(value, at)
  return {
    ...quoteFields(r, at),
    account: str(r, "account", at),
    pricing: parsePricing(r["pricing"], `${at}.pricing`),
    progress: progress(r["progress"], `${at}.progress`),
  }
}

export function parseQuoteSummaries(value: unknown, at = "body"): QuoteSummary[] {
  return items(record(value, at), "quotes", at, 100_000, (v, p) => {
    const r = record(v, p)
    return {
      id: str(r, "id", p, 40),
      status: oneOf(r, "status", STATUSES, p),
      progress: progress(r["progress"], `${p}.progress`),
      owner: person(r["owner"], `${p}.owner`),
      account: str(r, "account", p),
      territory: str(r, "territory", p),
      total_eur: num(r, "total_eur", p),
      sign_by: strOrNull(r, "sign_by", p),
      updated: str(r, "updated", p),
      lines: num(r, "lines", p),
    }
  })
}

const STANDINGS: readonly Standing[] = ["good", "watch", "hold"]

function codeLabel(value: unknown, at: string) {
  const r = record(value, at)
  return { code: str(r, "code", at, 40), label: str(r, "label", at) }
}

export function parseMeta(value: unknown, at = "meta"): Meta {
  const r = record(value, at)
  const settings = record(r["settings"], `${at}.settings`)
  return {
    as_of: str(r, "as_of", at),
    settings: {
      margin_floor_pct: num(settings, "margin_floor_pct", `${at}.settings`),
      discount_escalation_pct: num(settings, "discount_escalation_pct", `${at}.settings`),
    },
    accounts: items(r, "accounts", at, 1000, (v, p) => {
      const a = record(v, p)
      const contact = a["contact"] === null ? null : record(a["contact"], `${p}.contact`)
      return {
        account_id: str(a, "account_id", p, 40),
        name: str(a, "name", p),
        industry: str(a, "industry", p),
        territory: str(a, "territory", p),
        contact:
          contact === null
            ? null
            : {
                name: str(contact, "name", `${p}.contact`),
                title: str(contact, "title", `${p}.contact`),
              },
        standing: oneOf(a, "standing", STANDINGS, p),
      }
    }),
    products: items(r, "products", at, 1000, (v, p) => {
      const pr = record(v, p)
      return {
        sku: str(pr, "sku", p, 40),
        name: str(pr, "name", p),
        uom: str(pr, "uom", p, 40),
        list_price_eur: num(pr, "list_price_eur", p),
        tiers: items(pr, "tiers", p, 50, (t, tp) => {
          const tr = record(t, tp)
          return { min_qty: num(tr, "min_qty", tp), unit_price_eur: num(tr, "unit_price_eur", tp) }
        }),
      }
    }),
    delivery_options: items(r, "delivery_options", at, 50, (v, p) => ({
      ...codeLabel(v, p),
      cost_eur: num(record(v, p), "cost_eur", p),
    })),
    regions: strings(r, "regions", at, 200),
    payment_terms: items(r, "payment_terms", at, 50, codeLabel),
    territories: strings(r, "territories", at, 200),
  }
}

export function parseQuarter(
  value: unknown,
  at = "quarter"
): { quarter: string; territories: QuarterRow[] } {
  const r = record(value, at)
  return {
    quarter: str(r, "quarter", at),
    territories: items(r, "territories", at, 1000, (v, p) => {
      const t = record(v, p)
      const n = (key: string) => num(t, key, p)
      return {
        territory: str(t, "territory", p),
        quarter: str(t, "quarter", p),
        budget_eur: n("budget_eur"),
        signed_eur: n("signed_eur"),
        pipeline_eur: n("pipeline_eur"),
        committed_eur: n("committed_eur"),
        headroom_eur: n("headroom_eur"),
        used_pct: n("used_pct"),
        covered_by_pipeline: bool(t, "covered_by_pipeline", p),
        quarter_end: str(t, "quarter_end", p),
        days_left: n("days_left"),
      }
    }),
  }
}

export function parseMembers(value: unknown, at = "body"): MemberOption[] {
  return items(record(value, at), "members", at, 100_000, (v, p) => {
    const m = record(v, p)
    return {
      user_id: str(m, "user_id", p),
      name: str(m, "name", p),
      email: strOrNull(m, "email", p, 320),
    }
  })
}
