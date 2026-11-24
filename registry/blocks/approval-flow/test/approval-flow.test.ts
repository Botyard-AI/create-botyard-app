import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { createBotPage } from "@botyard/botpage"
import { listenLoopback } from "@botyard/botpage/node"
import { createRuntime } from "@botyard/runtime"
import { afterEach, describe, expect, test } from "vitest"
import { ApprovalStore, approvalRoutes } from "../server/approvals.ts"
import { parseApprovalResponse, parseApprovalsResponse } from "../src/lib/approvals-contract.ts"
import { asViewer } from "./helpers.ts"

const ADA = {
  user_id: "user-ada",
  role_id: "owner",
  user: { email: "ada@example.com", name: "Ada" },
}
const GRACE = {
  user_id: "user-grace",
  role_id: "member",
  user: { email: "grace@example.com", name: "Grace" },
}

const servers: Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

/** Serves the approval routes. `org` is the member list; change it to add or remove people. */
async function serveApprovals(store = new ApprovalStore(null)) {
  const org = { members: [ADA, GRACE] }
  const tools = createRuntime({
    transport: "mock",
    mock: {
      tools: { list_org_members: () => ({ total: org.members.length, members: org.members }) },
    },
  })
  const botpage = createBotPage({ tools, env: {} })
  const routes = approvalRoutes({ botpage, tools, store })
  const server = createServer((req, res) => {
    const route = routes[`${req.method ?? ""} ${req.url ?? ""}`]
    if (route === undefined) res.writeHead(404).end()
    else void route(req, res)
  })
  servers.push(server)
  const { port } = await listenLoopback(server, 0, { botpage })
  const base = `http://127.0.0.1:${String(port)}`

  /** Sends a request as `who` (an email the Bot Page proxy would forward). */
  const as = (who: string, method: string, url: string, body?: unknown) => {
    const init = asViewer(who)
    return fetch(`${base}${url}`, {
      method,
      headers: { ...init.headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
  return { org, as, base }
}

const ASK = { title: "Buy a 3D printer", details: "For the lab", approverId: "user-grace" }

describe("asking for approval", () => {
  test("a member asks another member", async () => {
    const { as } = await serveApprovals()
    const res = await as("ada@example.com", "POST", "/api/approvals", ASK)
    expect(res.status).toBe(200)
    const { request } = parseApprovalResponse(await res.json())
    expect(request).toMatchObject({
      title: "Buy a 3D printer",
      status: "pending",
      requestedBy: { userId: "user-ada", name: "Ada" },
      approver: { userId: "user-grace", name: "Grace" },
      history: [{ kind: "requested", by: { userId: "user-ada" } }],
    })
  })

  test("everyone in the org sees the requests, newest first", async () => {
    const { as } = await serveApprovals()
    await as("ada@example.com", "POST", "/api/approvals", ASK)
    await as("ada@example.com", "POST", "/api/approvals", { ...ASK, title: "Second" })
    const res = await as("grace@example.com", "GET", "/api/approvals")
    const body = parseApprovalsResponse(await res.json())
    expect(body.me).toBe("user-grace")
    expect(body.requests.map((r) => r.title)).toEqual(["Second", "Buy a 3D printer"])
  })

  test("refuses asking yourself, a non-member, or a bad body", async () => {
    const { as } = await serveApprovals()
    const self = await as("ada@example.com", "POST", "/api/approvals", {
      ...ASK,
      approverId: "user-ada",
    })
    expect(self.status).toBe(400)
    const stranger = await as("ada@example.com", "POST", "/api/approvals", {
      ...ASK,
      approverId: "user-mallory",
    })
    expect(stranger.status).toBe(400)
    const noTitle = await as("ada@example.com", "POST", "/api/approvals", { ...ASK, title: " " })
    expect(noTitle.status).toBe(400)
    const tooLong = await as("ada@example.com", "POST", "/api/approvals", {
      ...ASK,
      title: "x".repeat(201),
    })
    expect(tooLong.status).toBe(400)
  })

  test("only takes JSON, so other sites' forms cannot post", async () => {
    const { base } = await serveApprovals()
    const res = await fetch(`${base}/api/approvals`, {
      method: "POST",
      headers: { ...asViewer("ada@example.com").headers, "content-type": "text/plain" },
      body: JSON.stringify(ASK),
    })
    expect(res.status).toBe(415)
  })

  test("refuses people outside the org, and anonymous requests", async () => {
    const { as, base } = await serveApprovals()
    expect((await as("mallory@example.org", "POST", "/api/approvals", ASK)).status).toBe(403)
    expect((await fetch(`${base}/api/approvals`)).status).toBe(401)
  })
})

describe("deciding", () => {
  async function asked() {
    const served = await serveApprovals()
    const res = await served.as("ada@example.com", "POST", "/api/approvals", ASK)
    const { request } = parseApprovalResponse(await res.json())
    return { ...served, id: request.id }
  }

  test("the approver approves, once, with a note", async () => {
    const { as, id } = await asked()
    const res = await as("grace@example.com", "POST", "/api/approvals/decide", {
      id,
      decision: "approve",
      note: "Go ahead",
    })
    expect(res.status).toBe(200)
    const { request } = parseApprovalResponse(await res.json())
    expect(request.status).toBe("approved")
    expect(request.history.map((e) => [e.kind, e.by.userId, e.note])).toEqual([
      ["requested", "user-ada", ""],
      ["approved", "user-grace", "Go ahead"],
    ])
    const again = await as("grace@example.com", "POST", "/api/approvals/decide", {
      id,
      decision: "reject",
      note: "",
    })
    expect(again.status).toBe(409)
  })

  test("nobody else can decide, not even who asked", async () => {
    const { as, id } = await asked()
    const res = await as("ada@example.com", "POST", "/api/approvals/decide", {
      id,
      decision: "approve",
      note: "",
    })
    expect(res.status).toBe(403)
  })

  test("an approver removed from the org is refused, even while the cache still has them", async () => {
    const { as, id, org } = await asked()
    // Warm the guard's cache with Grace still in it, then remove her.
    await as("grace@example.com", "GET", "/api/approvals")
    org.members = [ADA]
    const res = await as("grace@example.com", "POST", "/api/approvals/decide", {
      id,
      decision: "approve",
      note: "",
    })
    expect(res.status).toBe(403)
    const list = parseApprovalsResponse(
      await (await as("ada@example.com", "GET", "/api/approvals")).json()
    )
    expect(list.requests[0]?.status).toBe("pending")
  })

  test("an unknown request or decision", async () => {
    const { as, id } = await asked()
    const unknown = await as("grace@example.com", "POST", "/api/approvals/decide", {
      id: "nope",
      decision: "approve",
      note: "",
    })
    expect(unknown.status).toBe(404)
    const bad = await as("grace@example.com", "POST", "/api/approvals/decide", {
      id,
      decision: "maybe",
      note: "",
    })
    expect(bad.status).toBe(400)
  })
})

describe("ApprovalStore", () => {
  test("keeps requests in its file across restarts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "approvals-"))
    try {
      const file = path.join(dir, "data", "approvals.json")
      const { as } = await serveApprovals(new ApprovalStore(file))
      await as("ada@example.com", "POST", "/api/approvals", ASK)
      const reopened = new ApprovalStore(file)
      expect(reopened.list().map((r) => r.title)).toEqual(["Buy a 3D printer"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses to start on a file it cannot read, rather than replace it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "approvals-"))
    try {
      const file = path.join(dir, "approvals.json")
      await writeFile(file, '[{"id": 1}]')
      expect(() => new ApprovalStore(file)).toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a request that cannot be saved is not kept in memory either", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "approvals-"))
    try {
      const data = path.join(dir, "data")
      const store = new ApprovalStore(path.join(data, "approvals.json"))
      // Put a file where the data directory goes, so saving fails.
      await writeFile(data, "")
      const request = {
        id: "r1",
        title: "t",
        details: "",
        requestedBy: { userId: "a", name: "A" },
        approver: { userId: "b", name: "B" },
        status: "pending" as const,
        history: [],
      }
      expect(() => {
        store.put(request)
      }).toThrow()
      expect(store.size).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
