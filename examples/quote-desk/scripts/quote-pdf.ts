// Writes a quote's PDF for the bot that runs the app: `npm run pdf -- Q-2026-0201`.
// The bot then sends the file on, for example to the quote's owner with
// send_files. The HTTP route stays members-only: this reads the app's own data
// directory, which only the bot that runs the app can, and changes nothing.
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { appRoot } from "../server/config.ts"
import { pdfName, quotePdf } from "../server/pdf.ts"
import { CRM_SEED } from "../server/quotes/crm-seed.ts"
import { QuoteDesk } from "../server/quotes/desk.ts"
import { ERP_SEED } from "../server/quotes/erp-seed.ts"
import { loadState } from "../server/quotes/store.ts"

const id = process.argv[2]
if (id === undefined || id === "") {
  process.stderr.write("Usage: npm run pdf -- <quote id>\n")
  process.exit(1)
}
const dataDir = process.env["QUOTE_DESK_DATA_DIR"] ?? path.join(appRoot, "data")
const state = loadState(path.join(dataDir, "state.json"))
if (state === null) {
  process.stderr.write(`No quotes in ${dataDir}: start the app first.\n`)
  process.exit(1)
}
// No save: this only reads.
const desk = new QuoteDesk({ erp: ERP_SEED, crm: CRM_SEED, state })
const quote = desk.list().some((q) => q.id === id) ? desk.get(id) : null
if (quote === null) {
  process.stderr.write(`No quote ${id}.\n`)
  process.exit(1)
}
const out = path.join(dataDir, "pdf", pdfName(quote))
mkdirSync(path.dirname(out), { recursive: true })
writeFileSync(out, await quotePdf(desk, quote))
process.stdout.write(`${out}\n`)
