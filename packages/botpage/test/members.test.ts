import assert from "node:assert/strict"
import { test } from "vitest"

import { BotPageToolError, MemberDirectory, parseMember } from "../src/index.ts"
import { fakeTools, membersHandler } from "./fakes.ts"

test("parseMember reads the list_org_members shape", () => {
  assert.deepEqual(
    parseMember({
      user_id: "u1",
      role_id: "owner",
      user: { user_id: "u1", email: "a@b.io", name: "A" },
    }),
    { userId: "u1", email: "a@b.io", name: "A", role: "owner", avatarUrl: null }
  )
  assert.equal(parseMember({ role_id: "owner", user: {} }), null)
  assert.equal(parseMember("nope"), null)
})

test("lookup by email is case-insensitive, and by user id", async () => {
  const directory = new MemberDirectory(fakeTools())
  assert.equal((await directory.lookup("jakob@botyard.io"))?.userId, "u-jakob")
  assert.equal((await directory.lookup("u-vera"))?.name, "Vera")
  assert.equal(await directory.lookup("stranger@botyard.io"), null)
})

test("the member list is cached for the TTL and shared by concurrent lookups", async () => {
  let now = 0
  const tools = fakeTools()
  const directory = new MemberDirectory(tools, { ttlMs: 1000, now: () => now })
  await Promise.all([directory.lookup("a"), directory.lookup("b"), directory.lookup("c")])
  assert.equal(tools.count("list_org_members"), 1)
  now = 999
  await directory.lookup("unknown-subject")
  assert.equal(tools.count("list_org_members"), 1, "an unknown subject must not force a refetch")
  now = 1000
  await directory.lookup("a")
  assert.equal(tools.count("list_org_members"), 2)
})

test("paginates until a short page", async () => {
  const many = Array.from({ length: 5 }, (_, i) => ({
    user_id: `u${i}`,
    role_id: "member",
    user: { email: `u${i}@x.io` },
  }))
  const tools = fakeTools().on("list_org_members", membersHandler(many))
  const directory = new MemberDirectory(tools, { pageSize: 2 })
  assert.equal((await directory.list()).length, 5)
  assert.deepEqual(
    tools.calls.map((call) => call.args),
    [
      { limit: 2, offset: 0 },
      { limit: 2, offset: 2 },
      { limit: 2, offset: 4 },
    ]
  )
})

test("serves stale data with backoff when a refresh fails", async () => {
  let now = 0
  let fail = false
  const tools = fakeTools()
  const ok = membersHandler()
  tools.on("list_org_members", (args) => {
    if (fail) throw new Error("platform down")
    return ok(args)
  })
  const directory = new MemberDirectory(tools, { ttlMs: 1000, retryAfterMs: 100, now: () => now })
  await directory.lookup("u-jakob")
  fail = true
  now = 2000
  assert.equal((await directory.lookup("u-jakob"))?.userId, "u-jakob")
  assert.equal(tools.count("list_org_members"), 2)
  now = 2050
  await directory.lookup("u-jakob")
  assert.equal(tools.count("list_org_members"), 2, "backs off before retrying")
  now = 2100
  await directory.lookup("u-jakob")
  assert.equal(tools.count("list_org_members"), 3)
})

test("rejects with BotPageToolError when there is no data at all", async () => {
  const tools = fakeTools().on("list_org_members", () => {
    throw new Error("platform down")
  })
  await assert.rejects(new MemberDirectory(tools).lookup("x"), BotPageToolError)
  const bad = fakeTools().on("list_org_members", () => ({ nope: true }))
  await assert.rejects(new MemberDirectory(bad).lookup("x"), /no members array/)
})

test("stale data is served for at most ttlMs + maxStaleMs, then lookups fail closed until recovery", async () => {
  let now = 0
  let fail = false
  const tools = fakeTools()
  const ok = membersHandler()
  tools.on("list_org_members", (args) => {
    if (fail) throw new Error("platform down")
    return ok(args)
  })
  const directory = new MemberDirectory(tools, {
    ttlMs: 1000,
    retryAfterMs: 100,
    maxStaleMs: 5000,
    now: () => now,
  })
  await directory.lookup("u-jakob")
  fail = true
  now = 5999
  assert.equal((await directory.lookup("u-jakob"))?.userId, "u-jakob", "within the stale bound")
  now = 6000
  await assert.rejects(directory.lookup("u-jakob"), BotPageToolError, "past the bound, at a retry")
  now = 6050
  await assert.rejects(
    directory.lookup("u-jakob"),
    BotPageToolError,
    "past the bound, during backoff"
  )
  fail = false
  now = 6100
  assert.equal((await directory.lookup("u-jakob"))?.userId, "u-jakob", "recovers after the backoff")
})

test("maxStaleMs 0 never serves stale data", async () => {
  let now = 0
  let fail = false
  const tools = fakeTools()
  const ok = membersHandler()
  tools.on("list_org_members", (args) => {
    if (fail) throw new Error("platform down")
    return ok(args)
  })
  const directory = new MemberDirectory(tools, { ttlMs: 1000, maxStaleMs: 0, now: () => now })
  await directory.lookup("u-jakob")
  fail = true
  now = 1000
  await assert.rejects(directory.lookup("u-jakob"), BotPageToolError)
})

test("a cold outage backs off: sequential and concurrent lookups share one call per retry interval", async () => {
  let now = 0
  let fail = true
  const tools = fakeTools()
  const ok = membersHandler()
  tools.on("list_org_members", (args) => {
    if (fail) throw new Error("platform down")
    return ok(args)
  })
  const directory = new MemberDirectory(tools, { retryAfterMs: 100, now: () => now })
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(directory.lookup("u-jakob"), BotPageToolError)
  }
  assert.equal(tools.count("list_org_members"), 1, "sequential requests during backoff")
  now = 100
  const concurrent = await Promise.allSettled(
    Array.from({ length: 5 }, () => directory.lookup("u-jakob"))
  )
  assert.ok(concurrent.every((result) => result.status === "rejected"))
  assert.equal(tools.count("list_org_members"), 2, "concurrent requests after the backoff")
  fail = false
  now = 150
  await assert.rejects(directory.lookup("u-jakob"), BotPageToolError, "still backing off")
  assert.equal(tools.count("list_org_members"), 2)
  now = 200
  assert.equal((await directory.lookup("u-jakob"))?.userId, "u-jakob", "recovers")
  assert.equal(tools.count("list_org_members"), 3)
})

test("a fetch slower than the staleness bound fails closed, backs off, then recovers", async () => {
  let now = 0
  let release: (() => void) | null = null
  let slow = true
  const tools = fakeTools()
  const ok = membersHandler()
  tools.on("list_org_members", async (args) => {
    if (slow && Number(args?.["offset"] ?? 0) > 0) {
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }
    return ok(args)
  })
  const directory = new MemberDirectory(tools, {
    ttlMs: 1000,
    maxStaleMs: 1000,
    retryAfterMs: 100,
    pageSize: 1,
    now: () => now,
  })

  // Completes just inside the bound: served.
  let pending = directory.lookup("u-jakob")
  await new Promise((resolve) => setImmediate(resolve))
  now = 1999
  ;(release as (() => void) | null)?.()
  assert.equal((await pending)?.userId, "u-jakob")

  // Completes at the bound: refused, and no tight retry loop.
  directory.invalidate()
  now = 10_000
  pending = directory.lookup("u-jakob")
  await new Promise((resolve) => setImmediate(resolve))
  now = 12_000
  ;(release as (() => void) | null)?.()
  await assert.rejects(pending, BotPageToolError)
  const calls = tools.count("list_org_members")
  await assert.rejects(directory.lookup("u-jakob"), BotPageToolError, "backing off")
  assert.equal(tools.count("list_org_members"), calls)

  slow = false
  now = 12_100
  assert.equal((await directory.lookup("u-jakob"))?.userId, "u-jakob", "recovers")
})
