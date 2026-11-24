// The GET /api/members response: what server/org-members.ts sends and what
// the member picker reads. Both import this file, so a field cannot change on
// one side only. It has no browser or Node code, so either side can load it.
import type { OrgMember } from "@botyard/botpage"

/**
 * One member, as the picker gets them. Every member who may call the route
 * sees these fields for every other member: drop `email` here (and where
 * the picker shows it) if your app does not need it.
 */
export type MemberOption = {
  readonly userId: string
  readonly name: string | null
  readonly email: string | null
  /** The org role id, such as `owner`, `admin` or `member`. */
  readonly role: string | null
}

export type MembersResponse = { readonly members: readonly MemberOption[] }

/** The response for a member list, sorted by name. Used by the server. */
export function toMembersResponse(members: readonly OrgMember[]): MembersResponse {
  const options = members.map((m): MemberOption => ({
    userId: m.userId,
    name: m.name,
    email: m.email,
    role: m.role,
  }))
  return { members: options.toSorted((a, b) => memberLabel(a).localeCompare(memberLabel(b))) }
}

/**
 * Narrows untrusted JSON to a MembersResponse. Used by the client. Every
 * field must be present: a missing one is an error, not a null.
 */
export function parseMembersResponse(body: unknown): MembersResponse {
  if (!isRecord(body) || !Array.isArray(body["members"])) {
    throw new Error("/api/members: no members list")
  }
  const members = body["members"].map((value: unknown, i): MemberOption => {
    const where = `members[${String(i)}]`
    if (!isRecord(value)) throw new Error(`${where}: not an object`)
    const userId = value["userId"]
    if (typeof userId !== "string") throw new Error(`${where}.userId: not a string`)
    return {
      userId,
      name: stringOrNull(value, "name", where),
      email: stringOrNull(value, "email", where),
      role: stringOrNull(value, "role", where),
    }
  })
  return { members }
}

/** What to call a member: their name, else their email, else their user id. */
export function memberLabel(member: MemberOption): string {
  return member.name ?? member.email ?? member.userId
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringOrNull(record: Record<string, unknown>, key: string, where: string): string | null {
  if (!(key in record)) throw new Error(`${where}.${key}: missing`)
  const value = record[key]
  if (value === null || typeof value === "string") return value
  throw new Error(`${where}.${key}: not a string or null`)
}
