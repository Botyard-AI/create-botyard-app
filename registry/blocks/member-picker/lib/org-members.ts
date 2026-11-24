// The org's members, as GET /api/members returns them (server/org-members.ts).
import { useEffect, useState } from "react"

/** One member of the org. */
export type MemberOption = {
  readonly userId: string
  readonly name: string | null
  readonly email: string | null
  readonly role: string | null
}

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

/** Reads GET /api/members. Throws when the request fails or the answer is malformed. */
export async function fetchOrgMembers(signal?: AbortSignal): Promise<MemberOption[]> {
  const res = await fetch("/api/members", {
    signal: signal ?? null,
    headers: { accept: "application/json" },
  })
  if (!res.ok) throw new Error(`/api/members answered ${String(res.status)}`)
  return parseMembers(await res.json())
}

/** Narrows untrusted JSON, `{ members: [...] }`, to a list of members. */
export function parseMembers(body: unknown): MemberOption[] {
  if (!isRecord(body) || !Array.isArray(body["members"])) {
    throw new Error("/api/members: no members list")
  }
  return body["members"].map((value: unknown, i) => {
    if (!isRecord(value)) throw new Error(`members[${String(i)}]: not an object`)
    const userId = value["userId"]
    if (typeof userId !== "string") throw new Error(`members[${String(i)}].userId: not a string`)
    return {
      userId,
      name: strOrNull(value, "name", i),
      email: strOrNull(value, "email", i),
      role: strOrNull(value, "role", i),
    }
  })
}

/** What to call a member: their name, else their email, else their user id. */
export function memberLabel(member: MemberOption): string {
  return member.name ?? member.email ?? member.userId
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function strOrNull(record: Record<string, unknown>, key: string, i: number): string | null {
  const value = record[key]
  if (value === null || value === undefined) return null
  if (typeof value !== "string") throw new Error(`members[${String(i)}].${key}: not a string`)
  return value
}
