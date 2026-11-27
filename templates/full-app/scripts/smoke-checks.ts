// The checks behind `npm run smoke`: see scripts/smoke.ts.
import type { Viewer } from "@botyard/botpage"

export type Result = { readonly check: string; readonly ok: boolean; readonly detail: string }

/**
 * Runs every check against `base`. It must stay self-contained (nothing from
 * outside the function but a browser's own globals: fetch, URL,
 * AbortSignal, JSON): `--browser` prints its source to run in a browser tab.
 *
 * - `outsider`: the headers that make a request come from a non-member.
 * - `viewerKind`: the kind of viewer /api/me must report, or null for any
 *   (including no viewer).
 * - `timeoutMs`: each request's deadline, its response body included. A
 *   request that runs out of time fails its check, and the rest still run.
 */
export async function smoke(
  base: string,
  outsider: Record<string, string>,
  viewerKind: Viewer["kind"] | null,
  timeoutMs = 10_000
): Promise<Result[]> {
  const get = async (path: string, headers: Record<string, string> = {}) => {
    // One signal for the whole exchange: it also cuts off a body that never ends.
    const signal = AbortSignal.timeout(timeoutMs)
    const res = await fetch(new URL(path, base), { headers, redirect: "manual", signal })
    return {
      status: res.status,
      type: res.headers.get("content-type") ?? "",
      text: await res.text(),
    }
  }
  const json = (text: string): unknown => {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }
  const field = (value: unknown, key: string): unknown => {
    if (typeof value !== "object" || value === null) return undefined
    const found: unknown = Object.getOwnPropertyDescriptor(value, key)?.value
    return found
  }
  /** A value as JSON for a message; "none" when it is missing. */
  const show = (value: unknown): string => (value === undefined ? "none" : JSON.stringify(value))
  const isText = (value: unknown): boolean => typeof value === "string" && value !== ""
  const isTextOrNull = (value: unknown): boolean => value === null || typeof value === "string"

  /**
   * What is wrong with a viewer from /api/me, or null when it is one of the
   * kinds @botyard/botpage defines, with the fields that kind always has.
   */
  const viewerProblem = (viewer: unknown): string | null => {
    const kind = field(viewer, "kind")
    const type = field(viewer, "viewerType")
    if (!isText(field(viewer, "subject")) || !isText(field(viewer, "source"))) {
      return "no subject or source"
    }
    if (kind === "member") {
      const ok =
        type === "user" &&
        isText(field(viewer, "userId")) &&
        isTextOrNull(field(viewer, "email")) &&
        isTextOrNull(field(viewer, "name")) &&
        isTextOrNull(field(viewer, "role")) &&
        // Always there, even while it is null.
        isTextOrNull(field(viewer, "avatarUrl"))
      return ok ? null : "a member without its user fields"
    }
    if (kind === "unknown") {
      const ok = (type === "user" || type === "unknown") && isTextOrNull(field(viewer, "email"))
      return ok ? null : "an unknown viewer without its fields"
    }
    if (kind === "bot") {
      const botId = field(viewer, "botId")
      const ok = type === "bot" && isText(botId) && field(viewer, "subject") === botId
      return ok ? null : "a bot without its botId"
    }
    return `an unknown kind: ${show(kind)}`
  }

  const checks: Record<string, () => Promise<Result>> = {
    health: async () => {
      const r = await get("/api/health")
      return { check: "health", ok: r.status === 200, detail: String(r.status) }
    },
    ready: async () => {
      const r = await get("/api/ready")
      const checks = field(json(r.text), "checks")
      const failing =
        typeof checks === "object" && checks !== null
          ? Object.entries(checks)
              .filter(([, c]) => field(c, "ok") !== true)
              .map(([name, c]) => `${name}: ${String(field(c, "reason"))}`)
          : []
      return {
        check: "ready",
        ok: r.status === 200 && field(json(r.text), "ok") === true,
        detail: [String(r.status), ...failing].join("; "),
      }
    },
    index: async () => {
      const r = await get("/")
      const ok = r.status === 200 && r.type.includes("text/html") && r.text.includes('id="root"')
      return { check: "index", ok, detail: `${String(r.status)} ${r.type.split(";")[0] ?? ""}` }
    },
    me: async () => {
      const r = await get("/api/me")
      const body = json(r.text)
      const viewer = field(body, "viewer")
      const kind = field(viewer, "kind")
      const problem = ((): string | null => {
        if (r.status !== 200 || typeof body !== "object" || body === null || !("viewer" in body)) {
          return "no { viewer } in the answer"
        }
        if (viewer === null) return viewerKind === null ? null : `no viewer, expected ${viewerKind}`
        const wrong = viewerProblem(viewer)
        if (wrong !== null) return wrong
        return viewerKind === null || kind === viewerKind ? null : `expected ${viewerKind}`
      })()
      const seen = viewer === null ? "null" : String(kind)
      const why = problem === null ? "" : ` (${problem})`
      return {
        check: "me",
        ok: problem === null,
        detail: `${String(r.status)} viewer: ${seen}${why}`,
      }
    },
    guard: async () => {
      const r = await get("/api/hello", outsider)
      // The app's own refusal: requireMember answers { error: "not_a_member" }.
      // A 403 from anything else proves nothing about the guard.
      const code = field(json(r.text), "error")
      const why: Record<number, string> = {
        200: "an outsider got in",
        401: "no viewer reached the app",
        403: `a 403, but not the app's refusal (error: ${show(code)})`,
      }
      const ok = r.status === 403 && code === "not_a_member"
      return {
        check: "guard",
        ok,
        detail: ok
          ? "403 not_a_member for an outsider"
          : `${String(r.status)}: ${why[r.status] ?? "expected 403 not_a_member"}`,
      }
    },
  }
  const results: Result[] = []
  for (const [name, check] of Object.entries(checks)) {
    try {
      results.push(await check())
    } catch (err) {
      // Read by name, not instanceof: in a browser tab or another realm the
      // error's class is not this realm's Error.
      const named = typeof err === "object" && err !== null
      let detail = named && "message" in err ? String(err.message) : String(err)
      if (named && "name" in err && err.name === "TimeoutError") {
        detail = `no full answer within ${String(timeoutMs)} ms`
      }
      results.push({ check: name, ok: false, detail })
    }
  }
  return results
}

/** The results as a table, one check per line. */
export function table(results: readonly Result[]): string {
  const width = Math.max(...results.map((r) => r.check.length))
  return results
    .map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.check.padEnd(width)}  ${r.detail}`)
    .join("\n")
}
