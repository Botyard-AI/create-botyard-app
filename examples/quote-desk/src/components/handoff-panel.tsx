import { Bot } from "lucide-react"
import type { HandoffView } from "../../shared/types.ts"
import { CopyText } from "@/components/copy-text"
import { Notice } from "@/components/ui/bits"
import { age, when } from "@/lib/format"

const COLUMN: Readonly<Record<string, string>> = {
  review: "Review",
  approved: "Approved",
  "changes-requested": "Changes requested",
}

/**
 * Where the reviewer bot's part of a quote stands: handed off on a board, and
 * for how long; its recommendation; or no recommendation coming, and why.
 */
export function HandoffPanel({ handoff, now }: Readonly<{ handoff: HandoffView; now: Date }>) {
  switch (handoff.kind) {
    case "none":
      return null
    case "pending":
      return (
        <Notice tone="muted" role="status">
          <p className="flex items-center gap-2 font-medium">
            <Bot className="size-4" aria-hidden /> Handing the review to the reviewer bot…
          </p>
        </Notice>
      )
    case "manual":
      return (
        <Notice tone="warn" role="status">
          <div className="grid gap-2">
            <p className="flex items-center gap-2 font-medium">
              <Bot className="size-4" aria-hidden /> No recommendation from the reviewer bot
            </p>
            <p>{handoff.reason}</p>
            {handoff.instruction === null ? null : (
              <CopyText text={handoff.instruction} label="Copy the request" />
            )}
            <p className="text-xs">Since {when(handoff.since)}</p>
          </div>
        </Notice>
      )
    case "answered":
      return (
        <Notice tone={handoff.decision === "approve" ? "ok" : "warn"} role="status">
          <div className="grid gap-1">
            <p className="flex items-center gap-2 font-medium">
              <Bot className="size-4" aria-hidden /> {handoff.reviewer} recommends{" "}
              {handoff.decision === "approve" ? "approval" : "changes"}
            </p>
            <p className="whitespace-pre-wrap">{handoff.note}</p>
            <p className="text-xs">
              Advice only: a finance approver confirms the reviewer step below.
            </p>
          </div>
        </Notice>
      )
    case "task":
      return (
        <Notice tone="muted" role="status">
          <div className="grid gap-1">
            <p className="flex items-center gap-2 font-medium">
              <Bot className="size-4" aria-hidden /> With the reviewer bot: task #
              {handoff.task_number} on board {handoff.board}
            </p>
            <p>
              {COLUMN[handoff.column] ?? handoff.column} · waiting {age(handoff.since, now)}
              {handoff.last_checked_at === null
                ? ""
                : ` · last checked ${when(handoff.last_checked_at)}`}
            </p>
            {handoff.detail === null ? null : <p className="text-xs">{handoff.detail}</p>}
          </div>
        </Notice>
      )
  }
}
