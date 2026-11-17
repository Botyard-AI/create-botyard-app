import { describe, expect, test } from "vitest"
import { asViewer, startApp } from "./helpers.ts"

const ADA = "ada@example.com"

const BODY = {
  account_id: "ACC-1001",
  territory: "Scranton",
  region: "Northeast",
  delivery_option: "STD",
  terms: "NET60",
  lines: [{ sku: "PPR-A4-80", qty: 100 }],
  order_discount_pct: 8,
  order_discount_reason: "competitor match",
}

function send(viewer: string, method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "x-forwarded-user": viewer, "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  }
}

async function json(res: Response): Promise<Record<string, unknown>> {
  const body: unknown = await res.json()
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new Error("not an object")
  return Object.fromEntries(Object.entries(body))
}

describe("quotes API", () => {
  test("the viewer owns a new quote and is its author, whatever the body claims", async () => {
    const base = await startApp()
    const res = await fetch(
      `${base}/api/quotes`,
      send(ADA, "POST", { ...BODY, by: "Someone Else", owner: "Mallory" })
    )
    expect(res.status).toBe(201)
    const q = await json(res)
    expect(q["owner"]).toEqual({ name: "Ada Lovelace", email: ADA })
    expect(q["events"]).toEqual([
      expect.objectContaining({ type: "created", by: "Ada Lovelace", on_behalf_of: null }),
    ])
  })

  test("an owner can be any org member, looked up through the platform", async () => {
    const base = await startApp()
    const res = await fetch(
      `${base}/api/quotes`,
      send(ADA, "POST", { ...BODY, owner_email: "GRACE@example.com" })
    )
    expect(res.status).toBe(201)
    expect((await json(res))["owner"]).toEqual({ name: "Grace Hopper", email: "grace@example.com" })
  })

  test("an owner from outside the org is refused", async () => {
    const base = await startApp()
    const res = await fetch(
      `${base}/api/quotes`,
      send(ADA, "POST", { ...BODY, owner_email: "mallory@example.org" })
    )
    expect(res.status).toBe(400)
    expect(await json(res)).toEqual({ error: "mallory@example.org is not a member of this org" })
  })

  test("editing a draft keeps its owner unless a new one is picked", async () => {
    const base = await startApp()
    const kept = await fetch(`${base}/api/quotes/Q-2026-0201`, send(ADA, "PUT", BODY))
    expect(kept.status).toBe(200)
    const q = await json(kept)
    expect(q["owner"]).toEqual({ name: "Jim Halpert", email: null })
    expect(q["events"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "edited", by: "Ada Lovelace" })])
    )
    const moved = await fetch(
      `${base}/api/quotes/Q-2026-0201`,
      send(ADA, "PUT", { ...BODY, owner_email: "grace@example.com" })
    )
    expect((await json(moved))["owner"]).toEqual({
      name: "Grace Hopper",
      email: "grace@example.com",
    })
  })

  test("preview, create, submit, read back", async () => {
    const base = await startApp()
    const preview = await json(await fetch(`${base}/api/preview`, send(ADA, "POST", BODY)))
    expect(preview["margin_pct"]).toBe(24.3)

    const created = await json(await fetch(`${base}/api/quotes`, send(ADA, "POST", BODY)))
    const id = String(created["id"])
    const submitted = await fetch(`${base}/api/quotes/${id}/submit`, send(ADA, "POST"))
    expect(submitted.status).toBe(200)
    expect((await json(submitted))["status"]).toBe("finance_review")

    const list = await json(await fetch(`${base}/api/quotes`, asViewer(ADA)))
    expect(list["quotes"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, status: "finance_review" })])
    )
    expect(
      (await json(await fetch(`${base}/api/quotes/${id}`, asViewer(ADA))))["pricing"]
    ).toMatchObject({ total_eur: 1921.8 })
  })

  test("the member list comes from the platform", async () => {
    const base = await startApp()
    expect(await json(await fetch(`${base}/api/members`, asViewer(ADA)))).toEqual({
      members: [
        { user_id: "user-ada", name: "Ada Lovelace", email: ADA },
        { user_id: "user-grace", name: "Grace Hopper", email: "grace@example.com" },
      ],
    })
  })

  test("quarter close", async () => {
    const base = await startApp()
    const q = await json(await fetch(`${base}/api/quarter`, asViewer(ADA)))
    expect(q["quarter"]).toBe("2026-Q4")
    expect(await fetch(`${base}/api/quarter?quarter=nope`, asViewer(ADA))).toHaveProperty(
      "status",
      400
    )
  })

  test.each([
    ["an unknown quote", "GET", "/api/quotes/Q-2026-9999", undefined, 404],
    ["a bad body", "POST", "/api/quotes", { ...BODY, lines: "lots" }, 400],
    ["a domain refusal", "POST", "/api/quotes/Q-2026-0200/submit", undefined, 409],
    ["a wrong method", "DELETE", "/api/quotes/Q-2026-0200", undefined, 405],
    ["an odd path segment", "GET", "/api/quotes/%2e%2e", undefined, 404],
  ])("answers %s with JSON", async (_name, method, path, body, status) => {
    const base = await startApp()
    const res = await fetch(`${base}${path}`, send(ADA, method, body))
    expect(res.status).toBe(status)
    expect(typeof (await json(res))["error"]).toBe("string")
  })

  test("refuses a body that is too large or not JSON", async () => {
    const base = await startApp()
    const big = await fetch(
      `${base}/api/preview`,
      send(ADA, "POST", { ...BODY, pad: "x".repeat(70_000) })
    )
    expect(big.status).toBe(413)
    const text = await fetch(`${base}/api/preview`, {
      method: "POST",
      headers: { "x-forwarded-user": ADA, "content-type": "text/plain" },
      body: "hello",
    })
    expect(text.status).toBe(415)
  })

  test("nothing about quotes is served to someone outside the org", async () => {
    const base = await startApp()
    for (const path of ["/api/quotes", "/api/quotes/Q-2026-0200", "/api/members", "/api/quarter"]) {
      expect((await fetch(`${base}${path}`, asViewer("mallory@example.org"))).status).toBe(403)
    }
    expect((await fetch(`${base}/api/reset`, send("mallory@example.org", "POST"))).status).toBe(403)
  })
})
