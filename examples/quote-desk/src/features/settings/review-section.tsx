import { Plus } from "lucide-react"
import type { DeskSettings, ReviewStatus } from "../../../shared/types.ts"
import { Button } from "@/components/ui/button"
import { Field, Input, Select } from "@/components/ui/form"
import { FileHostsNote } from "./file-hosts-note"
import { SetupNotice } from "./setup-notice"

type Props = Readonly<{
  /** Null while loading, or when it could not be read. */
  status: ReviewStatus | null
  draft: DeskSettings
  canEdit: boolean
  disabled: boolean
  onChange: (next: DeskSettings) => void
  onCreateBoard: () => void
}>

/** Where the reviewer bot gets its work: a board, and optionally a thread to nudge it in. */
export function ReviewSection({
  status,
  draft,
  canEdit,
  disabled,
  onChange,
  onCreateBoard,
}: Props) {
  const boards = status?.boards ?? []
  const listed = draft.review_board === null || boards.some((b) => b.slug === draft.review_board)
  return (
    <fieldset className="grid gap-4 border-t pt-6">
      <legend className="sr-only">Reviewer bot handoff</legend>
      <h3 className="text-sm font-semibold">Reviewer bot handoff</h3>
      {status === null ? null : <SetupNotice setup={status.setup} />}
      <Field
        label="Review board"
        htmlFor="review-board"
        hint={
          <p className="text-muted-foreground text-xs">
            Each quote in finance review becomes a task here, assigned to the reviewer bot. The
            board needs the columns Review, Approved and Changes requested, and the reviewer bot
            must be a member.
          </p>
        }
      >
        <Select
          id="review-board"
          disabled={disabled}
          value={draft.review_board ?? ""}
          onChange={(e) => {
            onChange({ ...draft, review_board: e.target.value === "" ? null : e.target.value })
          }}
        >
          <option value="">None (finance records the reviewer bot&apos;s part)</option>
          {listed ? null : (
            <option value={draft.review_board}>{draft.review_board} (not found)</option>
          )}
          {boards.map((b) => (
            <option key={b.slug} value={b.slug} disabled={b.missing_columns.length > 0}>
              {b.name} ({b.slug})
              {b.missing_columns.length > 0 ? ` (missing ${b.missing_columns.join(", ")})` : ""}
            </option>
          ))}
        </Select>
      </Field>
      {canEdit && status !== null ? (
        <div className="flex flex-wrap items-center gap-3">
          {status.can_create_board ? (
            <Button type="button" variant="outline" disabled={disabled} onClick={onCreateBoard}>
              <Plus aria-hidden /> Create review board
            </Button>
          ) : (
            <p className="text-muted-foreground text-xs">
              To create a board from here, assign this bot the create_workforce tool. Or pick a
              board it is already on.
            </p>
          )}
        </div>
      ) : null}
      <Field
        label="Handoff thread (optional)"
        htmlFor="handoff-thread"
        hint={
          <p className="text-muted-foreground text-xs">
            The id of a conversation of this bot&apos;s with the reviewer bot. When set, each
            handoff also posts a nudge there, so the reviewer bot picks the task up sooner.
          </p>
        }
      >
        <Input
          id="handoff-thread"
          disabled={disabled}
          placeholder="Conversation id"
          value={draft.handoff_thread ?? ""}
          onChange={(e) => {
            const v = e.target.value.trim()
            onChange({ ...draft, handoff_thread: v === "" ? null : v })
          }}
        />
      </Field>
      {status === null ? null : <FileHostsNote hosts={status.file_hosts} />}
    </fieldset>
  )
}
