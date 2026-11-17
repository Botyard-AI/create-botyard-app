import type { QuoteStatus } from "../../shared/types.ts"
import { STATUS_LABEL } from "@/lib/format"
import { cn } from "@/lib/utils"

const colour: Readonly<Record<QuoteStatus, string>> = {
  draft: "bg-muted text-muted-foreground",
  finance_review: "bg-amber-100 text-amber-900",
  business_review: "bg-sky-100 text-sky-900",
  approved: "bg-emerald-100 text-emerald-900",
  sent: "bg-indigo-100 text-indigo-900",
  signed: "bg-emerald-600 text-white",
}

export function StatusBadge({ status }: Readonly<{ status: QuoteStatus }>) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        colour[status]
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  )
}
