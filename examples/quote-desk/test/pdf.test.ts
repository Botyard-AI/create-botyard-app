import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { inflateSync } from "node:zlib"
import { PDFDocument } from "pdf-lib"
import { describe, expect, test } from "vitest"
import { printable, quoteSheet, renderPdf } from "../server/pdf.ts"
import { saveState } from "../server/quotes/store.ts"
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

  test("an unavailable delivery is to be confirmed, not free", async () => {
    const desk = memoryDesk()
    const input = { ...INPUT, region: "Metro", delivery_option: "PAL" }
    const { id } = desk.create(input, ADA, ADA.name)
    const quote = desk.get(id)
    expect(quote.pricing.delivery.kind).toBe("unavailable")
    const text = pdfText(await renderPdf("t", quoteSheet(quote, desk.erp, desk.crm)))
    expect(text).toContain("to be confirmed")
    expect(text).toContain("Total, excluding delivery")
    expect(text).not.toContain("EUR 0.00")
  })

  test("a delivery that really costs nothing is priced at zero", async () => {
    const { desk, quote } = reviewed()
    const { delivery } = quote.pricing
    if (delivery.kind !== "estimate") throw new Error("expected a delivery estimate")
    const free = {
      ...quote,
      pricing: {
        ...quote.pricing,
        delivery_cost_eur: 0,
        delivery: { ...delivery, delivery_cost_eur: 0 },
      },
    }
    const text = pdfText(await renderPdf("t", quoteSheet(free, desk.erp, desk.crm)))
    expect(text).toContain("EUR 0.00")
    expect(text).not.toContain("to be confirmed")
    expect(text).not.toContain("excluding delivery")
  })

  test("refuses a row kind it cannot lay out", async () => {
    const rows: unknown[] = [{ kind: "picture" }]
    // @ts-expect-error: a row kind the renderer does not know
    const render = () => renderPdf("t", rows)
    await expect(render()).rejects.toThrow(/no layout for row/)
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

test("npm run pdf writes a quote's PDF from the data directory, for the bot", () => {
  const { desk, quote } = reviewed()
  const dir = mkdtempSync(path.join(tmpdir(), "quote-pdf-"))
  try {
    saveState(path.join(dir, "state.json"), desk.state())
    const script = path.join(import.meta.dirname, "..", "scripts", "quote-pdf.ts")
    const env = { ...process.env, QUOTE_DESK_DATA_DIR: dir }
    const out = execFileSync(process.execPath, [script, quote.id], { env }).toString().trim()
    expect(out).toBe(path.join(dir, "pdf", `${quote.id}-draft.pdf`))
    expect(pdfText(readFileSync(out))).toContain(`Quotation ${quote.id}`)
    expect(() =>
      execFileSync(process.execPath, [script, "Q-1999-0001"], { env, stdio: "pipe" })
    ).toThrow(/No quote Q-1999-0001/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
