import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import type { HandoffView, QuoteView, ReviewStatus, SettingsView } from "../../shared/types.ts"
import { ApprovalsPanel } from "@/components/approvals-panel"
import { HandoffPanel } from "@/components/handoff-panel"
import { ReviewSection } from "@/features/settings/review-section"
import { age } from "@/lib/format"
import { ApproverPicker } from "@/features/settings/approver-picker"
import { approved, quoteInReview } from "./fixtures.ts"

const settings = (my_roles: SettingsView["my_roles"]): SettingsView => ({
  settings: {
    reviewer_bot: "reviewer-bot",
    review_board: null,
    handoff_thread: null,
    approvers: { finance: ["user-grace"], business: ["user-ada"] },
  },
  can_edit: false,
  my_roles,
  people: [
    { user_id: "user-grace", name: "Grace Hopper", email: "grace@example.com" },
    { user_id: "user-ada", name: "Ada Lovelace", email: "ada@example.com" },
  ],
})

/** In finance review, after the reviewer bot approved. */
const inFinanceReview = (): QuoteView => quoteInReview({ bot_review: approved("Reviewer (bot)") })

const MANUAL: HandoffView = {
  kind: "manual",
  since: "2026-11-10T09:00:00.000Z",
  reason: "Ask Reviewer Bot to join board quote-reviews.",
  instruction: "Reviewer Bot: please join board quote-reviews (join_workforce).",
}

const render = (quote: QuoteView, view: SettingsView | null, handoff: HandoffView | null = null) =>
  renderToStaticMarkup(
    <ApprovalsPanel quote={quote} settings={view} handoff={handoff} onChanged={() => undefined} />
  )

describe("approvals panel", () => {
  test("a finance approver gets the buttons while finance decides", () => {
    const html = render(inFinanceReview(), settings(["finance"]))
    expect(html).toContain("Request changes")
    expect(html.match(/Approve</g)).toHaveLength(1)
    expect(html).toContain("reviewer-bot")
    expect(html).toContain("Grace Hopper")
  })

  test("a business approver waits: no buttons in finance review", () => {
    expect(render(inFinanceReview(), settings(["business"]))).not.toContain("Request changes")
  })

  test("nobody gets buttons without the settings", () => {
    expect(render(inFinanceReview(), null)).not.toContain("Request changes")
  })

  test("finance records the reviewer bot's step; nobody else gets its buttons", () => {
    const fresh = quoteInReview()
    // Both cards: the reviewer step and finance.
    expect(render(fresh, settings(["finance"])).match(/<textarea/g)).toHaveLength(2)
    expect(render(fresh, settings(["business"])).match(/<textarea/g)).toBeNull()
    expect(render(fresh, settings([])).match(/<textarea/g)).toBeNull()
  })

  test("the reviewer step says what finance is confirming", () => {
    const fresh = quoteInReview()
    const waiting = render(fresh, settings(["finance"]))
    expect(waiting).toContain("Waiting for the reviewer bot&#x27;s recommendation")
    expect(render(fresh, settings(["finance"]), MANUAL)).toContain(
      "No recommendation is coming: record this step yourself."
    )
    const answered: HandoffView = {
      kind: "answered",
      since: "2026-11-10T09:00:15.000Z",
      reviewer: "Reviewer Bot",
      decision: "approve",
      note: "Fine.",
    }
    const html = render(fresh, settings(["finance"]), answered)
    expect(html).toContain("Reviewer Bot recommends approval: confirm it, or decide otherwise.")
    expect(html).toContain("Confirm reviewer bot&#x27;s approval")
  })
})

describe("handoff panel", () => {
  const now = new Date("2026-11-10T10:05:00Z")
  const show = (handoff: HandoffView) =>
    renderToStaticMarkup(<HandoffPanel handoff={handoff} now={now} />)

  test("shows the reviewer's recommendation as advice", () => {
    const html = show({
      kind: "answered",
      since: "2026-11-10T09:00:15.000Z",
      reviewer: "Reviewer Bot",
      decision: "reject",
      note: "Margin below floor.",
    })
    expect(html).toContain("Reviewer Bot recommends changes")
    expect(html).toContain("Margin below floor.")
    expect(html).toContain("Advice only")
  })

  test("shows nothing for a quote that was never handed off", () => {
    expect(show({ kind: "none" })).toBe("")
  })

  test("shows the task, its column and how long it has waited", () => {
    const html = show({
      kind: "task",
      since: "2026-11-10T09:00:00.000Z",
      board: "quote-reviews",
      task_number: 101,
      column: "review",
      last_checked_at: null,
      detail: "Waiting for verdict.json on the task.",
    })
    expect(html).toContain("task #101 on board quote-reviews")
    expect(html).toContain("waiting 1 h 5 min")
    expect(html).toContain("Waiting for verdict.json on the task.")
  })

  test("a manual handoff says why, with the request to copy", () => {
    const html = show(MANUAL)
    expect(html).toContain("Ask Reviewer Bot to join board quote-reviews.")
    expect(html).toContain("please join board quote-reviews")
    expect(html).toContain("Copy the request")
  })

  test.each([
    ["2026-11-10T10:04:30Z", "under a minute"],
    ["2026-11-10T09:53:00Z", "12 min"],
    ["2026-11-10T08:05:00Z", "2 h"],
    ["2026-11-08T10:00:00Z", "2 days"],
  ])("waiting since %s reads %s", (since, text) => {
    expect(age(since, now)).toBe(text)
  })
})

describe("review settings", () => {
  const status = (over: Partial<ReviewStatus> = {}): ReviewStatus => ({
    setup: { kind: "off", reason: "Reviewer bot handoff isn't set up.", instruction: null },
    can_create_board: false,
    boards: [
      { slug: "quote-reviews", name: "Quote reviews", missing_columns: [] },
      { slug: "general", name: "General", missing_columns: ["Review (review)"] },
    ],
    file_hosts: [],
    ...over,
  })
  const show = (s: ReviewStatus, canEdit = true) =>
    renderToStaticMarkup(
      <ReviewSection
        status={s}
        draft={settings([]).settings}
        canEdit={canEdit}
        disabled={false}
        onChange={() => undefined}
        onCreateBoard={() => undefined}
      />
    )

  test("says what to assign when this bot can't create a board", () => {
    const html = show(status())
    expect(html).not.toContain("Create review board")
    expect(html).toContain("assign this bot the create_workforce tool")
    // A board without the columns can't be picked.
    expect(html).toMatch(/<option value="general" disabled="">/)
    expect(html).toContain("QUOTE_DESK_FILE_HOSTS is not set")
  })

  test("offers the button when it can, to owners and admins only", () => {
    expect(show(status({ can_create_board: true }))).toContain("Create review board")
    expect(show(status({ can_create_board: true }), false)).not.toContain("Create review board")
  })

  test("names the board and reviewer once ready", () => {
    const html = show(
      status({
        setup: { kind: "ready", board: "quote-reviews", reviewer: "Reviewer Bot" },
        file_hosts: ["files.example.org"],
      })
    )
    expect(html).toContain("Finance reviews go to Reviewer Bot")
    expect(html).toContain("files.example.org")
  })
})

describe("approver picker", () => {
  test("keeps someone who left the org visible, so they can be removed", () => {
    const html = renderToStaticMarkup(
      <ApproverPicker
        label="Finance approvers"
        members={[{ user_id: "user-grace", name: "Grace Hopper", email: "grace@example.com" }]}
        value={["user-grace", "user-gone"]}
        disabled={false}
        onChange={() => undefined}
      />
    )
    expect(html).toContain("Grace Hopper")
    expect(html).toContain("user-gone")
    expect(html).toContain("no longer in the org")
  })
})
