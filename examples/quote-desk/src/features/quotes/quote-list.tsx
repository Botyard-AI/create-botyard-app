import type { QuoteSummary } from "../../../shared/types.ts"
import { StatusBadge } from "@/components/status-badge"
import { eur } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Every quote, newest first; the selected one highlighted. */
export function QuoteList({
  quotes,
  selected,
  onSelect,
}: Readonly<{
  quotes: readonly QuoteSummary[]
  selected: string | null
  onSelect: (id: string) => void
}>) {
  if (quotes.length === 0) {
    return <p className="text-muted-foreground p-4 text-sm">No quotes yet. Build one first.</p>
  }
  return (
    <ul className="divide-y">
      {quotes.map((q) => (
        <li key={q.id}>
          <a
            href={`/quotes/${q.id}`}
            aria-current={q.id === selected ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault()
              onSelect(q.id)
            }}
            className={cn("hover:bg-muted grid gap-1 px-4 py-3", q.id === selected && "bg-muted")}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="font-mono text-sm font-medium">{q.id}</span>
              <StatusBadge status={q.status} />
            </span>
            <span className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate">{q.account}</span>
              <span className="tabular-nums">{eur(q.total_eur)}</span>
            </span>
            <span className="text-muted-foreground truncate text-xs">
              {q.owner.name} · {q.progress.label}
            </span>
          </a>
        </li>
      ))}
    </ul>
  )
}
