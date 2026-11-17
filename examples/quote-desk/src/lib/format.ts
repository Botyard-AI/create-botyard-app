import type { ApproverRole, QuoteStatus } from "../../shared/types.ts"

export { eur } from "../../shared/money.ts"

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

/** How long since `iso`, roughly: "under a minute", "12 min", "3 h 5 min", "2 days". */
export function age(iso: string, now: Date): string {
  const ms = now.getTime() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return "a while"
  const min = Math.floor(ms / 60_000)
  if (min < 1) return "under a minute"
  if (min < 60) return `${String(min)} min`
  const h = Math.floor(min / 60)
  if (h < 24) return min % 60 === 0 ? `${String(h)} h` : `${String(h)} h ${String(min % 60)} min`
  const d = Math.floor(h / 24)
  return d === 1 ? "1 day" : `${String(d)} days`
}
