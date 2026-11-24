import { createServer, type Server } from "node:http"
import { BotPageToolError, createBotPage, type BotPage, type OrgMember } from "@botyard/botpage"
import { listenLoopback } from "@botyard/botpage/node"
import { createRuntime, type Runtime } from "@botyard/runtime"
import { afterEach, describe, expect, test, vi } from "vitest"
import { orgMembersRoute } from "../server/org-members.ts"
import { parseMembersResponse } from "../src/lib/org-members-contract.ts"
import { asViewer, mockRuntime } from "./helpers.ts"

const servers: Server[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) server.close()
})

/** Serves only GET /api/members, on a free loopback port. */
async function serveMembers(runtime: Runtime = mockRuntime()) {
  const botpage = createBotPage({ tools: runtime, env: {} })
  const server = createServer((req, res) => void orgMembersRoute(botpage)(req, res))
  servers.push(server)
  const { port } = await listenLoopback(server, 0, { botpage })
  return { url: `http://127.0.0.1:${String(port)}/api/members`, botpage }
}

/** Makes the route's own read of the list return `members`, after the guard has run. */
function nextListReturns(botpage: BotPage, members: OrgMember[]): void {
  vi.spyOn(botpage.members, "list").mockResolvedValueOnce(members)
}

const grace: OrgMember = {
  userId: "user-grace",
  email: "grace@example.com",
  name: "Grace Hopper",
  role: "member",
  avatarUrl: null,
}

describe("GET /api/members", () => {
  test("lists the org's members, sorted by name", async () => {
    const { url } = await serveMembers()
    const res = await fetch(url, asViewer("ada@example.com"))
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const body: unknown = await res.json()
    expect(body).toEqual({
      members: [
        { userId: "user-ada", name: "Ada Lovelace", email: "ada@example.com", role: "owner" },
        { userId: "user-grace", name: "Grace Hopper", email: "grace@example.com", role: "member" },
      ],
    })
    // What the server sends is what the picker accepts.
    expect(parseMembersResponse(body)).toEqual(body)
  })

  test("refuses someone outside the org", async () => {
    const { url } = await serveMembers()
    expect((await fetch(url, asViewer("mallory@example.org"))).status).toBe(403)
  })

  test("refuses an anonymous request", async () => {
    expect((await fetch((await serveMembers()).url)).status).toBe(401)
  })

  test("answers 503 when the guard cannot read the directory", async () => {
    const down = createRuntime({
      transport: "mock",
      mock: { tools: { list_org_members: { error: { kind: "transport", message: "down" } } } },
    })
    const res = await fetch((await serveMembers(down)).url, asViewer("ada@example.com"))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: "directory_unavailable" })
  })
})

// The guard reads the cached list, then the route reads it again. A refresh
// can land in between, so the route checks the viewer against what it sends.
describe("GET /api/members, when the list changes after the guard", () => {
  test("sends the newer list to a viewer who is still in it", async () => {
    const { url, botpage } = await serveMembers()
    const ada = await botpage.members.lookup("user-ada")
    if (ada === null) throw new Error("fixture has no user-ada")
    nextListReturns(botpage, [ada, { ...grace, name: "Grace B. Hopper" }])
    const res = await fetch(url, asViewer("ada@example.com"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ members: [{}, { name: "Grace B. Hopper" }] })
  })

  test("refuses a viewer the newer list no longer has", async () => {
    const { url, botpage } = await serveMembers()
    await botpage.members.list()
    nextListReturns(botpage, [grace])
    const res = await fetch(url, asViewer("ada@example.com"))
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain("grace@example.com")
  })

  test("answers 503 when the route's own read fails", async () => {
    const { url, botpage } = await serveMembers()
    await botpage.members.list()
    vi.spyOn(botpage.members, "list").mockRejectedValueOnce(
      new BotPageToolError("list_org_members", "down")
    )
    const res = await fetch(url, asViewer("ada@example.com"))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: "directory_unavailable" })
  })
})
