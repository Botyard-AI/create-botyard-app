export type SessionExpiredMode = "reload" | "prompt"

// Calls the app's own /api routes, and handles the one failure the app cannot
// fix by itself: the Botyard sign-in behind the Bot Page running out.
//
// The Bot Page proxy signs the viewer in with a token that lasts about an hour.
// When it lapses, a page load is sent through sign-in and straight back, but a
// fetch() cannot follow that, so the proxy answers it with 401. apiFetch spots
// that 401 and, depending on configureApiFetch, reloads the page (which signs
// the viewer in again) or tells the user to (<SessionExpiredBanner />).

/**
 * - `"reload"` (the default): reload the page at once. Nothing on screen is
 *   kept, so pick this when the page holds nothing the user typed.
 * - `"prompt"`: show <SessionExpiredBanner /> and let the user reload when
 *   ready. Pick this when a reload could lose what someone typed.
 */
type ApiFetchOptions = { readonly onSessionExpired: SessionExpiredMode }

/** The message apiFetch throws, and the banner shows, once the sign-in ran out. */
export const SESSION_EXPIRED_MESSAGE = "Your Botyard sign-in expired. Reload the page to continue."

/** Thrown by apiFetch for the proxy's 401. Show its message like any other error. */
export class SessionExpiredError extends Error {
  override name = "SessionExpiredError"
  constructor() {
    super(SESSION_EXPIRED_MESSAGE)
  }
}

/**
 * A second expiry this soon after reloading for one means signing in again did
 * not help, so the app stops reloading and shows the banner instead of looping.
 */
export const RELOAD_GUARD_MS = 60_000
const RELOADED_AT_KEY = "botyard:session-expired-reload-at"

/** What a session guard needs from the browser. Tests pass their own. */
export type GuardBrowser = {
  readonly reload: () => void
  /** The tab's sessionStorage, or null where the browser refuses it. */
  readonly storage: Pick<Storage, "getItem" | "setItem"> | null
  readonly now: () => number
}

/** Tracks whether the sign-in ran out, and decides between reloading and the banner. */
type SessionGuard = {
  /** Call once a request got the proxy's 401. Later calls do nothing. */
  readonly expire: () => void
  readonly isExpired: () => boolean
  /** For useSyncExternalStore: `listener` runs when the banner should appear. */
  readonly subscribe: (listener: () => void) => () => void
}

export function createSessionGuard(
  browser: GuardBrowser,
  mode: () => SessionExpiredMode
): SessionGuard {
  let expired = false
  const listeners = new Set<() => void>()

  return {
    expire() {
      if (expired) return
      expired = true
      if (mode() === "reload" && markReload(browser)) {
        browser.reload()
        return
      }
      for (const listener of listeners) listener()
    },
    isExpired: () => expired,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * Records this reload and returns true, unless the last one was under
 * RELOAD_GUARD_MS ago. Without sessionStorage there is no way to tell, so it
 * returns false: showing the banner is always safe, reloading in a loop is not.
 */
function markReload(browser: GuardBrowser): boolean {
  const { storage } = browser
  if (storage === null) return false
  try {
    const last = Number(storage.getItem(RELOADED_AT_KEY))
    const now = browser.now()
    if (Number.isFinite(last) && last > 0 && now - last < RELOAD_GUARD_MS) return false
    storage.setItem(RELOADED_AT_KEY, String(now))
    return true
  } catch {
    return false
  }
}

/**
 * Whether `res` is the Bot Page proxy's 401 for a missing or lapsed sign-in.
 * The proxy answers with problem+json and `error_code: "http_401"`; the app's
 * own 401s are plain JSON, so they still reach the caller as they are.
 */
export async function isSessionExpired(res: Response): Promise<boolean> {
  if (res.status !== 401) return false
  const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase()
  if (type !== "application/problem+json") return false
  try {
    const body: unknown = await res.clone().json()
    return isRecord(body) && body["error_code"] === "http_401"
  } catch {
    return false
  }
}

/** Builds an apiFetch on `guard`. The app uses the one exported below. */
export function createApiFetch(guard: SessionGuard, send: typeof fetch) {
  return async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
    const res = await send(input, init)
    if (await isSessionExpired(res)) {
      guard.expire()
      throw new SessionExpiredError()
    }
    return res
  }
}

let options: ApiFetchOptions = { onSessionExpired: "reload" }

/** Choose what happens when the sign-in runs out. Call it once, in src/main.tsx. */
export function configureApiFetch(next: ApiFetchOptions): void {
  options = next
}

const guard = createSessionGuard(
  {
    reload: () => {
      window.location.reload()
    },
    storage: tabStorage(),
    now: () => Date.now(),
  },
  () => options.onSessionExpired
)

/** fetch() for the app's /api routes. Throws SessionExpiredError for the proxy's 401. */
export const apiFetch = createApiFetch(guard, (input, init) => fetch(input, init))

export const isSessionExpiredNow = guard.isExpired
export const subscribeSessionExpired = guard.subscribe

function tabStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
