import { describe, expect, test } from "vitest"
import type { Runtime } from "@botyard/runtime"
import { EMPTY_SETTINGS, SettingsStore } from "../server/quotes/settings.ts"
import { HandoffStore } from "../server/review/handoffs.ts"
import { NOT_SET_UP, ReviewRelay } from "../server/review/relay.ts"
import type { DeskSettings } from "../shared/types.ts"
import { asViewer, memoryDesk, mockRuntime, startApp } from "./helpers.ts"

const ADA = "ada@example.com" // owner in fixtures/dev.json
const GRACE = "grace@example.com" // member

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

const CONFIGURED: DeskSettings = {
  reviewer_bot: "reviewer-bot",
  review_board: null,
  handoff_thread: null,
  approvers: { finance: ["user-grace"], business: ["user-ada"] },
}

describe("approver settings", () => {
  test("start empty; owners and admins may edit them", async () => {
    const base = await startApp()
    expect(await json(await fetch(`${base}/api/settings`, asViewer(ADA)))).toEqual({
      settings: EMPTY_SETTINGS,
      can_edit: true,
      my_roles: [],
      people: [],
    })
    expect(await json(await fetch(`${base}/api/settings`, asViewer(GRACE)))).toMatchObject({
      can_edit: false,
    })
  })

  test("a member who is not an owner or admin cannot change them", async () => {
    const base = await startApp()
    const res = await fetch(`${base}/api/settings`, send(GRACE, "PUT", CONFIGURED))
    expect(res.status).toBe(403)
  })

  test("an owner saves them; the viewer's roles and the approvers' names show up", async () => {
    const saved: DeskSettings[] = []
    const settings = new SettingsStore({ save: (s) => saved.push(s) })
    const base = await startApp({ settings })
    const res = await fetch(`${base}/api/settings`, send(ADA, "PUT", CONFIGURED))
    expect(await json(res)).toEqual(CONFIGURED)
    expect(saved).toEqual([CONFIGURED])
    expect(await json(await fetch(`${base}/api/settings`, asViewer(GRACE)))).toMatchObject({
      my_roles: ["finance"],
      people: [
        { user_id: "user-ada", name: "Ada Lovelace", email: ADA },
        { user_id: "user-grace", name: "Grace Hopper", email: GRACE },
      ],
    })
  })

  test.each([
    [
      "an unknown bot",
      { ...CONFIGURED, reviewer_bot: "nobody" },
      "nobody is not a bot in this org",
    ],
    [
      "an approver outside the org",
      { ...CONFIGURED, approvers: { finance: ["user-mallory"], business: [] } },
      "user-mallory is not a member of this org",
    ],
    [
      "the same approver twice",
      { ...CONFIGURED, approvers: { finance: ["user-grace", "user-grace"], business: [] } },
      "body.approvers.finance: user-grace is listed twice",
    ],
    [
      "a bad slug",
      { ...CONFIGURED, reviewer_bot: "Not A Slug" },
      "body.reviewer_bot: not a bot slug",
    ],
  ])("refuses %s", async (_name, body, error) => {
    const base = await startApp()
    const res = await fetch(`${base}/api/settings`, send(ADA, "PUT", body))
    expect(res.status).toBe(400)
    expect(await json(res)).toEqual({ error })
  })

  test("the org's bots are listed for the reviewer picker", async () => {
    const base = await startApp()
    expect(await json(await fetch(`${base}/api/bots`, asViewer(GRACE)))).toEqual({
      bots: [
        { id: "bot-reviewer", slug: "reviewer-bot", name: "Reviewer Bot" },
        { id: "bot-helper", slug: "helper-bot", name: "Helper Bot" },
      ],
    })
  })

  test("a failed save keeps the old settings", () => {
    const settings = new SettingsStore({
      save: () => {
        throw new Error("disk full")
      },
    })
    expect(() => settings.set(CONFIGURED)).toThrow("disk full")
    expect(settings.get().approvers.finance).toEqual([])
  })
})

describe("decisions", () => {
  async function submitted() {
    const desk = memoryDesk()
    const settings = new SettingsStore({ settings: CONFIGURED })
    const tools = mockRuntime()
    const relay = new ReviewRelay({
      desk,
      settings,
      handoffs: new HandoffStore(),
      tools,
      fileHosts: new Set(),
    })
    const base = await startApp({ desk, settings, tools, relay })
    // Q-2026-0200 is seeded in finance review.
    return { desk, base, relay, id: "Q-2026-0200" }
  }

  test("only a configured approver may decide for a role", async () => {
    const { base, id } = await submitted()
    const body = { role: "finance", decision: "approve", note: "ok" }
    const refused = await fetch(`${base}/api/quotes/${id}/decide`, send(ADA, "POST", body))
    expect(refused.status).toBe(403)
    expect(await json(refused)).toEqual({ error: "You are not a finance approver" })

    const ok = await fetch(`${base}/api/quotes/${id}/decide`, send(GRACE, "POST", body))
    expect(ok.status).toBe(200)
    expect((await json(ok))["approvals"]).toMatchObject({
      finance: { decision: "approve", note: "ok", by: "Grace Hopper" },
    })
  })

  test("finance records the reviewer bot's step, whatever its handoff; nobody else does", async () => {
    const { base, id, relay } = await submitted()
    await relay.tick() // no board in CONFIGURED: no recommendation is coming
    const handoff = await json(await fetch(`${base}/api/quotes/${id}/handoff`, asViewer(ADA)))
    expect(handoff).toMatchObject({ handoff: { kind: "manual", reason: NOT_SET_UP } })

    const body = { role: "bot_review", decision: "approve", note: "Checked by hand" }
    const business = await fetch(`${base}/api/quotes/${id}/decide`, send(ADA, "POST", body))
    expect(business.status).toBe(403)
    const finance = await fetch(`${base}/api/quotes/${id}/decide`, send(GRACE, "POST", body))
    expect(finance.status).toBe(200)
    expect((await json(finance))["approvals"]).toMatchObject({
      bot_review: { decision: "approve", by: "Grace Hopper, for the reviewer bot" },
    })
  })

  test("a business approver waits for finance", async () => {
    const { base, id } = await submitted()
    const res = await fetch(
      `${base}/api/quotes/${id}/decide`,
      send(ADA, "POST", { role: "business", decision: "approve", note: "" })
    )
    expect(res.status).toBe(409)
  })

  test("finance and then business take a quote to approved", async () => {
    const { desk, base, id } = await submitted()
    desk.decide(id, "bot_review", "approve", "fine", "Reviewer (bot)")
    const decide = (viewer: string, role: string) =>
      fetch(
        `${base}/api/quotes/${id}/decide`,
        send(viewer, "POST", { role, decision: "approve", note: "" })
      )
    expect((await json(await decide(GRACE, "finance")))["status"]).toBe("business_review")
    expect((await json(await decide(ADA, "business")))["status"]).toBe("approved")
  })

  test("requesting changes sends the quote back to draft", async () => {
    const { base, id } = await submitted()
    const res = await fetch(
      `${base}/api/quotes/${id}/decide`,
      send(GRACE, "POST", { role: "finance", decision: "reject", note: "Net 45, please." })
    )
    expect((await json(res))["status"]).toBe("draft")
  })

  test("any member may comment; the author is the viewer", async () => {
    const { base, id } = await submitted()
    const res = await fetch(
      `${base}/api/quotes/${id}/comments`,
      send(GRACE, "POST", { text: "Customer called.", by: "Someone Else" })
    )
    expect(res.status).toBe(200)
    expect((await json(res))["events"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "comment", by: "Grace Hopper", note: "Customer called." }),
      ])
    )
  })

  test("outsiders get nothing", async () => {
    const { base, id } = await submitted()
    for (const [method, path] of [
      ["GET", "/api/settings"],
      ["GET", "/api/bots"],
      ["POST", `/api/quotes/${id}/decide`],
      ["POST", `/api/quotes/${id}/comments`],
    ] as const) {
      const body = method === "GET" ? undefined : {}
      const res = await fetch(`${base}${path}`, send("mallory@example.org", method, body))
      expect(res.status).toBe(403)
    }
  })
})

/**
 * The mock runtime with a directory that changes after `after` reads of
 * list_org_members: Grace is then no longer a member, and Ada is demoted.
 */
function changingDirectory(after: number): { runtime: Runtime; reads: () => number } {
  let reads = 0
  const member = (id: string, email: string, name: string, role: string) => ({
    user_id: id,
    role_id: role,
    user: { user_id: id, email, name },
  })
  const runtime = mockRuntime({
    list_org_members: () => {
      reads += 1
      const changed = reads > after
      const members = [
        member("user-ada", ADA, "Ada Lovelace", changed ? "member" : "owner"),
        ...(changed ? [] : [member("user-grace", GRACE, "Grace Hopper", "member")]),
      ]
      return { total: members.length, members }
    },
  })
  return { runtime, reads: () => reads }
}

/**
 * An app with the production member cache (MEMBER_CACHE) whose directory
 * changes right after the first listing, the one the route's guard reads and
 * caches for 30 s.
 */
async function changesAfterGuard(
  settings: SettingsStore
): Promise<{ base: string; reads: () => number }> {
  const dir = changingDirectory(1)
  return { base: await startApp({ settings, tools: dir.runtime }), reads: dir.reads }
}

describe("authority is checked again just before a change", () => {
  test("a member removed while the request waits cannot decide", async () => {
    const settings = new SettingsStore({ settings: CONFIGURED })
    // The guard lets Grace in from the cached listing; by the final check she is gone.
    const { base, reads } = await changesAfterGuard(settings)
    const res = await fetch(
      `${base}/api/quotes/Q-2026-0200/decide`,
      send(GRACE, "POST", { role: "finance", decision: "approve", note: "" })
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "You are no longer a member of this org" })
    // The cache still lets her read: only the change was refused, by the fresh listing.
    expect((await fetch(`${base}/api/quotes`, asViewer(GRACE))).status).toBe(200)
    expect(reads()).toBe(2)
  })

  test("an owner demoted while the request waits cannot change the settings", async () => {
    const saved: DeskSettings[] = []
    const settings = new SettingsStore({ save: (s) => saved.push(s) })
    const { base } = await changesAfterGuard(settings)
    const res = await fetch(
      `${base}/api/settings`,
      send(ADA, "PUT", { ...CONFIGURED, approvers: { finance: [], business: ["user-ada"] } })
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "Your org role no longer allows this" })
    expect(saved).toEqual([])
  })

  test("a directory that cannot be read refuses the change", async () => {
    let reads = 0
    const runtime = mockRuntime({
      list_org_members: () => {
        reads += 1
        if (reads > 1) throw new Error("directory down")
        return {
          total: 1,
          members: [
            {
              user_id: "user-grace",
              role_id: "member",
              user: { user_id: "user-grace", email: GRACE, name: "Grace Hopper" },
            },
          ],
        }
      },
    })
    const settings = new SettingsStore({ settings: CONFIGURED })
    const base = await startApp({ settings, tools: runtime })
    const res = await fetch(
      `${base}/api/quotes/Q-2026-0200/decide`,
      send(GRACE, "POST", { role: "finance", decision: "approve", note: "" })
    )
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: "directory_unavailable" })
  })

  test("authority follows the member id, not the email", () => {
    const settings = new SettingsStore({ settings: CONFIGURED })
    expect(settings.rolesOf("user-grace")).toEqual(["finance"])
    // Someone else who now holds Grace's old address gets nothing.
    expect(settings.rolesOf("user-new-hire")).toEqual([])
  })
})
