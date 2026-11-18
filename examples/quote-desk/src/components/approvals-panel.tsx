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
 * The role, if the viewer may decide it now. The reviewer bot only advises:
 * finance approvers record its step.
 */
function myOpenRole(
  role: ApproverRole,
  quote: QuoteView,
  settings: SettingsView | null
): ApproverRole | null {
  if (settings === null || quote.approvals[role] !== null || !openRoles(quote).includes(role))
    return null
  const decidedBy = role === "bot_review" ? "finance" : role
  return settings.my_roles.includes(decidedBy) ? role : null
}

/** What a finance approver is told above the reviewer step's buttons. */
function reviewerHint(handoff: HandoffView | null): string {
  if (handoff?.kind === "answered")
    return `${handoff.reviewer} recommends ${handoff.decision === "approve" ? "approval" : "changes"}: confirm it, or decide otherwise.`
  if (handoff?.kind === "manual") return "No recommendation is coming: record this step yourself."
  return "Waiting for the reviewer bot's recommendation. You can also record this step now."
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
          const mine = myOpenRole(role, quote, settings)
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
                  <p className="text-muted-foreground mt-1 text-xs">{reviewerHint(handoff)}</p>
                ) : null}
                {mine === null ? null : (
                  <DecisionForm
                    quote={quote}
                    role={mine}
                    approveLabel={
                      mine === "bot_review" &&
                      handoff?.kind === "answered" &&
                      handoff.decision === "approve"
                        ? "Confirm reviewer bot's approval"
                        : "Approve"
                    }
                    onDecided={onChanged}
                  />
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}
