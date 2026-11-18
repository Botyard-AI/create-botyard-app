import { inflateSync } from "node:zlib"
import { PDFDocument } from "pdf-lib"
import { describe, expect, test } from "vitest"
import { printable, quoteSheet, renderPdf } from "../server/pdf.ts"
import type { QuoteInput } from "../shared/types.ts"
import { asViewer, memoryDesk, startApp } from "./helpers.ts"

const ADA = { name: "Ada Lovelace", email: "ada@example.com" }
const NOTE = "SECRET-APPROVAL-NOTE margin is thin"
const INPUT: QuoteInput = {
  owner_email: null,
  account_id: "ACC-1001",
  territory: "Scranton",
  region: "Northeast",
  delivery_option: "STD",
  terms: "NET45",
  lines: [{ sku: "PPR-A4-80", qty: 100, unit_price_eur: null }],
  order_discount_pct: 3,
  order_discount_reason: "INTERNAL-REASON multi-year contract",
}

/** The text a PDF draws: its content streams inflated, and each `<hex> Tj` decoded. */
function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes)
  const out: string[] = []
  let at = 0
  for (;;) {
    const start = raw.indexOf("stream\n", at)
    if (start === -1) break
    const end = raw.indexOf("\nendstream", start)
    if (end === -1) break
    const body = raw.subarray(start + "stream\n".length, end)
    at = end + "\nendstream".length
    let text: string
    try {
      text = inflateSync(body).toString("latin1")
    } catch {
      text = body.toString("latin1")
    }
    for (const m of text.matchAll(/<([0-9A-Fa-f]+)> Tj/g))
      out.push(Buffer.from(m[1] ?? "", "hex").toString("latin1"))
  }
  return out.join("\n")
}

/** A quote approved by finance with a note, now in business review. */
function reviewed() {
  const desk = memoryDesk()
  const { id } = desk.create(INPUT, ADA, ADA.name)
  desk.submit(id, ADA.name)
  desk.decide(id, "bot_review", "approve", NOTE, "Grace")
  desk.decide(id, "finance", "approve", NOTE, "Grace")
  return { desk, quote: desk.get(id) }
}

describe("the quotation PDF", () => {
  test("shows the customer's numbers and nothing internal", async () => {
    const { desk, quote } = reviewed()
    const text = pdfText(await renderPdf("t", quoteSheet(quote, desk.erp, desk.crm)))
    expect(text).toContain(`Quotation ${quote.id} (DRAFT, not an offer)`)
    expect(text).toContain("Total")
    expect(text).toContain(
      `EUR ${quote.pricing.total_eur.toLocaleString("en-GB", { minimumFractionDigits: 2 })}`
    )
    expect(text).toContain("Order discount (3%)")
    for (const internal of [/margin/i, /cost/i, /SECRET/, /INTERNAL/, /credit/i, /floor/i])
      expect(text).not.toMatch(internal)
  })

  test("an approved quote is a quotation, valid until its sign-by date", async () => {
    const { desk, quote } = reviewed()
    const approved = desk.decide(quote.id, "business", "approve", NOTE, "Ada")
    const text = pdfText(await renderPdf("t", quoteSheet(approved, desk.erp, desk.crm)))
    expect(text).toContain(`Quotation ${quote.id}\n`)
    expect(text).not.toContain("DRAFT")
    expect(text).toContain(`Valid until: ${approved.status === "draft" ? "" : approved.sign_by}`)
  })

  test("is a valid one-page PDF", async () => {
    const { desk, quote } = reviewed()
    const doc = await PDFDocument.load(await renderPdf("t", quoteSheet(quote, desk.erp, desk.crm)))
    expect(doc.getPageCount()).toBe(1)
  })

  test("is served to members only", async () => {
    const { desk, quote } = reviewed()
    const base = await startApp({ desk })
    const res = await fetch(`${base}/api/quotes/${quote.id}/pdf`, asViewer("grace@example.com"))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/pdf")
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="${quote.id}-draft.pdf"`
    )
    expect(
      Buffer.from(await res.arrayBuffer())
        .subarray(0, 5)
        .toString()
    ).toBe("%PDF-")
    const stranger = await fetch(
      `${base}/api/quotes/${quote.id}/pdf`,
      asViewer("mallory@example.com")
    )
    expect(stranger.status).toBe(403)
    const unknown = await fetch(`${base}/api/quotes/Q-1999-0001/pdf`, asViewer("grace@example.com"))
    expect(unknown.status).toBe(404)
  })
})

test("printable keeps what Helvetica can draw", () => {
  expect(printable("Café €5 – ok")).toBe("Café €5 – ok")
  expect(printable("名前 😀\u0000")).toBe("?? ??")
})
