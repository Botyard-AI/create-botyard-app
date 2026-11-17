import { Save } from "lucide-react"
import { useEffect, useState } from "react"
import type {
  BotOption,
  DeskSettings,
  MemberOption,
  ReviewStatus,
  SettingsView,
} from "../../../shared/types.ts"
import { Notice, Panel } from "@/components/ui/bits"
import { Button } from "@/components/ui/button"
import { Field, Select } from "@/components/ui/form"
import {
  createReviewBoard,
  getMembers,
  getReviewStatus,
  getSettings,
  listBots,
  saveSettings,
} from "@/lib/quotes-api"
import { ApproverPicker } from "./approver-picker"
import { ReviewSection } from "./review-section"

type Loaded =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  | {
      readonly state: "ready"
      readonly view: SettingsView
      readonly members: readonly MemberOption[]
      readonly bots: readonly BotOption[]
    }

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Who approves quotes. Org owners and admins may change it; everyone may read it. */
export function SettingsPage() {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" })
  const [draft, setDraft] = useState<DeskSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  // The reviewer handoff as saved; read again after each save.
  const [review, setReview] = useState<ReviewStatus | null>(null)
  const [saves, setSaves] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      getSettings(controller.signal),
      getMembers(controller.signal),
      listBots(controller.signal),
    ])
      .then(([view, members, bots]) => {
        setLoaded({ state: "ready", view, members, bots })
        setDraft(view.settings)
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setLoaded({ state: "error", message: message(err) })
      })
    return () => {
      controller.abort()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    getReviewStatus(controller.signal)
      .then(setReview)
      .catch(() => {
        // The section shows without its status; saving still checks the board.
      })
    return () => {
      controller.abort()
    }
  }, [saves])

  if (loaded.state === "loading") return <p className="text-muted-foreground text-sm">Loading…</p>
  if (loaded.state === "error" || draft === null)
    return (
      <Notice tone="error" role="alert">
        {loaded.state === "error" ? loaded.message : "No settings"}
      </Notice>
    )

  const { view, members, bots } = loaded
  const readOnly = !view.can_edit || busy

  async function save(next: DeskSettings) {
    setBusy(true)
    setResult(null)
    try {
      setDraft(await saveSettings(next))
      setResult({ ok: true, text: "Saved." })
      setSaves((n) => n + 1)
    } catch (err) {
      setResult({ ok: false, text: message(err) })
    } finally {
      setBusy(false)
    }
  }

  async function createBoard(current: DeskSettings) {
    setBusy(true)
    setResult(null)
    try {
      const saved = await createReviewBoard()
      // Keep unsaved edits elsewhere; the board is saved already.
      setDraft({ ...current, review_board: saved.review_board })
      setResult({ ok: true, text: `Created board ${saved.review_board ?? ""} and saved it.` })
      setSaves((n) => n + 1)
    } catch (err) {
      setResult({ ok: false, text: message(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title="Who approves quotes" className="max-w-3xl">
      <form
        className="grid gap-6 p-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save(draft)
        }}
      >
        {view.can_edit ? null : (
          <Notice tone="muted">Only org owners and admins can change these settings.</Notice>
        )}
        <Field
          label="Reviewer bot (finance)"
          htmlFor="reviewer-bot"
          hint={
            <p className="text-muted-foreground text-xs">
              The bot that reviews each submitted quote for finance.
            </p>
          }
        >
          <Select
            id="reviewer-bot"
            disabled={readOnly}
            value={draft.reviewer_bot ?? ""}
            onChange={(e) => {
              setDraft({ ...draft, reviewer_bot: e.target.value === "" ? null : e.target.value })
            }}
          >
            <option value="">None</option>
            {bots.map((b) => (
              <option key={b.slug} value={b.slug}>
                {b.name} ({b.slug})
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-6 sm:grid-cols-2">
          <ApproverPicker
            label="Finance approvers"
            members={members}
            value={draft.approvers.finance}
            disabled={readOnly}
            onChange={(finance) => {
              setDraft({ ...draft, approvers: { ...draft.approvers, finance } })
            }}
          />
          <ApproverPicker
            label="Business approvers"
            members={members}
            value={draft.approvers.business}
            disabled={readOnly}
            onChange={(business) => {
              setDraft({ ...draft, approvers: { ...draft.approvers, business } })
            }}
          />
        </div>
        <ReviewSection
          status={review}
          draft={draft}
          canEdit={view.can_edit}
          disabled={readOnly}
          onChange={setDraft}
          onCreateBoard={() => void createBoard(draft)}
        />
        {view.can_edit ? (
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={busy}>
              <Save aria-hidden />
              {busy ? "Saving…" : "Save"}
            </Button>
            {result === null ? null : (
              <p role="status" className={result.ok ? "text-sm" : "text-destructive text-sm"}>
                {result.text}
              </p>
            )}
          </div>
        ) : null}
      </form>
    </Panel>
  )
}
