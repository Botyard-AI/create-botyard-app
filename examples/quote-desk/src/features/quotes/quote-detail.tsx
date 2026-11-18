import { FileDown, FileSignature, Mail, Pencil } from "lucide-react"
import { useState } from "react"
import type { HandoffView, QuoteView, SettingsView } from "../../../shared/types.ts"
import { ApprovalsPanel } from "@/components/approvals-panel"
import { CommentBox } from "@/components/comment-box"
import { HandoffPanel } from "@/components/handoff-panel"
import { PricingSummary } from "@/components/pricing-summary"
import { QuoteHistory } from "@/components/quote-history"
import { StatusBadge } from "@/components/status-badge"
import { Notice, Panel } from "@/components/ui/bits"
import { Button, buttonVariants } from "@/components/ui/button"
import { eur } from "@/lib/format"
import { act, type QuoteAction } from "@/lib/quotes-api"

const tone = { muted: "muted", info: "muted", warning: "warn", success: "ok" } as const

type Props = Readonly<{
  quote: QuoteView
  settings: SettingsView | null
  /** The reviewer bot's part; null until read. */
  handoff: HandoffView | null
  /** For how long a handoff has waited. */
  now: Date
  onChanged: (quote: QuoteView) => void
  onEdit: (id: string) => void
}>

/** One quote: where it stands, its numbers, approvals and history. */
export function QuoteDetail({ quote, settings, handoff, now, onChanged, onEdit }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(action: QuoteAction) {
    setBusy(true)
    setError(null)
    try {
      onChanged(await act(quote.id, action))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-mono text-2xl font-semibold">{quote.id}</h1>
            <StatusBadge status={quote.status} />
          </div>
          <p className="text-muted-foreground text-sm">
            {quote.account} · {quote.territory} · owner {quote.owner.name} · terms {quote.terms}
            {quote.status === "draft" ? "" : ` · sign by ${quote.sign_by}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            className={buttonVariants({ variant: "outline" })}
            href={`/api/quotes/${quote.id}/pdf`}
            download
          >
            <FileDown /> PDF
          </a>
          {quote.status === "draft" ? (
            <Button
              variant="outline"
              onClick={() => {
                onEdit(quote.id)
              }}
            >
              <Pencil /> Edit draft
            </Button>
          ) : null}
          {quote.status === "draft" ? (
            <Button disabled={busy} onClick={() => void run("submit")}>
              Submit for approval
            </Button>
          ) : null}
          {quote.status === "approved" ? (
            <Button disabled={busy} onClick={() => void run("send")}>
              <Mail /> Record send (demo)
            </Button>
          ) : null}
          {quote.status === "sent" ? (
            <Button disabled={busy} onClick={() => void run("sign")}>
              <FileSignature /> Mark signed (mock)
            </Button>
          ) : null}
        </div>
      </div>
      <Notice tone={tone[quote.progress.tone]} role="status">
        <p className="font-medium">{quote.progress.label}</p>
        {quote.progress.detail === "" ? null : (
          <p className="whitespace-pre-wrap">{quote.progress.detail}</p>
        )}
      </Notice>
      {handoff === null ? null : <HandoffPanel handoff={handoff} now={now} />}
      {error === null ? null : (
        <Notice tone="error" role="alert">
          {error}
        </Notice>
      )}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid content-start gap-4">
          <Panel title={quote.status === "draft" ? "Pricing (live)" : "Pricing (frozen at submit)"}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm tabular-nums">
                <thead>
                  <tr className="text-muted-foreground border-b text-xs uppercase">
                    <th className="px-4 py-2 text-left font-medium">Item</th>
                    <th className="px-2 py-2 text-right font-medium">Qty</th>
                    <th className="px-2 py-2 text-right font-medium">Unit</th>
                    <th className="px-4 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {quote.pricing.lines.map((l) => (
                    <tr key={l.sku} className="border-b last:border-0">
                      <td className="px-4 py-2">{l.name}</td>
                      <td className="px-2 py-2 text-right">{l.qty}</td>
                      <td className="px-2 py-2 text-right">{eur(l.unit_price_eur)}</td>
                      <td className="px-4 py-2 text-right">{eur(l.revenue_eur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t p-4">
              <PricingSummary p={quote.pricing} />
            </div>
          </Panel>
          {quote.status !== "sent" && quote.status !== "signed" ? null : (
            <Panel title="Email to the customer (recorded, not delivered)">
              <div className="grid gap-1 p-4 text-sm">
                <p>
                  To {quote.email.to} · {quote.email.subject}
                </p>
                <p className="text-muted-foreground whitespace-pre-wrap">{quote.email.body}</p>
              </div>
            </Panel>
          )}
        </div>
        <div className="grid content-start gap-4">
          <ApprovalsPanel
            quote={quote}
            settings={settings}
            handoff={handoff}
            onChanged={onChanged}
          />
          <Panel title="History">
            <div className="grid gap-4 p-4">
              <QuoteHistory events={quote.events} />
              <CommentBox quote={quote} onAdded={onChanged} />
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}
