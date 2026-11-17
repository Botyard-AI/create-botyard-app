import { createBotPage } from "@botyard/botpage"
import { describe, expect, it } from "vitest"
import { API } from "../shared/api.ts"
import { approvalRoutes } from "../server/approvals.ts"
import { SettingsStore } from "../server/quotes/settings.ts"
import { noBody } from "../shared/parse.ts"
import { quoteRoutes } from "../server/routes.ts"
import { memoryDesk, mockRuntime } from "./helpers.ts"

describe("the API table", () => {
  it("is served route for route: every entry once, nothing else", () => {
    const tools = mockRuntime()
    const botpage = createBotPage({ tools, env: {} })
    const desk = memoryDesk()
    const served = [
      ...quoteRoutes(desk, { botpage, tools }),
      ...approvalRoutes({ desk, settings: new SettingsStore(), botpage, tools }),
    ].map((r) => `${r.method} ${r.path}`)
    const declared = Object.values(API).map((e) => `${e.method} ${e.path}`)
    expect(new Set(served)).toEqual(new Set(declared))
    expect(new Set(served).size).toBe(served.length)
  })

  it("sends a body exactly when the entry parses one", () => {
    for (const entry of Object.values(API)) {
      expect(entry.sendsBody, `${entry.method} ${entry.path}`).toBe(entry.body !== noBody)
      if (entry.method === "GET") expect(entry.sendsBody).toBe(false)
    }
  })
})
