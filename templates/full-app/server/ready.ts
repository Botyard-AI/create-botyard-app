import type { Log } from "./log.ts"

/**
 * One thing the app needs before it can answer requests. It resolves when
 * all is well and throws (or rejects) when not. Examples: the Botyard runtime
 * answers; a store has loaded its file; a database connection works.
 */
export type ReadyCheck = () => unknown

export type ReadyChecks = Readonly<Record<string, ReadyCheck>>

type CheckResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

type ReadyReport = {
  readonly ok: boolean
  readonly checks: Readonly<Record<string, CheckResult>>
}

type ReadinessOptions = {
  log?: Log
  /** Each check fails after this long. */
  timeoutMs?: number
  /** A report is reused for this long, so polling /api/ready stays cheap. */
  cacheMs?: number
}

/**
 * Runs the checks for `GET /api/ready`, all at once, each with a deadline.
 *
 * Anyone who can open the page can call /api/ready, so a report says only
 * which check failed and how ("timeout", or the error's name), never the
 * error's message, and never anything about the viewer. The message goes to
 * the log, where `npm run trace` shows it.
 *
 * A report is cached for `cacheMs`, and callers who arrive while checks are
 * running share them, so a busy poller cannot turn into a stream of calls to
 * Botyard.
 */
export function createReadiness(
  checks: ReadyChecks,
  { log, timeoutMs = 3000, cacheMs = 5000 }: ReadinessOptions = {}
): () => Promise<ReadyReport> {
  let cached: { at: number; report: Promise<ReadyReport> } | undefined

  const runOne = async (name: string, check: ReadyCheck): Promise<CheckResult> => {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        resolve("timeout")
      }, timeoutMs)
    })
    try {
      const outcome = await Promise.race([Promise.resolve().then(check), timeout])
      if (outcome === "timeout") {
        log?.warn("ready_check_failed", { check: name, reason: "timeout", timeoutMs })
        return { ok: false, reason: "timeout" }
      }
      return { ok: true }
    } catch (err) {
      const reason = err instanceof Error ? err.name : "error"
      log?.warn("ready_check_failed", { check: name, reason, error: err })
      return { ok: false, reason }
    } finally {
      clearTimeout(timer)
    }
  }

  const run = async (): Promise<ReadyReport> => {
    const entries = await Promise.all(
      Object.entries(checks).map(
        async ([name, check]) => [name, await runOne(name, check)] as const
      )
    )
    return { ok: entries.every(([, r]) => r.ok), checks: Object.fromEntries(entries) }
  }

  return async () => {
    const now = Date.now()
    if (cached === undefined || now - cached.at >= cacheMs) {
      cached = { at: now, report: run() }
    }
    return cached.report
  }
}
