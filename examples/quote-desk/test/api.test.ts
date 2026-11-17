import { createBotPage } from "@botyard/botpage"
import { describe, expect, it } from "vitest"
import { API } from "../shared/api.ts"
import { quoteRoutes } from "../server/routes.ts"
import { memoryDesk, mockRuntime } from "./helpers.ts"

describe("the API table", () => {
  it("is served route for route: every entry once, nothing else", () => {
    const botpage = createBotPage({ tools: mockRuntime(), env: {} })
    const served = quoteRoutes(memoryDesk(), botpage).map((r) => `${r.method} ${r.path}`)
    const declared = Object.values(API).map((e) => `${e.method} ${e.path}`)
    expect(new Set(served)).toEqual(new Set(declared))
    expect(new Set(served).size).toBe(served.length)
  })
})
