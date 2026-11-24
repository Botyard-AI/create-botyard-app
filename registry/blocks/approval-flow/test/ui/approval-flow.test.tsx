import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { ApprovalList } from "@/components/approval-flow"
import {
  parseApprovalsResponse,
  parseDecideApproval,
  parseNewApproval,
  type ApprovalRequest,
} from "@/lib/approvals-contract"

const ada = { userId: "user-ada", name: "Ada" }
const grace = { userId: "user-grace", name: "Grace" }
const at = "2026-11-24T10:00:00.000Z"

const pending: ApprovalRequest = {
  id: "r1",
  title: "Buy a 3D printer",
  details: "For the lab",
  requestedBy: ada,
  approver: grace,
  status: "pending",
  history: [{ kind: "requested", by: ada, at, note: "" }],
}
const approved: ApprovalRequest = {
  ...pending,
  id: "r2",
  title: "New laptop",
  status: "approved",
  history: [...pending.history, { kind: "approved", by: grace, at, note: "Go ahead" }],
}

function render(requests: readonly ApprovalRequest[], me: string): string {
  return renderToStaticMarkup(
    <ApprovalList requests={requests} me={me} onDecided={() => undefined} />
  )
}

describe("ApprovalList", () => {
  test("the approver can decide a pending request", () => {
    const html = render([pending], "user-grace")
    expect(html).toContain("Buy a 3D printer")
    expect(html).toContain("Ada asked Grace")
    expect(html).toContain("Approve")
    expect(html).toContain("Reject")
  })

  test("nobody else gets the buttons", () => {
    expect(render([pending], "user-ada")).not.toContain("Approve<")
  })

  test("a decided request shows its history and no buttons", () => {
    const html = render([approved], "user-grace")
    expect(html).toContain("Approved")
    expect(html).toContain("Go ahead")
    expect(html).not.toContain("Reject<")
  })

  test("no requests", () => {
    expect(render([], "user-ada")).toContain("No approval requests yet.")
  })
})

describe("the contract", () => {
  test("reads what the server sends", () => {
    const body: unknown = JSON.parse(JSON.stringify({ me: "user-ada", requests: [approved] }))
    expect(parseApprovalsResponse(body).requests[0]).toEqual(approved)
  })

  test("rejects malformed answers and bodies", () => {
    expect(() => parseApprovalsResponse({ me: "x" })).toThrow()
    const noStatus = { ...pending, status: undefined }
    expect(() => parseApprovalsResponse({ me: "x", requests: [noStatus] })).toThrow("status")
    expect(() => parseNewApproval({ title: "t", details: "" })).toThrow("approverId")
    expect(() => parseDecideApproval({ id: "r1", decision: "maybe", note: "" })).toThrow()
  })

  test("trims what people type", () => {
    expect(parseNewApproval({ title: "  t  ", details: " d ", approverId: "u" })).toEqual({
      title: "t",
      details: "d",
      approverId: "u",
    })
  })
})
