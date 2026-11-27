// The checks behind `npm run smoke`: see scripts/smoke.ts.

export type Result = { readonly check: string; readonly ok: boolean; readonly detail: string }

/**
 * Runs every check against `base`. It must stay self-contained (no imports,
 * nothing from outside the function): `--browser` prints its source to run
 * in a browser tab.
 *
 * `outsider` is the headers that make a request come from a non-member;
 * `viewerKind`, when set, is the kind /api/me must report.
 */
export async function smoke(
  base: string,
  outsider: Record<string, string>,
  viewerKind: string | null
): Promise<Result[]> {
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(new URL(path, base), { headers, redirect: "manual" })
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

  const checks: Record<string, () => Promise<Result>> = {
    health: async () => {
      const r = await get("/api/health")
      return { check: "health", ok: r.status === 200, detail: `${String(r.status)}` }
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
      const shaped =
        typeof body === "object" &&
        body !== null &&
        "viewer" in body &&
        (viewer === null || typeof kind === "string")
      const ok = r.status === 200 && shaped && (viewerKind === null || kind === viewerKind)
      return {
        check: "me",
        ok,
        detail: `${String(r.status)} viewer: ${viewer === null ? "null" : String(kind)}`,
      }
    },
    guard: async () => {
      const r = await get("/api/hello", outsider)
      const why: Record<number, string> = {
        200: "an outsider got in",
        401: "no viewer reached the app",
      }
      return {
        check: "guard",
        ok: r.status === 403,
        detail:
          r.status === 403
            ? "403 for an outsider"
            : `${String(r.status)}: ${why[r.status] ?? "expected 403"}`,
      }
    },
  }
  const results: Result[] = []
  for (const [name, check] of Object.entries(checks)) {
    try {
      results.push(await check())
    } catch (err) {
      results.push({
        check: name,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      })
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
