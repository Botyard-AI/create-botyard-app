import { createServer, type Server } from "node:http"
import { createBotPage } from "@botyard/botpage"
import { listenLoopback } from "@botyard/botpage/node"
import { createRuntime, type Runtime } from "@botyard/runtime"
import { afterEach, describe, expect, test } from "vitest"
import { orgMembersRoute } from "../server/org-members.ts"
import { asViewer, mockRuntime } from "./helpers.ts"

const servers: Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

/** Serves only GET /api/members, on a free loopback port. */
async function serveMembers(runtime: Runtime = mockRuntime()): Promise<string> {
  const botpage = createBotPage({ tools: runtime, env: {} })
  const server = createServer((req, res) => void orgMembersRoute(botpage)(req, res))
  servers.push(server)
  const { port } = await listenLoopback(server, 0, { botpage })
  return `http://127.0.0.1:${String(port)}/api/members`
}

describe("GET /api/members", () => {
  test("lists the org's members, sorted by name", async () => {
    const res = await fetch(await serveMembers(), asViewer("ada@example.com"))
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({
      members: [
        { userId: "user-ada", name: "Ada Lovelace", email: "ada@example.com", role: "owner" },
        { userId: "user-grace", name: "Grace Hopper", email: "grace@example.com", role: "member" },
      ],
    })
  })

  test("refuses someone outside the org", async () => {
    const res = await fetch(await serveMembers(), asViewer("mallory@example.org"))
    expect(res.status).toBe(403)
  })

  test("refuses an anonymous request", async () => {
    const res = await fetch(await serveMembers())
    expect(res.status).toBe(401)
  })

  test("answers 503 when the directory cannot be read", async () => {
    const down = createRuntime({
      transport: "mock",
      mock: {
        tools: { list_org_members: { error: { kind: "transport", message: "unreachable" } } },
      },
    })
    const res = await fetch(await serveMembers(down), asViewer("ada@example.com"))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: "directory_unavailable" })
  })
})
