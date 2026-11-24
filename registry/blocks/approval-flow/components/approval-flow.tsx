// Ask a member to approve something, and decide what others ask of you.
//
//   <ApprovalFlow />
//
// Needs the routes in server/approvals.ts and GET /api/members from the
// member-picker block (installed with this one).
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { MemberPicker } from "@/components/member-picker"
import type { ApprovalRequest, ApprovalStatus, Decision } from "@/lib/approvals-contract"
import { LIMITS } from "@/lib/approvals-contract"
import { decideApproval, errorMessage, requestApproval, useApprovals } from "@/lib/approvals"
import { useOrgMembers } from "@/lib/org-members"

const field = "border-input bg-background rounded-md border px-3 py-2 text-sm"
const button =
  "bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"
const secondaryButton =
  "bg-secondary text-secondary-foreground rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"

export function ApprovalFlow() {
  const { state, reload } = useApprovals()
  return (
    <div className="grid gap-6">
      <RequestApprovalForm onRequested={reload} />
      {state.status === "loading" && (
        <p className="text-muted-foreground animate-pulse text-sm" aria-busy="true">
          Loading requests…
        </p>
      )}
      {state.status === "error" && (
        <p className="text-destructive text-sm" role="alert">
          Could not load requests: {state.message}
        </p>
      )}
      {state.status === "ready" && (
        <ApprovalList
          requests={state.approvals.requests}
          me={state.approvals.me}
          onDecided={reload}
        />
      )}
    </div>
  )
}

/** Title, details and an approver; sends POST /api/approvals. */
export function RequestApprovalForm({ onRequested }: { readonly onRequested: () => void }) {
  const members = useOrgMembers()
  const [title, setTitle] = useState("")
  const [details, setDetails] = useState("")
  const [approverId, setApproverId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(): Promise<void> {
    if (approverId === null) return
    setBusy(true)
    setError(null)
    try {
      await requestApproval({ title, details, approverId })
      setTitle("")
      setDetails("")
      setApproverId(null)
      onRequested()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ask for approval</CardTitle>
        <CardDescription>The approver sees it here and approves or rejects it.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <input
            className={field}
            aria-label="What needs approval"
            placeholder="What needs approval"
            required
            maxLength={LIMITS.title}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
            }}
          />
          <textarea
            className={field}
            aria-label="Details"
            placeholder="Details (optional)"
            rows={3}
            maxLength={LIMITS.details}
            value={details}
            onChange={(e) => {
              setDetails(e.target.value)
            }}
          />
          <MemberPicker
            members={members}
            value={approverId}
            onChange={setApproverId}
            label="Approver"
          />
          {error !== null && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <div>
            <button
              type="submit"
              className={button}
              disabled={busy || title.trim() === "" || approverId === null}
            >
              Ask for approval
            </button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

/** Every request, with decide controls on the ones `me` decides. */
export function ApprovalList({
  requests,
  me,
  onDecided,
}: {
  readonly requests: readonly ApprovalRequest[]
  readonly me: string
  readonly onDecided: () => void
}) {
  if (requests.length === 0) {
    return <p className="text-muted-foreground text-sm">No approval requests yet.</p>
  }
  return (
    <ul className="grid gap-4">
      {requests.map((request) => (
        <li key={request.id}>
          <ApprovalCard request={request} me={me} onDecided={onDecided} />
        </li>
      ))}
    </ul>
  )
}

const STATUS_LABEL: Record<ApprovalStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
}

function ApprovalCard({
  request,
  me,
  onDecided,
}: {
  readonly request: ApprovalRequest
  readonly me: string
  readonly onDecided: () => void
}) {
  const mine = request.status === "pending" && request.approver.userId === me
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle>{request.title}</CardTitle>
          <Badge variant={request.status === "pending" ? "outline" : "secondary"}>
            {STATUS_LABEL[request.status]}
          </Badge>
        </div>
        <CardDescription>
          {request.requestedBy.name} asked {request.approver.name}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        {request.details !== "" && <p className="whitespace-pre-wrap">{request.details}</p>}
        {mine && <DecideControls id={request.id} onDecided={onDecided} />}
        <ol className="text-muted-foreground grid gap-1 border-l pl-3 text-xs" aria-label="History">
          {request.history.map((event, i) => (
            <li key={i}>
              <time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time>:{" "}
              {event.by.name} {event.kind}
              {event.note !== "" && <span className="text-foreground">: “{event.note}”</span>}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}

/** The approver's note and buttons; sends POST /api/approvals/decide. */
function DecideControls({
  id,
  onDecided,
}: {
  readonly id: string
  readonly onDecided: () => void
}) {
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function decide(decision: Decision): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await decideApproval({ id, decision, note })
      onDecided()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-2">
      <textarea
        className={field}
        aria-label="Note for your decision"
        placeholder="Note (optional)"
        rows={2}
        maxLength={LIMITS.note}
        value={note}
        onChange={(e) => {
          setNote(e.target.value)
        }}
      />
      {error !== null && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => void decide("approve")}
        >
          Approve
        </button>
        <button
          type="button"
          className={secondaryButton}
          disabled={busy}
          onClick={() => void decide("reject")}
        >
          Reject
        </button>
      </div>
    </div>
  )
}
