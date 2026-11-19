import { useEffect, useMemo, useState } from "react"
import type { Meta, Pricing, QuoteInput, QuoteView } from "../../../shared/types.ts"
import { preview } from "@/lib/quotes-api"

/** A line as typed: strings, so a half-typed number is not lost. */
export type DraftLine = { readonly sku: string; readonly qty: string; readonly unit: string }

export type Draft = {
  readonly ownerEmail: string | null
  readonly accountId: string
  readonly territory: string
  readonly region: string
  readonly deliveryOption: string
  readonly terms: string
  readonly lines: readonly DraftLine[]
  readonly discount: string
  readonly reason: string
}

export function initialDraft(meta: Meta, quote: QuoteView | null): Draft {
  if (quote !== null) {
    return {
      // Null keeps the quote's current owner; the builder offers to change it.
      ownerEmail: null,
      accountId: quote.account_id,
      territory: quote.territory,
      region: quote.region,
      deliveryOption: quote.delivery_option,
      terms: quote.terms,
      lines: quote.lines.map((l) => ({
        sku: l.sku,
        qty: String(l.qty),
        unit: l.unit_price_eur === null ? "" : String(l.unit_price_eur),
      })),
      discount: String(quote.order_discount_pct),
      reason: quote.order_discount_reason,
    }
  }
  const account = meta.accounts[0]
  return {
    ownerEmail: null,
    accountId: account?.account_id ?? "",
    territory: account?.territory ?? meta.territories[0] ?? "",
    region: meta.regions[0] ?? "",
    deliveryOption: meta.delivery_options[0]?.code ?? "",
    terms: meta.payment_terms[0]?.code ?? "",
    lines: [],
    discount: "0",
    reason: "",
  }
}

/** The API body for a draft, or a message saying what to fix first. */
export function toInput(d: Draft): QuoteInput | string {
  const lines = d.lines.map((l) => ({
    sku: l.sku,
    qty: Number(l.qty),
    unit_price_eur: l.unit.trim() === "" ? null : Number(l.unit),
  }))
  if (lines.some((l) => !Number.isInteger(l.qty) || l.qty < 1)) {
    return "Quantities must be whole numbers above zero."
  }
  if (
    lines.some(
      (l) => l.unit_price_eur !== null && (Number.isNaN(l.unit_price_eur) || l.unit_price_eur < 0)
    )
  ) {
    return "Unit prices must be numbers."
  }
  const discount = Number(d.discount)
  if (!Number.isFinite(discount) || discount < 0 || discount > 50) {
    return "The order discount must be between 0% and 50%."
  }
  return {
    owner_email: d.ownerEmail,
    account_id: d.accountId,
    territory: d.territory,
    region: d.region,
    delivery_option: d.deliveryOption,
    terms: d.terms,
    lines,
    order_discount_pct: discount,
    order_discount_reason: d.reason,
  }
}

export type LivePricing =
  | { readonly state: "empty" }
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly pricing: Pricing }

/** Prices the draft as it is typed (debounced), through POST /api/preview. */
export function useLivePricing(draft: Draft): LivePricing {
  const input = useMemo(() => toInput(draft), [draft])
  // The last answer from the server, kept with the input it priced. The other
  // states are worked out from the input below, not set from the effect.
  const [result, setResult] = useState<{
    readonly input: QuoteInput
    readonly live: LivePricing
  } | null>(null)
  useEffect(() => {
    if (typeof input === "string" || input.lines.length === 0) return undefined
    const controller = new AbortController()
    const timer = setTimeout(() => {
      preview(input, controller.signal)
        .then((pricing) => {
          setResult({ input, live: { state: "ready", pricing } })
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return
          const message = err instanceof Error ? err.message : String(err)
          setResult({ input, live: { state: "error", message } })
        })
    }, 200)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [input])
  if (typeof input === "string") return { state: "error", message: input }
  if (input.lines.length === 0) return { state: "empty" }
  if (result?.input === input) return result.live
  // Keep showing the last prices while the new ones load.
  return result?.live.state === "ready" ? result.live : { state: "loading" }
}
