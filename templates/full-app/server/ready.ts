import type { Runtime } from "@botyard/runtime"
import type { Log } from "./log.ts"

/**
 * One thing the app needs before it can answer requests: returns when all is
 * well, throws (or rejects) when not. Examples: the Botyard runtime answers;
 * a store has loaded its file; a database connection works. `signal` is
 * aborted when the check runs out of time; pass it on to what the check calls.
 */
export type ReadyCheck = (signal: AbortSignal) => void | Promise<void>

export type ReadyChecks = Readonly<Record<string, ReadyCheck>>

/**
 * Botyard answers through the bot: a fresh tool listing, not a cached one.
 *
 * Give it a runtime of its own (a second `createRuntime()`), never the one the
 * app calls tools with: a fresh listing replaces that runtime's cached tool
 * list, so a probe that hangs would hold up the app's own calls with it.
 */
export function runtimeCheck(probe: Pick<Runtime, "listTools">): ReadyCheck {
  return async (signal) => {
    await probe.listTools({ refresh: true, signal, timeoutMs: 5000 })
  }
}

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
 * which check failed and how ("timeout", or the error's class name, such as
 * "TypeError"; see failureCode), never the
 * error's message, and never anything about the viewer. The message goes to
 * the log, where `npm run trace` shows it.
 *
 * It stays cheap however often it is polled:
 * - A report is reused for `cacheMs`, and callers who arrive while one is
 *   being made share it.
 * - Each check runs at most once at a time. One that runs out of time is
 *   reported as "timeout" and then told to stop (its signal is aborted).
 *   Until it has actually finished, later reports say "timeout" too, rather
 *   than start another copy of it.
 */
export function createReadiness(
  checks: ReadyChecks,
  { log, timeoutMs = 3000, cacheMs = 5000 }: ReadinessOptions = {}
): () => Promise<ReadyReport> {
  let cached: { at: number; report: Promise<ReadyReport> } | undefined
  /** The outcome of each check still running, from this report or an earlier one. */
  const running = new Map<string, Promise<CheckResult>>()

  // One run of a check. Its outcome is decided once, by whichever comes
  // first: the check settling, or its deadline. At the deadline "timeout" is
  // recorded first and only then is the check told to stop, so nothing the
  // check does while stopping can turn it into a success. The run stays in
  // `running` until the check has actually settled, so a later report gets
  // the same, already-decided outcome rather than starting it again.
  const start = (name: string, check: ReadyCheck): Promise<CheckResult> => {
    const controller = new AbortController()
    let decide: (result: CheckResult) => void = () => {}
    const state = { decided: false }
    const outcome = new Promise<CheckResult>((resolve) => {
      decide = (result) => {
        if (state.decided) return
        state.decided = true
        resolve(result)
      }
    })
    const timer = setTimeout(() => {
      log?.warn("ready_check_failed", { check: name, reason: "timeout", timeoutMs })
      decide({ ok: false, reason: "timeout" })
      controller.abort()
    }, timeoutMs)
    running.set(name, outcome)
    void (async () => {
      try {
        // Called only after the run is registered, so even a check that
        // throws synchronously settles (and is forgotten) like any other.
        await Promise.resolve()
        await check(controller.signal)
        decide({ ok: true })
      } catch (err) {
        // Already reported as "timeout": nothing more to say.
        if (!state.decided) {
          log?.warn("ready_check_failed", { check: name }, err)
          decide({ ok: false, reason: failureCode(err) })
        }
      } finally {
        clearTimeout(timer)
        running.delete(name)
      }
    })()
    return outcome
  }

  const runOne = (name: string, check: ReadyCheck): Promise<CheckResult> =>
    running.get(name) ?? start(name, check)

  const report = async (): Promise<ReadyReport> => {
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
      cached = { at: now, report: report() }
    }
    return cached.report
  }
}

/**
 * How a failed check is reported: the error's name when it is a plain
 * identifier of up to 40 characters, such as "TypeError" or "AbortError";
 * otherwise "error". Reading the name cannot throw out of here: an error's
 * `name` can be a getter that throws.
 */
function failureCode(err: unknown): string {
  try {
    const name: unknown = err instanceof Error ? err.name : undefined
    return typeof name === "string" && /^[A-Za-z]\w{0,39}$/.test(name) ? name : "error"
  } catch {
    return "error"
  }
}
