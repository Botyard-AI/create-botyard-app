import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { PricingSummary } from "@/components/pricing-summary"
import { href, parseRoute } from "@/lib/route"
import { shownPricing, toInput, type Draft, type PricingResult } from "@/features/build/use-draft"
import { pricing } from "./fixtures.ts"

describe("live pricing", () => {
  test("shows both finance flags and the discount line", () => {
    const html = renderToStaticMarkup(<PricingSummary p={pricing} />)
    expect(html).toContain("Finance will look closely")
    expect(html).toContain("margin 24.3% is below the 25% floor")
    expect(html).toContain("discount 14.3% is above the 10% escalation level")
    expect(html).toContain("Order discount · 8%")
  })

  test("says when everything passes", () => {
    const html = renderToStaticMarkup(<PricingSummary p={{ ...pricing, flags: [] }} />)
    expect(html).toContain("Inside the rules")
  })
})

describe("routes", () => {
  test.each([
    ["/", { tab: "build", quoteId: null }],
    ["/build/Q-2026-0202", { tab: "build", quoteId: "Q-2026-0202" }],
    ["/quotes", { tab: "quotes", quoteId: null }],
    ["/quotes/Q-2026-0202/", { tab: "quotes", quoteId: "Q-2026-0202" }],
    ["/quarter", { tab: "quarter" }],
    ["/settings", { tab: "settings" }],
    ["/quotes/../etc", { tab: "build", quoteId: null }],
  ])("%s", (path, route) => {
    expect(parseRoute(path)).toEqual(route)
  })

  test("href round-trips", () => {
    expect(href({ tab: "quotes", quoteId: "Q-2026-0202" })).toBe("/quotes/Q-2026-0202")
    expect(href({ tab: "quarter" })).toBe("/quarter")
  })
})

describe("draft input", () => {
  const draft: Draft = {
    ownerEmail: null,
    accountId: "ACC-1001",
    territory: "Scranton",
    region: "Northeast",
    deliveryOption: "STD",
    terms: "NET60",
    lines: [{ sku: "PPR-A4-80", qty: "100", unit: "" }],
    discount: "8",
    reason: "competitor match",
  }

  test("becomes the API body", () => {
    expect(toInput(draft)).toMatchObject({
      lines: [{ sku: "PPR-A4-80", qty: 100, unit_price_eur: null }],
      order_discount_pct: 8,
    })
  })

  test.each([
    [{ lines: [{ sku: "A", qty: "1.5", unit: "" }] }, /whole numbers/],
    [{ lines: [{ sku: "A", qty: "1", unit: "abc" }] }, /Unit prices/],
    [{ discount: "60" }, /between 0% and 50%/],
  ])("explains what to fix %#", (patch, message) => {
    expect(toInput({ ...draft, ...patch })).toMatch(message)
  })
})

describe("shown pricing", () => {
  const draft: Draft = {
    ownerEmail: null,
    accountId: "ACC-1001",
    territory: "Scranton",
    region: "Northeast",
    deliveryOption: "STD",
    terms: "NET60",
    lines: [{ sku: "PPR-A4-80", qty: "100", unit: "" }],
    discount: "8",
    reason: "competitor match",
  }
  const quoteInput = (d: Draft) => {
    const input = toInput(d)
    if (typeof input === "string") throw new Error(input)
    return input
  }
  const input = quoteInput(draft)
  const edited = quoteInput({ ...draft, lines: [{ sku: "PPR-A4-80", qty: "120", unit: "" }] })
  const ready: PricingResult = { input, live: { state: "ready", pricing } }

  test("the answer for this input", () => {
    expect(shownPricing(input, ready)).toBe(ready.live)
  })

  test("the last prices while an edit is priced", () => {
    expect(shownPricing(edited, ready)).toBe(ready.live)
  })

  test("loading after an error, or with no answer yet (as for a refilled cart)", () => {
    const failed: PricingResult = { input, live: { state: "error", message: "down" } }
    expect(shownPricing(edited, failed)).toEqual({ state: "loading" })
    expect(shownPricing(edited, null)).toEqual({ state: "loading" })
  })

  test("empty and invalid drafts ignore the last answer", () => {
    expect(shownPricing(quoteInput({ ...draft, lines: [] }), ready)).toEqual({ state: "empty" })
    expect(shownPricing("Fix this.", ready)).toEqual({ state: "error", message: "Fix this." })
  })
})
