// Who may act, checked against the org's member directory.
//
// Guards read a cached member list (MEMBER_CACHE): fast, and one directory
// listing per 30 s however many people use the page. A change is different:
// its final check (confirmMember) reads a listing started after everything
// the request waited on, never the cache, so a member removed or demoted
// while the request was in flight is refused, not let through for up to the
// cache's lifetime.
import type { BotPage, MemberViewer } from "@botyard/botpage"
import { MemberDirectory } from "@botyard/botpage"
import type { ToolCaller } from "@botyard/runtime"
import { HttpError } from "./http.ts"

/** The page's member cache: refetched after 30 s, never served stale. */
export const MEMBER_CACHE = { ttlMs: 30_000, maxStaleMs: 0 } as const

/** What routes need to check a viewer: the page, and the tools to list members afresh. */
export type Guard = { readonly botpage: BotPage; readonly tools: ToolCaller }

/** How long a fresh listing may take before it is too old to authorize from. */
const FRESH_LISTING_MS = 10_000

/**
 * The member again, from a directory listing that starts now, not from the
 * cache or a listing already under way. They must still be a member, and
 * still have one of `roles`. A directory that cannot be read refuses (503).
 *
 * This lists the whole org on every change. `list_org_members` cannot look
 * up one member, so this is the only fresh read there is.
 */
export async function confirmMember(
  tools: ToolCaller,
  member: MemberViewer,
  roles?: readonly string[]
): Promise<void> {
  const fresh = new MemberDirectory(tools, { ttlMs: FRESH_LISTING_MS, maxStaleMs: 0 })
  const now = await fresh.lookup(member.userId)
  if (now?.userId !== member.userId)
    throw new HttpError(403, "You are no longer a member of this org")
  if (roles !== undefined && (now.role === null || !roles.includes(now.role)))
    throw new HttpError(403, "Your org role no longer allows this")
}
