// Narrowing untrusted input on the server: request bodies and the state file.
import type { QuoteInput } from "../../shared/types.ts"
import { ParseError, items, num, record, str, strOrNull } from "../../shared/narrow.ts"
import { MAX_LINES, parseLine, parseQuoteRecord } from "../../shared/parse.ts"
import type { DeskState } from "./desk.ts"

export { ParseError }

/** The builder's body for POST /api/quotes, PUT /api/quotes/:id and POST /api/preview. */
export function parseQuoteInput(value: unknown): QuoteInput {
  const r = record(value, "body")
  const lines = items(r, "lines", "body", MAX_LINES, parseLine)
  const skus = new Set(lines.map((l) => l.sku))
  if (skus.size !== lines.length) throw new ParseError("body.lines: each product may appear once")
  return {
    owner_email: strOrNull(r, "owner_email", "body", 320),
    account_id: str(r, "account_id", "body", 40),
    territory: str(r, "territory", "body", 80),
    region: str(r, "region", "body", 80),
    delivery_option: str(r, "delivery_option", "body", 40),
    terms: str(r, "terms", "body", 40),
    lines,
    order_discount_pct:
      r["order_discount_pct"] === undefined ? 0 : num(r, "order_discount_pct", "body"),
    order_discount_reason:
      r["order_discount_reason"] === undefined ? "" : str(r, "order_discount_reason", "body"),
  }
}

/** The desk's state file. Refuses anything it cannot read in full. */
export function parseDeskState(value: unknown): DeskState {
  const r = record(value, "state")
  if (r["version"] !== 1) throw new ParseError("state.version: must be 1")
  const counter = num(r, "counter", "state")
  if (!Number.isInteger(counter) || counter < 0) {
    throw new ParseError("state.counter: must be a whole number")
  }
  return { counter, quotes: items(r, "quotes", "state", 100_000, parseQuoteRecord) }
}
