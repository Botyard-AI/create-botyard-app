import { BotPageToolError } from "./errors.ts"
import type { ToolCaller } from "./tools.ts"

/** One member of the bot's Botyard organization. */
export interface OrgMember {
  readonly userId: string
  readonly email: string | null
  readonly name: string | null
  /** The member's org role id, e.g. `owner`, `admin`, `member`, `viewer`. */
  readonly role: string | null
  /**
   * Always `null` for now: `list_org_members` does not return avatars yet.
   * Kept in the type so apps can render one as soon as it does.
   */
  readonly avatarUrl: string | null
}

export interface MemberDirectoryOptions {
  /** How long a fetched member list is served before refetching. Default 60 s. */
  ttlMs?: number
  /**
   * After a failed refresh, how long to wait before calling the platform
   * again. Applies with or without cached data. Default 5 s.
   */
  retryAfterMs?: number
  /**
   * How long past `ttlMs` a member list may still be served while refreshes
   * fail. Guards authorize from this list, so it bounds how long a removed or
   * demoted member keeps access during an outage: at most
   * `ttlMs + maxStaleMs` after the last successful fetch began. Past it,
   * lookups fail closed with {@link BotPageToolError} (503 from the
   * adapters); so does a fetch that itself takes longer than that, since its
   * first pages are already too old. `0` disables stale serving. Default 5
   * minutes.
   */
  maxStaleMs?: number
  /** Members fetched per `list_org_members` call (1-100). Default 100. */
  pageSize?: number
  /** Stop paginating after this many members. Default 10 000. */
  maxMembers?: number
  /** Per-call timeout passed to the tool caller. Default 10 s. */
  timeoutMs?: number
  /** Clock, for tests. */
  now?: () => number
}

export const LIST_ORG_MEMBERS_TOOL = "list_org_members"

interface Snapshot {
  readonly byEmail: ReadonlyMap<string, OrgMember>
  readonly byUserId: ReadonlyMap<string, OrgMember>
  /** When the fetch that produced this list began. */
  readonly fetchedAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/**
 * Parse one entry of `list_org_members`:
 * `{ user_id, role_id, user: { user_id, email, name } }`. Returns `null` for
 * entries that have no user id.
 */
export function parseMember(entry: unknown): OrgMember | null {
  if (!isRecord(entry)) return null
  const user = isRecord(entry["user"]) ? entry["user"] : {}
  const userId = optionalString(entry["user_id"]) ?? optionalString(user["user_id"])
  if (userId === null) return null
  return {
    userId,
    email: optionalString(user["email"]),
    name: optionalString(user["name"]),
    role: optionalString(entry["role_id"]),
    avatarUrl: optionalString(user["avatar_url"]) ?? optionalString(user["image"]),
  }
}

function parsePage(response: unknown): { members: unknown[]; total: number | null } {
  if (!isRecord(response) || !Array.isArray(response["members"])) {
    throw new BotPageToolError(LIST_ORG_MEMBERS_TOOL, "response has no members array")
  }
  const total = response["total"]
  return { members: response["members"], total: typeof total === "number" ? total : null }
}

/**
 * The bot's org members, fetched through `list_org_members` and cached for a
 * TTL. All lookups in a process share one cached copy and at most one
 * in-flight refresh, so the platform sees one paginated listing per TTL per
 * process however many viewers arrive. Looking up an unknown subject never
 * forces a refetch.
 *
 * When a refresh fails, the platform is not called again for `retryAfterMs`,
 * whether or not a list is cached. Meanwhile the last list is served only
 * while it is younger than `ttlMs + maxStaleMs`; otherwise lookups reject.
 */
export class MemberDirectory {
  readonly #tools: ToolCaller
  readonly #ttlMs: number
  readonly #retryAfterMs: number
  readonly #maxStaleMs: number
  readonly #pageSize: number
  readonly #maxMembers: number
  readonly #timeoutMs: number
  readonly #now: () => number
  #snapshot: Snapshot | null = null
  #inflight: Promise<Snapshot> | null = null
  /** No platform call before this instant: the TTL after a success, the backoff after a failure. */
  #nextFetchAt = Number.NEGATIVE_INFINITY
  /** The last refresh failure, while no successful refresh has followed it. */
  #lastError: BotPageToolError | null = null

  constructor(tools: ToolCaller, options: MemberDirectoryOptions = {}) {
    this.#tools = tools
    this.#ttlMs = options.ttlMs ?? 60_000
    this.#retryAfterMs = options.retryAfterMs ?? 5_000
    this.#maxStaleMs = options.maxStaleMs ?? 5 * 60_000
    this.#pageSize = Math.min(100, Math.max(1, options.pageSize ?? 100))
    this.#maxMembers = options.maxMembers ?? 10_000
    this.#timeoutMs = options.timeoutMs ?? 10_000
    this.#now = options.now ?? Date.now
  }

  /**
   * Find a member by email (case-insensitive) or user id. Resolves `null`
   * when the subject is not a member. Rejects with {@link BotPageToolError}
   * when there is no member list young enough to authorize from.
   */
  async lookup(subject: string): Promise<OrgMember | null> {
    const snapshot = await this.#current()
    return snapshot.byUserId.get(subject) ?? snapshot.byEmail.get(subject.toLowerCase()) ?? null
  }

  /** Every cached member. */
  async list(): Promise<OrgMember[]> {
    return [...(await this.#current()).byUserId.values()]
  }

  /** Drop the cache and any failure backoff; the next lookup refetches. */
  invalidate(): void {
    this.#snapshot = null
    this.#lastError = null
    this.#nextFetchAt = Number.NEGATIVE_INFINITY
  }

  async #current(): Promise<Snapshot> {
    if (this.#now() < this.#nextFetchAt) return this.#serve()
    this.#inflight ??= this.#refresh().finally(() => {
      this.#inflight = null
    })
    return this.#inflight
  }

  /** Whether data read from a fetch that began at `fetchedAt` may still authorize. */
  #authorizable(fetchedAt: number): boolean {
    return this.#now() < fetchedAt + this.#ttlMs + this.#maxStaleMs
  }

  /** The cached list if it is young enough to authorize from, else the last failure. */
  #serve(): Snapshot {
    const snapshot = this.#snapshot
    if (snapshot !== null && this.#authorizable(snapshot.fetchedAt)) return snapshot
    throw this.#lastError ?? new BotPageToolError(LIST_ORG_MEMBERS_TOOL, "member list unavailable")
  }

  async #refresh(): Promise<Snapshot> {
    const startedAt = this.#now()
    try {
      const members = await this.#fetchAll()
      const byEmail = new Map<string, OrgMember>()
      const byUserId = new Map<string, OrgMember>()
      for (const member of members) {
        byUserId.set(member.userId, member)
        if (member.email !== null) byEmail.set(member.email.toLowerCase(), member)
      }
      if (!this.#authorizable(startedAt)) {
        // The listing took longer than the staleness bound: its first pages
        // are already too old to authorize from (a member read early may have
        // been removed or demoted since). Fail closed and back off.
        throw new BotPageToolError(
          LIST_ORG_MEMBERS_TOOL,
          "listing took longer than the staleness bound"
        )
      }
      const fresh = { byEmail, byUserId, fetchedAt: startedAt }
      this.#snapshot = fresh
      this.#lastError = null
      this.#nextFetchAt = startedAt + this.#ttlMs
      return fresh
    } catch (error) {
      // Back off whether or not a list is cached, so a failing platform sees
      // one call per retry interval per process, not one per request.
      this.#lastError =
        error instanceof BotPageToolError
          ? error
          : new BotPageToolError(LIST_ORG_MEMBERS_TOOL, "call failed", { cause: error })
      this.#nextFetchAt = this.#now() + this.#retryAfterMs
      return this.#serve()
    }
  }

  async #fetchAll(): Promise<OrgMember[]> {
    const members: OrgMember[] = []
    let offset = 0
    while (offset < this.#maxMembers) {
      const response = await this.#tools.call(
        LIST_ORG_MEMBERS_TOOL,
        { limit: this.#pageSize, offset },
        { timeoutMs: this.#timeoutMs }
      )
      const page = parsePage(response)
      for (const entry of page.members) {
        const member = parseMember(entry)
        if (member !== null) members.push(member)
      }
      offset += page.members.length
      if (page.members.length < this.#pageSize) break
      if (page.total !== null && offset >= page.total) break
    }
    return members
  }
}
