import { createBotPage } from "@botyard/botpage"
import { describe, expect, it } from "vitest"
import { API } from "../shared/api.ts"
import { tableRoutes } from "../server/app.ts"
import { SettingsStore } from "../server/quotes/settings.ts"
import { HandoffStore } from "../server/review/handoffs.ts"
import { ReviewRelay } from "../server/review/relay.ts"
import { noBody } from "../shared/parse.ts"
import { memoryDesk, mockRuntime } from "./helpers.ts"

describe("the API table", () => {
  it("is served route for route: every entry once, nothing else", () => {
    const tools = mockRuntime()
    const botpage = createBotPage({ tools, env: {} })
    const desk = memoryDesk()
    const settings = new SettingsStore()
    const fileHosts = new Set<string>()
    const relay = new ReviewRelay({
      desk,
      settings,
      handoffs: new HandoffStore(),
      tools,
      fileHosts,
    })
    const served = tableRoutes({ botpage, tools, desk, settings, relay, fileHosts }).map(
      (r) => `${r.method} ${r.path}`
    )
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
