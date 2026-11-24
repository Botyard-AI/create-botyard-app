// The approval API's shapes: what server/approvals.ts accepts and answers,
// and what the approval flow UI sends and reads. Both import this file, so
// a field cannot change on one side only. It has no browser or Node code,
// so either side can load it.

/** Someone, by their org user id, with the name they had when it happened. */
export type Person = { readonly userId: string; readonly name: string }

export type Decision = "approve" | "reject"
export type ApprovalStatus = "pending" | "approved" | "rejected"

/**
 * What each decision makes of a request: its new status, and the kind of
 * its history event. A new Decision fails to compile until it is added here.
 */
export const DECISION_OUTCOME = {
  approve: "approved",
  reject: "rejected",
} as const satisfies Record<Decision, Exclude<ApprovalStatus, "pending">>

/** One step in a request's history. */
export type ApprovalEvent = {
  readonly kind: "requested" | "approved" | "rejected"
  readonly by: Person
  /** ISO 8601 time. */
  readonly at: string
  readonly note: string
}

export type ApprovalRequest = {
  readonly id: string
  readonly title: string
  readonly details: string
  readonly requestedBy: Person
  /** The one member who may decide. */
  readonly approver: Person
  readonly status: ApprovalStatus
  /** Oldest first. */
  readonly history: readonly ApprovalEvent[]
}

/** GET /api/approvals: every request, newest first, and who is asking. */
export type ApprovalsResponse = {
  /** The viewer's user id, so the UI can offer them the requests they decide. */
  readonly me: string
  readonly requests: readonly ApprovalRequest[]
}

/** POST /api/approvals answers with the new request. */
export type ApprovalResponse = { readonly request: ApprovalRequest }

/** POST /api/approvals/decide answers with the decided requests, in the order sent. */
export type DecidedResponse = { readonly requests: readonly ApprovalRequest[] }

/** POST /api/approvals: ask a member to approve something. */
export type NewApproval = {
  readonly title: string
  readonly details: string
  readonly approverId: string
}

/** The approver's decision on one pending request. */
export type DecideApproval = {
  readonly id: string
  readonly decision: Decision
  readonly note: string
}

/**
 * POST /api/approvals/decide: one or more decisions, each on a different
 * request. All or nothing: if any one is refused, none is recorded.
 */
export type DecideApprovals = { readonly decisions: readonly DecideApproval[] }

export const LIMITS = { title: 200, details: 4000, note: 2000, decisions: 50 } as const

// Request bodies, read by the server. They throw ContractError on bad input.

export function parseNewApproval(body: unknown): NewApproval {
  const r = record(body, "body")
  const title = text(r, "title", "body", LIMITS.title).trim()
  if (title === "") throw new ContractError("body.title: empty")
  return {
    title,
    details: text(r, "details", "body", LIMITS.details).trim(),
    approverId: text(r, "approverId", "body", 200),
  }
}

/** 1 to 50 decisions; the same request twice is refused. */
export function parseDecideApprovals(body: unknown): DecideApprovals {
  const list = record(body, "body")["decisions"]
  if (!Array.isArray(list) || list.length < 1 || list.length > LIMITS.decisions) {
    throw new ContractError(`body.decisions: a list of 1 to ${String(LIMITS.decisions)}`)
  }
  const decisions = list.map((value: unknown, i): DecideApproval => {
    const where = `body.decisions[${String(i)}]`
    const r = record(value, where)
    return {
      id: text(r, "id", where, 200),
      decision: oneOf(r, "decision", where, ["approve", "reject"]),
      note: text(r, "note", where, LIMITS.note).trim(),
    }
  })
  if (new Set(decisions.map((d) => d.id)).size !== decisions.length) {
    throw new ContractError("body.decisions: the same request more than once")
  }
  return { decisions }
}

// Responses, read by the client.

export function parseApprovalsResponse(body: unknown): ApprovalsResponse {
  const r = record(body, "response")
  const requests = r["requests"]
  return {
    me: text(r, "me", "response"),
    requests: parseApprovalRequests(requests),
  }
}

export function parseDecidedResponse(body: unknown): DecidedResponse {
  return { requests: parseApprovalRequests(record(body, "response")["requests"]) }
}

export function parseApprovalResponse(body: unknown): ApprovalResponse {
  return { request: parseRequest(record(body, "response")["request"], "request") }
}

/** A saved list of requests, as server/approvals.ts writes it to disk. */
export function parseApprovalRequests(value: unknown): ApprovalRequest[] {
  if (!Array.isArray(value)) throw new ContractError("requests: not a list")
  return value.map((v: unknown, i) => parseRequest(v, `requests[${String(i)}]`))
}

function parseRequest(value: unknown, where: string): ApprovalRequest {
  const r = record(value, where)
  const history = r["history"]
  if (!Array.isArray(history)) throw new ContractError(`${where}.history: not a list`)
  return {
    id: text(r, "id", where),
    title: text(r, "title", where),
    details: text(r, "details", where),
    requestedBy: parsePerson(r["requestedBy"], `${where}.requestedBy`),
    approver: parsePerson(r["approver"], `${where}.approver`),
    status: oneOf(r, "status", where, ["pending", "approved", "rejected"]),
    history: history.map((v: unknown, i) => {
      const at = `${where}.history[${String(i)}]`
      const e = record(v, at)
      return {
        kind: oneOf(e, "kind", at, ["requested", "approved", "rejected"]),
        by: parsePerson(e["by"], `${at}.by`),
        at: text(e, "at", at),
        note: text(e, "note", at),
      }
    }),
  }
}

function parsePerson(value: unknown, where: string): Person {
  const r = record(value, where)
  return { userId: text(r, "userId", where), name: text(r, "name", where) }
}

/** Input that does not match the contract. The server answers it with 400. */
export class ContractError extends Error {
  override name = "ContractError"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (isRecord(value)) return value
  throw new ContractError(`${where}: not an object`)
}

function text(r: Record<string, unknown>, key: string, where: string, max?: number): string {
  const value = r[key]
  if (typeof value !== "string") throw new ContractError(`${where}.${key}: not a string`)
  if (max !== undefined && value.length > max) {
    throw new ContractError(`${where}.${key}: longer than ${String(max)} characters`)
  }
  return value
}

function oneOf<T extends string>(
  r: Record<string, unknown>,
  key: string,
  where: string,
  allowed: readonly T[]
): T {
  const value = r[key]
  const found = allowed.find((a) => a === value)
  if (found === undefined)
    throw new ContractError(`${where}.${key}: not one of ${allowed.join(", ")}`)
  return found
}
