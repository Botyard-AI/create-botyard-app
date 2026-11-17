import type { ReviewStatus } from "../../../shared/types.ts"
import { CopyText } from "@/components/copy-text"
import { Notice } from "@/components/ui/bits"

/** Whether the reviewer handoff can run, and if not, why and what to ask for. */
export function SetupNotice({ setup }: Readonly<{ setup: ReviewStatus["setup"] }>) {
  if (setup.kind === "ready")
    return (
      <Notice tone="ok" role="status">
        Finance reviews go to {setup.reviewer} as tasks on board {setup.board}.
      </Notice>
    )
  return (
    <Notice tone="warn" role="status">
      <div className="grid gap-2">
        <p>{setup.reason} Until then, a finance approver records the reviewer bot&apos;s part.</p>
        {setup.instruction === null ? null : (
          <CopyText text={setup.instruction} label="Copy the request" />
        )}
      </div>
    </Notice>
  )
}
