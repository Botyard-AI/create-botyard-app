import { Save, Send, X } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import type { MemberOption, Meta, QuoteView } from "../../../shared/types.ts"
import { PricingSummary } from "@/components/pricing-summary"
import { Notice, Panel } from "@/components/ui/bits"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/form"
import { act, getMembers, saveQuote } from "@/lib/quotes-api"
import { CustomerSection } from "./customer-section"
import { ProductsSection } from "./products-section"
import { TermsSection } from "./terms-section"
import { initialDraft, toInput, useLivePricing, type Draft } from "./use-draft"

type Props = Readonly<{
  meta: Meta
  /** The signed-in viewer's email, to mark "(you)" in the owner list. */
  viewerEmail: string | null
  /** The draft being edited, or null for a new quote. */
  editing: QuoteView | null
  onSaved: (id: string, submitted: boolean) => void
  onCancel: () => void
}>

/** The quote builder: pick a customer and products, see the price and the flags live. */
export function BuildQuote({ meta, viewerEmail, editing, onSaved, onCancel }: Props) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(meta, editing))
  const [members, setMembers] = useState<readonly MemberOption[]>([])
  const [busy, setBusy] = useState<"save" | "submit" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const live = useLivePricing(draft)
  // The empty choice is "you" for a new quote and "keep the owner" for a draft.
  const keepEmail = editing === null ? viewerEmail : editing.owner.email
  const keepLabel = editing === null ? "You" : `${editing.owner.name} (owner)`

  useEffect(() => {
    const controller = new AbortController()
    getMembers(controller.signal)
      .then(setMembers)
      .catch(() => {
        // Without the list the owner stays "you", which the server fills in.
      })
    return () => {
      controller.abort()
    }
  }, [])

  const patch = useCallback((p: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...p }))
  }, [])

  const pickAccount = (accountId: string) => {
    const territory = meta.accounts.find((a) => a.account_id === accountId)?.territory
    patch({
      accountId,
      ...(territory !== undefined && meta.territories.includes(territory) && { territory }),
    })
  }

  async function save(submit: boolean) {
    const input = toInput(draft)
    if (typeof input === "string" || input.lines.length === 0) {
      setError(typeof input === "string" ? input : "Add at least one product.")
      return
    }
    setBusy(submit ? "submit" : "save")
    setError(null)
    try {
      const q = await saveQuote(editing?.id ?? null, input)
      if (submit) await act(q.id, "submit")
      onSaved(q.id, submit)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="grid min-w-0 content-start gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-muted-foreground text-xs font-medium uppercase">
              {editing === null ? "New quote" : "Editing draft"}
            </p>
            <h1 className="text-2xl font-semibold">{editing?.id ?? "Build a quote"}</h1>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="owner" className="text-muted-foreground text-xs">
              Owner
            </label>
            <Select
              id="owner"
              className="w-56"
              value={draft.ownerEmail ?? ""}
              onChange={(e) => {
                patch({ ownerEmail: e.target.value === "" ? null : e.target.value })
              }}
            >
              <option value="">{keepLabel}</option>
              {members
                .filter((m) => m.email !== null && m.email !== keepEmail)
                .map((m) => (
                  <option key={m.user_id} value={m.email ?? ""}>
                    {m.email === viewerEmail ? `${m.name} (you)` : m.name}
                  </option>
                ))}
            </Select>
            {editing === null ? null : (
              <Button variant="ghost" size="icon" aria-label="Stop editing" onClick={onCancel}>
                <X />
              </Button>
            )}
          </div>
        </div>
        <CustomerSection meta={meta} accountId={draft.accountId} onPick={pickAccount} />
        <ProductsSection
          meta={meta}
          lines={draft.lines}
          pricing={live.state === "ready" ? live.pricing : null}
          onChange={(lines) => {
            patch({ lines })
          }}
        />
        <TermsSection
          meta={meta}
          draft={draft}
          usualTerritory={
            meta.accounts.find((a) => a.account_id === draft.accountId)?.territory ?? null
          }
          onChange={patch}
        />
      </div>
      <div className="grid content-start gap-3 lg:sticky lg:top-20">
        <Panel title="Live pricing">
          <div className="p-4" aria-live="polite">
            {live.state === "empty" ? (
              <p className="text-muted-foreground text-sm">
                Add products to see the price, margin and delivery.
              </p>
            ) : null}
            {live.state === "loading" ? (
              <p className="text-muted-foreground text-sm">Pricing…</p>
            ) : null}
            {live.state === "error" ? <Notice tone="error">{live.message}</Notice> : null}
            {live.state === "ready" ? <PricingSummary p={live.pricing} /> : null}
          </div>
        </Panel>
        {error === null ? null : (
          <Notice tone="error" role="alert">
            {error}
          </Notice>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" disabled={busy !== null} onClick={() => void save(false)}>
            <Save /> Save draft
          </Button>
          <Button
            disabled={busy !== null || draft.lines.length === 0}
            onClick={() => void save(true)}
          >
            <Send /> Submit
          </Button>
        </div>
        <p className="text-muted-foreground text-center text-xs">
          Submitting freezes the numbers and sends the quote to finance review.
        </p>
      </div>
    </div>
  )
}
