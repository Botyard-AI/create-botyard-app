import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import type { QuoteView, SettingsView } from "../../shared/types.ts"
import { ApprovalsPanel } from "@/components/approvals-panel"
import { ApproverPicker } from "@/features/settings/approver-picker"
import { approved, quoteInReview } from "./fixtures.ts"

const settings = (my_roles: SettingsView["my_roles"]): SettingsView => ({
  settings: {
    reviewer_bot: "reviewer-bot",
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

const render = (quote: QuoteView, view: SettingsView | null) =>
  renderToStaticMarkup(<ApprovalsPanel quote={quote} settings={view} onChanged={() => undefined} />)

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

  test("the reviewer bot's card never has buttons", () => {
    const fresh = quoteInReview()
    expect(render(fresh, settings(["finance", "business"]))).toContain("Request changes")
    // One form only: finance. The bot card shows who, not buttons.
    expect(render(fresh, settings([])).match(/textarea/g)).toBeNull()
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
