import { Check, Undo2 } from "lucide-react"
import { useId, useState } from "react"
import type { ApproverRole, Decision, QuoteView } from "../../shared/types.ts"
import { Button } from "@/components/ui/button"
import { ROLE_LABEL } from "@/lib/format"
import { decide } from "@/lib/quotes-api"

type Props = Readonly<{
  quote: QuoteView
  role: ApproverRole
  /** The approve button's text. */
  approveLabel?: string
  onDecided: (quote: QuoteView) => void
}>

/** Approve, or send back with a note. Shown only to the role's approvers. */
export function DecisionForm({ quote, role, approveLabel = "Approve", onDecided }: Props) {
  const id = useId()
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState<Decision | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function submit(decision: Decision) {
    if (decision === "reject" && note.trim() === "") {
      setError("Say what would make it acceptable.")
      return
    }
    setBusy(decision)
    setError(null)
    try {
      onDecided(await decide(quote.id, role, decision, note.trim()))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mt-2 grid gap-2">
      <label htmlFor={id} className="sr-only">
        Note for the {ROLE_LABEL[role].toLowerCase()} decision
      </label>
      <textarea
        id={id}
        rows={2}
        maxLength={2000}
        placeholder="Note (required to request changes)"
        className="bg-card focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2"
        value={note}
        onChange={(e) => {
          setNote(e.target.value)
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy !== null} onClick={() => void submit("approve")}>
          <Check aria-hidden />
          {busy === "approve" ? "Approving…" : approveLabel}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void submit("reject")}
        >
          <Undo2 aria-hidden />
          {busy === "reject" ? "Sending back…" : "Request changes"}
        </Button>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  )
}
