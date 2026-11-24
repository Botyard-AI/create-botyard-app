import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, request, type Server } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { createBotPage } from "@botyard/botpage"
import { listenLoopback } from "@botyard/botpage/node"
import { createRuntime } from "@botyard/runtime"
import { afterEach, describe, expect, test } from "vitest"
import { ApprovalStore, approvalRoutes } from "../server/approvals.ts"
import {
  parseApprovalResponse,
  parseApprovalsResponse,
  parseDecidedResponse,
} from "../src/lib/approvals-contract.ts"
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

  test("refuses people outside the org, and anonymous requests", async () => {
    const { as, base } = await serveApprovals()
    expect((await as("mallory@example.org", "POST", "/api/approvals", ASK)).status).toBe(403)
    expect((await fetch(`${base}/api/approvals`)).status).toBe(401)
  })
})

describe("deciding", () => {
  async function asked(count = 1) {
    const served = await serveApprovals()
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const res = await served.as("ada@example.com", "POST", "/api/approvals", {
        ...ASK,
        title: `Request ${String(i + 1)}`,
      })
      ids.push(parseApprovalResponse(await res.json()).request.id)
    }
    /** POST /api/approvals/decide as `who`. */
    const decide = (who: string, decisions: unknown[]) =>
      served.as(who, "POST", "/api/approvals/decide", { decisions })
    /** Every request's status, newest first. */
    const statuses = async () => {
      const res = await served.as("ada@example.com", "GET", "/api/approvals")
      return parseApprovalsResponse(await res.json()).requests.map((r) => r.status)
    }
    return { ...served, ids, decide, statuses }
  }

  test("the approver approves, once, with a note", async () => {
    const { decide, ids } = await asked()
    const id = ids[0]
    const res = await decide("grace@example.com", [{ id, decision: "approve", note: "Go ahead" }])
    expect(res.status).toBe(200)
    const [request] = parseDecidedResponse(await res.json()).requests
    expect(request?.status).toBe("approved")
    expect(request?.history.map((e) => [e.kind, e.by.userId, e.note])).toEqual([
      ["requested", "user-ada", ""],
      ["approved", "user-grace", "Go ahead"],
    ])
    const again = await decide("grace@example.com", [{ id, decision: "reject", note: "" }])
    expect(again.status).toBe(409)
  })

  test("decides several requests at once", async () => {
    const { decide, ids, statuses } = await asked(2)
    const res = await decide("grace@example.com", [
      { id: ids[0], decision: "approve", note: "" },
      { id: ids[1], decision: "reject", note: "Not now" },
    ])
    expect(res.status).toBe(200)
    expect(parseDecidedResponse(await res.json()).requests.map((r) => r.status)).toEqual([
      "approved",
      "rejected",
    ])
    expect(await statuses()).toEqual(["rejected", "approved"])
  })

  test("all or nothing: one refused decision records none", async () => {
    const { decide, ids, statuses } = await asked(2)
    await decide("grace@example.com", [{ id: ids[1], decision: "approve", note: "" }])
    const res = await decide("grace@example.com", [
      { id: ids[0], decision: "approve", note: "" },
      { id: ids[1], decision: "reject", note: "" },
    ])
    expect(res.status).toBe(409)
    expect(await statuses()).toEqual(["approved", "pending"])
  })

  test("refuses an empty list, too many, the same request twice, or a bad decision", async () => {
    const { decide, ids } = await asked()
    const one = { id: ids[0], decision: "approve", note: "" }
    const tooMany = Array.from({ length: 51 }, (_, i) => ({ ...one, id: `r${String(i)}` }))
    expect((await decide("grace@example.com", [])).status).toBe(400)
    expect((await decide("grace@example.com", tooMany)).status).toBe(400)
    expect((await decide("grace@example.com", [one, one])).status).toBe(400)
    expect((await decide("grace@example.com", [{ ...one, decision: "maybe" }])).status).toBe(400)
    expect((await decide("grace@example.com", [{ ...one, id: "nope" }])).status).toBe(404)
  })

  test("nobody else can decide, not even who asked", async () => {
    const { decide, ids } = await asked()
    const res = await decide("ada@example.com", [{ id: ids[0], decision: "approve", note: "" }])
    expect(res.status).toBe(403)
  })

  test("an approver removed from the org is refused, even while the cache still has them", async () => {
    const { decide, ids, org, as, statuses } = await asked()
    // Warm the guard's cache with Grace still in it, then remove her.
    await as("grace@example.com", "GET", "/api/approvals")
    org.members = [ADA]
    const res = await decide("grace@example.com", [{ id: ids[0], decision: "approve", note: "" }])
    expect(res.status).toBe(403)
    expect(await statuses()).toEqual(["pending"])
  })
})

describe("request bodies", () => {
  test("refuses an approver who has just left, even while the cache still has them", async () => {
    const { as, org } = await serveApprovals()
    await as("ada@example.com", "GET", "/api/approvals")
    org.members = [ADA]
    expect((await as("ada@example.com", "POST", "/api/approvals", ASK)).status).toBe(400)
  })

  test("takes exactly application/json, with or without a charset", async () => {
    const { base } = await serveApprovals()
    const post = (type: string) =>
      fetch(`${base}/api/approvals`, {
        method: "POST",
        headers: { ...asViewer("ada@example.com").headers, "content-type": type },
        body: JSON.stringify(ASK),
      })
    expect((await post("application/json; charset=utf-8")).status).toBe(200)
    expect((await post("application/jsonx")).status).toBe(415)
    expect((await post("text/plain")).status).toBe(415)
  })

  test("answers 413 as JSON to a body that keeps streaming past the limit", async () => {
    const { base } = await serveApprovals()
    const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(`${base}/api/approvals`, {
        method: "POST",
        headers: { "x-forwarded-user": "ada@example.com", "content-type": "application/json" },
      })
      req.on("response", (res) => {
        let text = ""
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString()
        })
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: text })
          req.destroy()
        })
      })
      req.on("error", reject)
      // No content-length: keep sending 1 KiB chunks until the server answers.
      const chunk = "x".repeat(1024)
      const pump = (): void => {
        if (req.destroyed) return
        req.write(chunk)
        setImmediate(pump)
      }
      pump()
    })
    expect(answer.status).toBe(413)
    expect(JSON.parse(answer.body)).toEqual({ error: "Request body too large" })
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
        store.put([request])
      }).toThrow()
      expect(store.size).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
