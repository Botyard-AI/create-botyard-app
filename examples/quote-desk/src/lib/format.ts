import type { ApproverRole, QuoteStatus } from "../../shared/types.ts"

const money = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" })

export const eur = (n: number): string => money.format(n)

export const STATUS_LABEL: Readonly<Record<QuoteStatus, string>> = {
  draft: "Draft",
  finance_review: "Finance review",
  business_review: "Business review",
  approved: "Approved",
  sent: "Sent",
  signed: "Signed",
}

export const ROLE_LABEL: Readonly<Record<ApproverRole, string>> = {
  bot_review: "Reviewer bot",
  finance: "Finance",
  business: "Business",
}

/** "2026-11-17T14:30:06.000Z" → "17 Nov, 14:30" in the viewer's time zone. */
export function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
}
