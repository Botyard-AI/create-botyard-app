import { Building2 } from "lucide-react"
import type { Meta } from "../../../shared/types.ts"
import { Panel } from "@/components/ui/bits"
import { cn } from "@/lib/utils"

export function CustomerSection({
  meta,
  accountId,
  onPick,
}: Readonly<{ meta: Meta; accountId: string; onPick: (accountId: string) => void }>) {
  const contact = meta.accounts.find((a) => a.account_id === accountId)?.contact ?? null
  return (
    <Panel title="1 · Customer">
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        {meta.accounts.map((a) => (
          <button
            key={a.account_id}
            type="button"
            aria-pressed={a.account_id === accountId}
            onClick={() => {
              onPick(a.account_id)
            }}
            className={cn(
              "hover:bg-muted flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
              a.account_id === accountId && "border-primary ring-primary/20 ring-2"
            )}
          >
            <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-md">
              <Building2 className="size-4" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{a.name}</span>
              <span className="text-muted-foreground block truncate text-xs">
                {a.industry} · {a.territory}
              </span>
              {a.standing === "good" ? null : (
                <span className="mt-1 inline-block rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-900 uppercase">
                  {a.standing}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
      {contact === null ? null : (
        <p className="text-muted-foreground border-t px-4 py-2 text-xs">
          Contact: {contact.name}, {contact.title}
        </p>
      )}
    </Panel>
  )
}
