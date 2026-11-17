// Narrowing the server's own state file. Request bodies and API responses are
// parsed in shared/parse.ts, which the UI uses too.
import { ParseError, items, num, record } from "../../shared/narrow.ts"
import { parseQuoteInput, parseQuoteRecord } from "../../shared/parse.ts"

export { ParseError, parseQuoteInput }

/** The desk's state file. Refuses anything it cannot read in full. */
export function parseDeskState(value: unknown) {
  const r = record(value, "state")
  if (r["version"] !== 1) throw new ParseError("state.version: must be 1")
  const counter = num(r, "counter", "state")
  if (!Number.isInteger(counter) || counter < 0) {
    throw new ParseError("state.counter: must be a whole number")
  }
  return { counter, quotes: items(r, "quotes", "state", 100_000, parseQuoteRecord) }
}
