import { CheckCircle2, CircleDashed, XCircle } from "lucide-react"
import { APPROVER_ROLES, type QuoteView } from "../../shared/types.ts"
import { Panel } from "@/components/ui/bits"
import { ROLE_LABEL } from "@/lib/format"

/** Who has decided, and who is next. */
export function ApprovalsPanel({ quote }: Readonly<{ quote: QuoteView }>) {
  return (
    <Panel title="Approvals">
      <ul className="divide-y">
        {APPROVER_ROLES.map((role) => {
          const a = quote.approvals[role]
          const next = quote.progress.next === role
          let icon = <CircleDashed className="text-muted-foreground size-4" aria-hidden />
          if (a?.decision === "approve")
            icon = <CheckCircle2 className="size-4 text-emerald-600" aria-hidden />
          else if (a?.decision === "reject")
            icon = <XCircle className="text-destructive size-4" aria-hidden />
          let status = "Not yet"
          if (a !== null)
            status = `${a.decision === "approve" ? "Approved" : "Changes requested"} by ${a.by}`
          else if (next) status = "Waiting"
          return (
            <li key={role} className="flex items-start gap-3 px-4 py-3 text-sm">
              <span className="mt-0.5">{icon}</span>
              <div className="min-w-0">
                <p className="font-medium">{ROLE_LABEL[role]}</p>
                <p className="text-muted-foreground">{status}</p>
                {a !== null && a.note !== "" ? (
                  <p className="mt-1 whitespace-pre-wrap">{a.note}</p>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}
