// The UI's client (src/lib/quotes-api.ts) against the real server: the paths,
// queries and bodies it sends are the ones the server routes and parses.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { API } from "../shared/api.ts"
import {
  ApiError,
  call,
  getQuarter,
  getQuote,
  queryString,
  resetDemo,
  saveQuote,
} from "../src/lib/quotes-api.ts"
import { startApp } from "./helpers.ts"

const VIEWER = "ada@example.com"
const realFetch = globalThis.fetch

/** Sends the client's relative URLs to the app, as the viewer, and records them. */
async function serveClient(): Promise<string[]> {
  const base = await startApp()
  const sent: string[] = []
  vi.stubGlobal("fetch", (path: string, init: RequestInit) => {
    sent.push(`${init.method ?? "GET"} ${path}`)
    const headers = new Headers(init.headers)
    headers.set("x-forwarded-user", VIEWER)
    return realFetch(`${base}${path}`, { ...init, headers })
  })
  return sent
}

beforeEach(() => {
  vi.unstubAllGlobals()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the client", () => {
  it("asks for a given quarter, and the server answers for that quarter", async () => {
    const sent = await serveClient()
    const q1 = await call(API.quarter, {
      params: {},
      body: null,
      query: { quarter: "2025-Q1" },
    })
    expect(q1.quarter).toBe("2025-Q1")
    expect(sent).toEqual(["GET /api/quarter?quarter=2025-Q1"])
    expect((await getQuarter(null)).quarter).toBe("2026-Q4")
    expect(sent.at(-1)).toBe("GET /api/quarter")
  })

  it("has a bad quarter refused by the server's parser", async () => {
    await serveClient()
    await expect(getQuarter("next quarter")).rejects.toThrow(ApiError)
  })

  it("fills path parameters and sends bodies", async () => {
    const sent = await serveClient()
    await expect(getQuote("Q-NOPE")).rejects.toMatchObject({ status: 404 })
    expect(sent).toEqual(["GET /api/quotes/Q-NOPE"])
    expect((await resetDemo()).quotes).toBeGreaterThanOrEqual(0)
    expect(sent.at(-1)).toBe("POST /api/reset")
    await expect(
      saveQuote(null, {
        owner_email: null,
        account_id: "nope",
        territory: "Scranton",
        lines: [],
        delivery_option: "standard",
        region: "x",
        terms: "net30",
        order_discount_pct: 0,
        order_discount_reason: "",
      })
    ).rejects.toThrow(ApiError)
    expect(sent.at(-1)).toBe("POST /api/quotes")
  })
})

describe("queryString", () => {
  it("leaves out null values and encodes the rest", () => {
    expect(queryString(null)).toBe("")
    expect(queryString({ quarter: null })).toBe("")
    expect(queryString({ quarter: "2025-Q1", q: "a b&c" })).toBe("?quarter=2025-Q1&q=a+b%26c")
  })
})
