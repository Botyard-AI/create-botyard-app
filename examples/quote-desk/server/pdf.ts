// The quotation PDF: GET /api/quotes/:id/pdf, for org members. It is the
// customer's document, so it holds only what the customer may see: the lines,
// prices, delivery, terms and totals. Never cost, margin, flags, credit or
// approval notes. `quoteSheet` decides the text; `renderPdf` only lays it out.
import { requireMember } from "@botyard/botpage/node"
import type { BotPage } from "@botyard/botpage"
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import { DOWNLOADS } from "../shared/api.ts"
import type { Crm, Erp, QuoteView } from "../shared/types.ts"
import { HttpError, type Route } from "./http.ts"
import type { QuoteDesk } from "./quotes/desk.ts"

const FINAL = ["approved", "sent", "signed"]

/** One row of the document. */
export type Row =
  | { readonly kind: "title" | "heading" | "text" | "note"; readonly text: string }
  | { readonly kind: "line"; readonly cells: readonly [string, string, string, string] }
  | {
      readonly kind: "total"
      readonly label: string
      readonly amount: string
      readonly bold?: boolean
    }
  | { readonly kind: "gap" }

const money = (n: number) =>
  `EUR ${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** The document's text, from what the app knows about the quote. */
export function quoteSheet(q: QuoteView, erp: Erp, crm: Crm): Row[] {
  const p = q.pricing
  const final = FINAL.includes(q.status)
  const contact = crm.accounts.find((a) => a.account_id === q.account_id)?.contacts[0]
  const terms = erp.payment_terms.find((t) => t.code === q.terms)?.label ?? q.terms
  const option = erp.delivery_options.find((o) => o.code === q.delivery_option)?.label
  const rows: Row[] = [
    {
      kind: "title",
      text: final ? `Quotation ${q.id}` : `Quotation ${q.id} (DRAFT, not an offer)`,
    },
    { kind: "note", text: "Dunder Mifflin Paper Company. Fictional demo data." },
    { kind: "gap" },
    { kind: "heading", text: "For" },
    { kind: "text", text: q.account },
  ]
  if (contact !== undefined) rows.push({ kind: "text", text: `${contact.name}, ${contact.title}` })
  rows.push(
    { kind: "text", text: `Prepared by ${q.owner.name}` },
    { kind: "gap" },
    { kind: "line", cells: ["Item", "Qty", "Unit price", "Amount"] },
    ...p.lines.map((l): Row => ({
      kind: "line",
      cells: [l.name, String(l.qty), money(l.unit_price_eur), money(l.revenue_eur)],
    })),
    { kind: "gap" },
    { kind: "total", label: "Subtotal", amount: money(p.subtotal_eur) }
  )
  if (p.order_discount_eur > 0) {
    const pct = String(p.order_discount_pct)
    rows.push({
      kind: "total",
      label: `Order discount (${pct}%)`,
      amount: `-${money(p.order_discount_eur)}`,
    })
  }
  const deliveryLabel = option === undefined ? "Delivery" : `Delivery (${option})`
  // An unavailable delivery is priced at zero by the engine: a placeholder, not
  // a fee. Say it is to be confirmed, and that the total leaves it out.
  const delivered = p.delivery.kind === "estimate"
  rows.push(
    {
      kind: "total",
      label: deliveryLabel,
      amount: delivered ? money(p.delivery_cost_eur) : "to be confirmed",
    },
    {
      kind: "total",
      label: delivered ? "Total" : "Total, excluding delivery",
      amount: money(p.total_eur),
      bold: true,
    },
    { kind: "gap" },
    { kind: "heading", text: "Terms" },
    { kind: "text", text: `Payment: ${terms}` }
  )
  if (p.delivery.kind === "estimate")
    rows.push({ kind: "text", text: `Earliest delivery: ${p.delivery.earliest_delivery}` })
  if (q.status !== "draft") rows.push({ kind: "text", text: `Valid until: ${q.sign_by}` })
  return rows
}

/** WinAnsi characters past Latin-1 that Helvetica can draw. */
const EXTRA = new Set(["€", "–", "—", "‘", "’", "“", "”", "•", "…"])

/** Helvetica covers Latin-1 and a few more; anything else becomes "?". */
export function printable(s: string): string {
  return [...s]
    .map((c) => {
      const code = c.codePointAt(0) ?? 0
      const latin1 = (code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff)
      return latin1 || EXTRA.has(c) ? c : "?"
    })
    .join("")
}

/** Lays the rows out on A4 pages. */
export async function renderPdf(title: string, rows: readonly Row[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(printable(title))
  doc.setProducer("Quote desk (create-botyard-app example)")
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const left = 56
  const right = 539
  let page: PDFPage = doc.addPage([595, 842])
  let y = 786
  const text = (s: string, x: number, size: number, font: PDFFont, alignRight = false) => {
    const t = printable(s)
    const at = alignRight ? x - font.widthOfTextAtSize(t, size) : x
    page.drawText(t, { x: at, y, size, font, color: rgb(0.08, 0.13, 0.24) })
  }
  for (const row of rows) {
    if (y < 72) {
      page = doc.addPage([595, 842])
      y = 786
    }
    switch (row.kind) {
      case "title":
        text(row.text, left, 18, bold)
        y -= 26
        break
      case "heading":
        text(row.text, left, 11, bold)
        y -= 16
        break
      case "text":
        text(row.text, left, 10, regular)
        y -= 14
        break
      case "note":
        text(row.text, left, 8, regular)
        y -= 12
        break
      case "line": {
        const header = row.cells[0] === "Item"
        const font = header ? bold : regular
        text(row.cells[0].slice(0, 60), left, 9, font)
        text(row.cells[1], 360, 9, font, true)
        text(row.cells[2], 450, 9, font, true)
        text(row.cells[3], right, 9, font, true)
        y -= 14
        break
      }
      case "total":
        text(row.label, 360, 10, row.bold === true ? bold : regular)
        text(row.amount, right, 10, row.bold === true ? bold : regular, true)
        y -= 14
        break
      case "gap":
        y -= 10
        break
      default:
        // A new row kind must be drawn here, or customer text would vanish.
        unreachable(row)
    }
  }
  return doc.save()
}

/** The quote's PDF, as the route serves it and `npm run pdf` writes it. */
export function quotePdf(desk: QuoteDesk, quote: QuoteView): Promise<Uint8Array> {
  return renderPdf(`Quotation ${quote.id}`, quoteSheet(quote, desk.erp, desk.crm))
}

/** "Q-2026-0201.pdf", or "Q-2026-0201-draft.pdf" before approval. */
export function pdfName(quote: QuoteView): string {
  return `${quote.id}${FINAL.includes(quote.status) ? "" : "-draft"}.pdf`
}

function unreachable(row: never): never {
  throw new Error(`renderPdf: no layout for row ${JSON.stringify(row)}`)
}

/** GET /api/quotes/:id/pdf: the quotation, for org members. */
export function pdfRoute(botpage: BotPage, desk: QuoteDesk): Route {
  return {
    method: "GET",
    path: DOWNLOADS.quotePdf,
    handler: (req, res, params) =>
      requireMember(botpage, async (_rq, rs) => {
        const id = params["id"]
        if (id === undefined) throw new HttpError(404, "not found")
        const quote = desk.get(id)
        const bytes = await quotePdf(desk, quote)
        rs.writeHead(200, {
          "content-type": "application/pdf",
          "content-length": bytes.length,
          "content-disposition": `attachment; filename="${pdfName(quote)}"`,
          "cache-control": "no-store",
        })
        rs.end(Buffer.from(bytes))
      })(req, res),
  }
}
