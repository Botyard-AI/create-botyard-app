// `npm run smoke`: its checks against the real app, against apps that are
// wrong in each way it should catch, and its --browser form.
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, request, type Server } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { runInNewContext } from "node:vm"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { smoke, table, type Result } from "../scripts/smoke-checks.ts"
import { loadStatic } from "../server/static.ts"
import { startApp } from "./helpers.ts"
import { appRoot } from "./server-harness.ts"

let dir: string
const servers: Server[] = []
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "full-app-smoke-"))
})
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }
  await rm(dir, { recursive: true, force: true })
})

const outsider = { "x-forwarded-user": "smoke-outsider@example.com" }
const failing = (results: readonly Result[]): string[] =>
  results.filter((r) => !r.ok).map((r) => r.check)

/** The app as `npm start` runs it, with a built UI of one index.html. */
async function builtApp(): Promise<string> {
  const client = path.join(dir, "client")
  await mkdir(client, { recursive: true })
  await writeFile(path.join(client, "index.html"), '<!doctype html><div id="root"></div>')
  return startApp({ staticFiles: await loadStatic(client) })
}

type Route = { status: number; body: string; type?: string; stall?: boolean }

/**
 * A server that answers each path as `routes` says, and 404 otherwise. A
 * route with `stall` sends its headers and part of its body, then never ends.
 */
async function fakeApp(routes: Record<string, Route>): Promise<string> {
  const server = createServer((req, res) => {
    const route = routes[new URL(req.url ?? "/", "http://x").pathname]
    res.writeHead(route?.status ?? 404, { "content-type": route?.type ?? "application/json" })
    if (route?.stall === true) {
      res.write(route.body.slice(0, 1))
      return
    }
    res.end(route?.body ?? "{}")
  })
  server.on("close", () => {
    server.closeAllConnections()
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve()
    })
  })
  const address = server.address()
  return `http://127.0.0.1:${String(typeof address === "object" && address ? address.port : 0)}`
}

const healthy = {
  "/api/health": { status: 200, body: '{"ok":true}' },
  "/api/ready": { status: 200, body: '{"ok":true,"checks":{}}' },
  "/": { status: 200, body: '<div id="root"></div>', type: "text/html" },
  "/api/me": { status: 200, body: '{"viewer":null}' },
  "/api/hello": { status: 403, body: '{"error":"not_a_member","message":"…"}' },
}

const bot = {
  kind: "bot",
  viewerType: "bot",
  botId: "bot-1",
  subject: "bot-1",
  source: "forwarded-user",
}
const member = {
  kind: "member",
  viewerType: "user",
  userId: "user-ada",
  email: "ada@example.com",
  name: "Ada Lovelace",
  role: "owner",
  avatarUrl: null,
  subject: "ada@example.com",
  source: "forwarded-user",
}
const me = (viewer: unknown): Route => ({ status: 200, body: JSON.stringify({ viewer }) })

describe.skipIf(process.platform !== "linux")("against the app", () => {
  test("every check passes", async () => {
    const results = await smoke(await builtApp(), outsider, null)
    expect(failing(results)).toEqual([])
    expect(results.map((r) => r.check)).toEqual(["health", "ready", "index", "me", "guard"])
  })
})

describe("catches what is wrong", () => {
  test.each([
    ["an open members-only route", { "/api/hello": { status: 200, body: "{}" } }, ["guard"]],
    ["no viewer reaching the app", { "/api/hello": { status: 401, body: "{}" } }, ["guard"]],
    [
      "a 403 from in front of the app (plain text)",
      { "/api/hello": { status: 403, body: "Forbidden", type: "text/plain" } },
      ["guard"],
    ],
    [
      "a 403 that is not the members-only refusal",
      { "/api/hello": { status: 403, body: '{"error":"role_not_allowed"}' } },
      ["guard"],
    ],
    ["a viewer of an unknown kind", { "/api/me": me({ ...member, kind: "admin" }) }, ["me"]],
    ["a member without its userId", { "/api/me": me({ ...member, userId: undefined }) }, ["me"]],
    ["a viewer without a source", { "/api/me": me({ ...bot, source: undefined }) }, ["me"]],
    [
      "a failing readiness check",
      {
        "/api/ready": {
          status: 503,
          body: '{"ok":false,"checks":{"runtime":{"ok":false,"reason":"timeout"}}}',
        },
      },
      ["ready"],
    ],
    ["no UI", { "/": { status: 404, body: "{}" } }, ["index"]],
    ["the wrong /api/me shape", { "/api/me": { status: 200, body: '{"user":"ada"}' } }, ["me"]],
    ["health down", { "/api/health": { status: 500, body: "{}" } }, ["health"]],
  ])("%s", async (_label, broken, expected) => {
    const results = await smoke(await fakeApp({ ...healthy, ...broken }), outsider, null)
    expect(failing(results)).toEqual(expected)
  })

  test.each([
    ["a whole bot viewer", bot, []],
    ["a bot with only its kind", { kind: "bot" }, ["me"]],
    ["a bot whose subject is not its botId", { ...bot, subject: "bot-2" }, ["me"]],
    ["a member, when a bot is expected", member, ["me"]],
    ["no viewer, when a bot is expected", null, ["me"]],
  ])("expecting a bot: %s", async (_label, viewer, expected) => {
    const results = await smoke(await fakeApp({ ...healthy, "/api/me": me(viewer) }), {}, "bot")
    expect(failing(results)).toEqual(expected)
  })

  test("a whole member viewer passes", async () => {
    const results = await smoke(
      await fakeApp({ ...healthy, "/api/me": me(member) }),
      outsider,
      null
    )
    expect(failing(results)).toEqual([])
  })

  test("a response that never ends fails its check, and the others still run", async () => {
    const base = await fakeApp({
      ...healthy,
      "/api/health": { status: 200, body: '{"ok":true}', stall: true },
    })
    const results = await smoke(base, outsider, null, 300)
    expect(results[0]).toEqual({
      check: "health",
      ok: false,
      detail: "no full answer within 300 ms",
    })
    expect(failing(results)).toEqual(["health"])
  })

  test("the failing readiness check is named", async () => {
    const base = await fakeApp({
      ...healthy,
      "/api/ready": {
        status: 503,
        body: '{"ok":false,"checks":{"runtime":{"ok":false,"reason":"timeout"}}}',
      },
    })
    expect(table(await smoke(base, outsider, null))).toMatch(
      /FAIL {2}ready {3}503; runtime: timeout/
    )
  })

  test("nothing listening fails every check, without throwing", async () => {
    const base = await fakeApp(healthy)
    await new Promise<void>((resolve) => {
      servers.pop()?.close(() => {
        resolve()
      })
    })
    expect(failing(await smoke(base, outsider, null))).toHaveLength(5)
  })
})

describe.skipIf(process.platform !== "linux")("--browser", () => {
  // What the Bot Page proxy does: it signs the viewer in, sets x-forwarded-user
  // itself, and passes the request on. Here the viewer is always the bot.
  async function botPageProxy(target: string): Promise<string> {
    const server = createServer((req, res) => {
      const headers = { ...req.headers, "x-forwarded-user": "bot+bot-dev@bots.botyard.internal" }
      const upstream = request(
        new URL(req.url ?? "/", target),
        { method: req.method, headers },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers)
          up.pipe(res)
        }
      )
      req.pipe(upstream)
    })
    servers.push(server)
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve()
      })
    })
    const address = server.address()
    return `http://127.0.0.1:${String(typeof address === "object" && address ? address.port : 0)}`
  }

  /**
   * Evaluates what `--browser` prints, as the browser tool would in a tab on
   * `origin`: exactly what the script prints, in a context of its own with
   * only a browser's globals, so the function cannot reach anything else.
   */
  async function evaluateInTab(origin: string, timeoutMs?: number): Promise<unknown> {
    const printed = execFileSync(process.execPath, ["scripts/smoke.ts", "--browser"], {
      cwd: appRoot,
      encoding: "utf8",
    })
    // What a browser tool does with a function: call it, and await what it returns.
    // A test's shorter deadline goes in as the function's fourth argument.
    const source =
      timeoutMs === undefined
        ? printed
        : printed.replace('"bot"))', `"bot", ${String(timeoutMs)}))`)
    const pending: unknown = runInNewContext(`(${source})()`, {
      location: { origin },
      fetch,
      URL,
      AbortSignal,
    })
    const json: unknown = await pending
    if (typeof json !== "string") throw new Error("--browser did not resolve to JSON")
    return JSON.parse(json)
  }

  test("passes through the proxy, where the bot is the outsider", async () => {
    const results = await evaluateInTab(await botPageProxy(await builtApp()))
    expect(results).toEqual([
      { check: "health", ok: true, detail: "200" },
      { check: "ready", ok: true, detail: "200" },
      { check: "index", ok: true, detail: "200 text/html" },
      { check: "me", ok: true, detail: "200 viewer: bot" },
      { check: "guard", ok: true, detail: "403 not_a_member for an outsider" },
    ])
  })

  test("a stalled response times out there too", async () => {
    const results = await evaluateInTab(
      await fakeApp({ ...healthy, "/api/health": { status: 200, body: "{}", stall: true } }),
      300
    )
    expect(results).toMatchObject([
      { check: "health", ok: false, detail: "no full answer within 300 ms" },
      { check: "ready", ok: true },
      { check: "index", ok: true },
      // No proxy here, so no bot viewer.
      { check: "me", ok: false },
      { check: "guard", ok: true },
    ])
  })

  test("without the proxy, no one is signed in: me and guard fail", async () => {
    expect(await evaluateInTab(await builtApp())).toMatchObject([
      { check: "health", ok: true },
      { check: "ready", ok: true },
      { check: "index", ok: true },
      { check: "me", ok: false, detail: "200 viewer: null (no viewer, expected bot)" },
      { check: "guard", ok: false, detail: "401: no viewer reached the app" },
    ])
  })
})
