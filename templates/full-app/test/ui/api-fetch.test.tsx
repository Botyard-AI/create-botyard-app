import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"
import { SessionExpiredNotice } from "@/components/session-expired-banner"
import {
  createApiFetch,
  createSessionGuard,
  isSessionExpired,
  RELOAD_GUARD_MS,
  SESSION_EXPIRED_MESSAGE,
  SessionExpiredError,
  type GuardBrowser,
  type SessionExpiredMode,
} from "@/lib/api-fetch"

/** The Bot Page proxy's answer to a fetch() once the sign-in has run out. */
function proxy401(): Response {
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "Authentication required",
      instance: "/api/me",
      error_code: "http_401",
      trace_id: "t",
    }),
    { status: 401, headers: { "content-type": "application/problem+json" } }
  )
}

/** A browser with an in-memory sessionStorage and a clock the test moves. */
function fakeBrowser(storage: Map<string, string> | null = new Map()) {
  let now = 1_000_000
  const reload = vi.fn()
  const browser: GuardBrowser = {
    reload,
    storage:
      storage === null
        ? null
        : {
            getItem: (key) => storage.get(key) ?? null,
            setItem: (key, value) => {
              storage.set(key, value)
            },
          },
    now: () => now,
  }
  return {
    browser,
    reload,
    advance(ms: number) {
      now += ms
    },
  }
}

function guarded(mode: SessionExpiredMode, fake = fakeBrowser()) {
  const guard = createSessionGuard(fake.browser, () => mode)
  const shown = vi.fn()
  guard.subscribe(shown)
  return { guard, shown }
}

describe("recognising the proxy's 401", () => {
  test("problem+json with error_code http_401 is the lapsed sign-in", async () => {
    expect(await isSessionExpired(proxy401())).toBe(true)
  })

  test("the app's own 401 is passed through", async () => {
    const own = new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })
    expect(await isSessionExpired(own)).toBe(false)
  })

  test("other statuses, and problem+json without the proxy's code, are not it", async () => {
    const forbidden = new Response("{}", {
      status: 403,
      headers: { "content-type": "application/problem+json" },
    })
    const other = new Response(JSON.stringify({ error_code: "nope" }), {
      status: 401,
      headers: { "content-type": "application/problem+json" },
    })
    const garbled = new Response("not json", {
      status: 401,
      headers: { "content-type": "application/problem+json" },
    })
    expect(await isSessionExpired(forbidden)).toBe(false)
    expect(await isSessionExpired(other)).toBe(false)
    expect(await isSessionExpired(garbled)).toBe(false)
  })

  test("the media type must be exactly application/problem+json; parameters may follow", async () => {
    const body = JSON.stringify({ status: 401, error_code: "http_401" })
    const answer = (type: string) =>
      isSessionExpired(new Response(body, { status: 401, headers: { "content-type": type } }))
    expect(await answer("application/problem+json; charset=utf-8")).toBe(true)
    expect(await answer("Application/Problem+JSON")).toBe(true)
    expect(await answer("application/problem+jsonp")).toBe(false)
    expect(await answer("application/problem+json-seq")).toBe(false)
    expect(await answer("application/json")).toBe(false)
  })
})

describe("apiFetch", () => {
  test("returns every other answer unchanged, including its body", async () => {
    const { guard } = guarded("reload")
    const apiFetch = createApiFetch(guard, () => Promise.resolve(new Response("ok")))
    const res = await apiFetch("/api/me")
    expect(await res.text()).toBe("ok")
    expect(guard.isExpired()).toBe(false)
  })

  test("throws SessionExpiredError for the proxy's 401 and tells the guard", async () => {
    const fake = fakeBrowser()
    const { guard } = guarded("reload", fake)
    const apiFetch = createApiFetch(guard, () => Promise.resolve(proxy401()))
    await expect(apiFetch("/api/me")).rejects.toThrow(SessionExpiredError)
    expect(guard.isExpired()).toBe(true)
    expect(fake.reload).toHaveBeenCalledOnce()
  })

  test("the error's message is what the user should read", () => {
    expect(new SessionExpiredError().message).toBe(SESSION_EXPIRED_MESSAGE)
  })
})

describe("reload mode", () => {
  test("reloads once, however many requests fail together", () => {
    const fake = fakeBrowser()
    const { guard, shown } = guarded("reload", fake)
    guard.expire()
    guard.expire()
    guard.expire()
    expect(fake.reload).toHaveBeenCalledOnce()
    expect(shown).not.toHaveBeenCalled()
  })

  test("falls back to the banner when it already reloaded under a minute ago", () => {
    const storage = new Map<string, string>()
    const first = fakeBrowser(storage)
    guarded("reload", first).guard.expire()
    expect(first.reload).toHaveBeenCalledOnce()

    // The reloaded page shares the tab's sessionStorage and fails again at once.
    const second = fakeBrowser(storage)
    second.advance(5_000)
    const { guard, shown } = guarded("reload", second)
    guard.expire()
    expect(second.reload).not.toHaveBeenCalled()
    expect(shown).toHaveBeenCalledOnce()
    expect(guard.isExpired()).toBe(true)
  })

  test("reloads again once the last reload is over a minute old", () => {
    const storage = new Map<string, string>()
    guarded("reload", fakeBrowser(storage)).guard.expire()

    const later = fakeBrowser(storage)
    later.advance(RELOAD_GUARD_MS + 1)
    guarded("reload", later).guard.expire()
    expect(later.reload).toHaveBeenCalledOnce()
  })

  test("shows the banner when sessionStorage is unavailable, rather than risk a loop", () => {
    const fake = fakeBrowser(null)
    const { guard, shown } = guarded("reload", fake)
    guard.expire()
    expect(fake.reload).not.toHaveBeenCalled()
    expect(shown).toHaveBeenCalledOnce()
  })
})

describe("prompt mode", () => {
  test("never reloads by itself; the banner appears instead", () => {
    const fake = fakeBrowser()
    const { guard, shown } = guarded("prompt", fake)
    guard.expire()
    expect(fake.reload).not.toHaveBeenCalled()
    expect(shown).toHaveBeenCalledOnce()
    expect(guard.isExpired()).toBe(true)
  })

  test("the banner says what happened and offers a Reload button", () => {
    const html = renderToStaticMarkup(<SessionExpiredNotice onReload={() => undefined} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain(SESSION_EXPIRED_MESSAGE)
    expect(html).toContain(">Reload</button>")
  })
})
