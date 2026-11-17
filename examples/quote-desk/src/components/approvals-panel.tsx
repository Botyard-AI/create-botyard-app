import { CheckCircle2, CircleDashed, XCircle } from "lucide-react"
import {
  APPROVER_ROLES,
  STAGE_ROLES,
  type ApproverRole,
  type HandoffView,
  type QuoteView,
  type SettingsView,
} from "../../shared/types.ts"
import { DecisionForm } from "@/components/decision-form"
import { Panel } from "@/components/ui/bits"
import { ROLE_LABEL } from "@/lib/format"

type Props = Readonly<{
  quote: QuoteView
  /** Null while loading, or when it could not be read: then nobody gets buttons. */
  settings: SettingsView | null
  /** Where the reviewer bot's part stands; null when unknown. */
  handoff: HandoffView | null
  onChanged: (quote: QuoteView) => void
}>

/** The roles deciding at the quote's status right now. */
function openRoles(quote: QuoteView): readonly ApproverRole[] {
  return quote.status === "finance_review" || quote.status === "business_review"
    ? STAGE_ROLES[quote.status]
    : []
}

/** Who fills a role, as configured. */
function filledBy(role: ApproverRole, settings: SettingsView | null): string {
  if (settings === null) return ""
  if (role === "bot_review") return settings.settings.reviewer_bot ?? "No reviewer bot set"
  const ids = settings.settings.approvers[role]
  if (ids.length === 0) return "No approvers set"
  return ids
    .map(
      (id) => settings.people.find((p) => p.user_id === id)?.name ?? "someone no longer in the org"
    )
    .join(", ")
}

/**
 * The role, if the viewer may decide it now. The reviewer bot's role is only
 * decided here once its handoff has gone manual, and then by finance.
 */
function myOpenRole(
  role: ApproverRole,
  quote: QuoteView,
  settings: SettingsView | null,
  handoff: HandoffView | null
): ApproverRole | null {
  if (settings === null || quote.approvals[role] !== null || !openRoles(quote).includes(role))
    return null
  if (role === "bot_review")
    return handoff?.kind === "manual" && settings.my_roles.includes("finance") ? role : null
  return settings.my_roles.includes(role) ? role : null
}

/** Who has decided, who is next, and the decision buttons for the viewer's roles. */
export function ApprovalsPanel({ quote, settings, handoff, onChanged }: Props) {
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
          const mine = myOpenRole(role, quote, settings, handoff)
          return (
            <li key={role} className="flex items-start gap-3 px-4 py-3 text-sm">
              <span className="mt-0.5">{icon}</span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{ROLE_LABEL[role]}</p>
                <p className="text-muted-foreground truncate text-xs">{filledBy(role, settings)}</p>
                <p className="text-muted-foreground">{status}</p>
                {a !== null && a.note !== "" ? (
                  <p className="mt-1 whitespace-pre-wrap">{a.note}</p>
                ) : null}
                {mine === "bot_review" ? (
                  <p className="text-muted-foreground mt-1 text-xs">
                    The reviewer bot isn&apos;t handling this quote: record its review for it.
                  </p>
                ) : null}
                {mine === null ? null : (
                  <DecisionForm quote={quote} role={mine} onDecided={onChanged} />
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}
