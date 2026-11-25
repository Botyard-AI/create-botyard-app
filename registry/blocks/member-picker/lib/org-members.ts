// The org's members in the UI, read from GET /api/members (server/org-members.ts).
import { useEffect, useState } from "react"
import { apiFetch } from "@/lib/api-fetch"
import { parseMembersResponse, type MemberOption } from "@/lib/org-members-contract"

export { memberLabel, type MemberOption } from "@/lib/org-members-contract"

/** The member list while it loads, once it has, or when it could not be read. */
export type MembersState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly members: readonly MemberOption[] }

/** Reads GET /api/members once, when the component mounts. */
export function useOrgMembers(): MembersState {
  const [state, setState] = useState<MembersState>({ status: "loading" })
  useEffect(() => {
    const controller = new AbortController()
    fetchOrgMembers(controller.signal)
      .then((members) => {
        setState({ status: "ready", members })
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({ status: "error", message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      controller.abort()
    }
  }, [])
  return state
}

/**
 * Reads GET /api/members. Throws when the request fails or the answer is
 * malformed, and SessionExpiredError once the viewer's sign-in has run out.
 */
export async function fetchOrgMembers(signal?: AbortSignal): Promise<readonly MemberOption[]> {
  const res = await apiFetch("/api/members", {
    signal: signal ?? null,
    headers: { accept: "application/json" },
  })
  if (!res.ok) throw new Error(`/api/members answered ${String(res.status)}`)
  return parseMembersResponse(await res.json()).members
}

/** The members whose name or email contains `query`, ignoring case. */
export function filterMembers(
  members: readonly MemberOption[],
  query: string
): readonly MemberOption[] {
  const needle = query.trim().toLowerCase()
  if (needle === "") return members
  return members.filter((m) =>
    [m.name, m.email].some((text) => text?.toLowerCase().includes(needle) === true)
  )
}
