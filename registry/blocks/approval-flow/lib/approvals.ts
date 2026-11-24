// The approval API from the UI: read the requests, ask for approval, decide.
// Shapes and parsing live in approvals-contract.ts, shared with the server.
import { useCallback, useEffect, useState } from "react"
import {
  parseApprovalResponse,
  parseApprovalsResponse,
  parseDecidedResponse,
  type ApprovalResponse,
  type ApprovalsResponse,
  type DecidedResponse,
  type DecideApproval,
  type DecideApprovals,
  type NewApproval,
} from "@/lib/approvals-contract"

export type ApprovalsState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly approvals: ApprovalsResponse }

/** Reads GET /api/approvals when mounted and whenever `reload` is called. */
export function useApprovals(): { state: ApprovalsState; reload: () => void } {
  const [state, setState] = useState<ApprovalsState>({ status: "loading" })
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    getJson("/api/approvals", controller.signal)
      .then((body) => {
        setState({ status: "ready", approvals: parseApprovalsResponse(body) })
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({ status: "error", message: errorMessage(err) })
      })
    return () => {
      controller.abort()
    }
  }, [version])
  const reload = useCallback(() => {
    setVersion((v) => v + 1)
  }, [])
  return { state, reload }
}

/** POST /api/approvals. Throws with the server's message when it refuses. */
export async function requestApproval(body: NewApproval): Promise<ApprovalResponse> {
  return parseApprovalResponse(await postJson("/api/approvals", body))
}

/**
 * POST /api/approvals/decide, for one or more requests. All or nothing:
 * throws with the server's message, and records none, if any is refused.
 */
export async function decideApprovals(
  decisions: readonly DecideApproval[]
): Promise<DecidedResponse> {
  const body: DecideApprovals = { decisions }
  return parseDecidedResponse(await postJson("/api/approvals/decide", body))
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  return answer(url, await fetch(url, { signal, headers: { accept: "application/json" } }))
}

async function postJson(url: string, body: NewApproval | DecideApprovals): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  })
  return answer(url, res)
}

/** The JSON body, or an error carrying the server's explanation. */
async function answer(url: string, res: Response): Promise<unknown> {
  const body: unknown = await res.json().catch(() => null)
  if (res.ok) return body
  throw new Error(refusal(body) ?? `${url} answered ${String(res.status)}`)
}

/** Refusals carry `error` (ours) or `message` (the member guards'). */
function refusal(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null
  if ("message" in body && typeof body.message === "string") return body.message
  if ("error" in body && typeof body.error === "string") return body.error
  return null
}
