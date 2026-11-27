import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { redact } from "../server/log.ts"
import { loadStatic } from "../server/static.ts"
import { previousFile, readTrace, TraceFile } from "../server/trace.ts"
import { asViewer, captureLog, startApp } from "./helpers.ts"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "full-app-ops-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const records = (lines: readonly string[]): Record<string, unknown>[] =>
  lines.map((line) => {
    const value: unknown = JSON.parse(line)
    return typeof value === "object" && value !== null
      ? Object.fromEntries(Object.entries(value))
      : {}
  })

describe("/api/ready", () => {
  test("200 when every check passes", async () => {
    const base = await startApp()
    const res = await fetch(`${base}/api/ready`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, checks: { runtime: { ok: true } } })
  })

  test("503 naming the check that failed, without its message", async () => {
    const { log, lines } = captureLog()
    const base = await startApp({
      log,
      readyChecks: {
        runtime: () => undefined,
        store: () => {
          throw new TypeError("cannot read /home/bot/app/data/store.json")
        },
      },
    })
    const res = await fetch(`${base}/api/ready`)
    expect(res.status).toBe(503)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({
      ok: false,
      checks: { runtime: { ok: true }, store: { ok: false, reason: "TypeError" } },
    })
    expect(text).not.toContain("store.json")
    // The message is in the log instead, for `npm run trace`.
    expect(lines.join("\n")).toContain("cannot read /home/bot/app/data/store.json")
  })

  test("503 when a check takes too long", async () => {
    const base = await startApp({
      readyChecks: { runtime: () => new Promise(() => {}) },
    })
    const started = Date.now()
    const res = await fetch(`${base}/api/ready`)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({
      checks: { runtime: { ok: false, reason: "timeout" } },
    })
    expect(Date.now() - started).toBeLessThan(5000)
  }, 10_000)

  test("never returns viewer data", async () => {
    const base = await startApp()
    const text = await (await fetch(`${base}/api/ready`, asViewer("ada@example.com"))).text()
    expect(text).not.toMatch(/ada|lovelace|user-ada|viewer/i)
  })

  test("polling it does not re-run the checks each time", async () => {
    let runs = 0
    const base = await startApp({
      readyChecks: {
        runtime: async () => {
          runs += 1
          await sleep(20)
        },
      },
    })
    await Promise.all([1, 2, 3, 4, 5].map(() => fetch(`${base}/api/ready`)))
    await fetch(`${base}/api/ready`)
    expect(runs).toBe(1)
  })

  test("health stays a cheap liveness check", async () => {
    let runs = 0
    const base = await startApp({ readyChecks: { runtime: () => (runs += 1) } })
    expect((await fetch(`${base}/api/health`)).status).toBe(200)
    expect(runs).toBe(0)
  })
})

describe("request log", () => {
  test("one line per request: id, method, path, status, duration, viewer kind", async () => {
    const { log, lines } = captureLog()
    const base = await startApp({ log })
    const res = await fetch(
      `${base}/api/me?email=ada@example.com&token=abc123`,
      asViewer("ada@example.com")
    )
    await res.text()
    await sleep(20)
    const [line] = records(lines).filter((r) => r["event"] === "request")
    expect(line).toMatchObject({
      level: "info",
      method: "GET",
      path: "/api/me",
      status: 200,
      viewer: "person",
      requestId: res.headers.get("x-request-id"),
    })
    expect(typeof line?.["ms"]).toBe("number")
    expect(lines.join("\n")).not.toMatch(/ada@example\.com|abc123|token=/i)
  })

  test("viewer kind is person, bot or none", async () => {
    const { log, lines } = captureLog()
    const base = await startApp({ log })
    await fetch(`${base}/api/health`)
    await fetch(`${base}/api/health`, asViewer("bot+bot-dev@bots.botyard.internal"))
    await sleep(20)
    expect(records(lines).map((r) => r["viewer"])).toEqual(["none", "bot"])
  })
})

describe("an error nothing caught", () => {
  const boom = (): never => {
    throw new Error("the database fell over")
  }

  test("is a JSON 500 with the request id; the stack goes to the log only", async () => {
    const { log, lines } = captureLog()
    const base = await startApp({ log, ui: boom })
    const res = await fetch(`${base}/some/page`)
    expect(res.status).toBe(500)
    const body = await res.text()
    const id = res.headers.get("x-request-id")
    expect(JSON.parse(body)).toEqual({ error: "internal_error", requestId: id })
    expect(body).not.toContain("database")
    expect(body).not.toContain("at ")

    await sleep(20)
    const error = records(lines).find((r) => r["event"] === "unhandled_error")
    expect(error).toMatchObject({ level: "error", requestId: id, path: "/some/page" })
    expect(JSON.stringify(error)).toContain("the database fell over")
    expect(JSON.stringify(error)).toContain("operability.test.ts")
    expect(records(lines).find((r) => r["event"] === "request")).toMatchObject({
      level: "error",
      status: 500,
      requestId: id,
    })
  })

  test("the server keeps serving afterwards", async () => {
    const base = await startApp({ ui: boom })
    expect((await fetch(`${base}/x`)).status).toBe(500)
    expect((await fetch(`${base}/api/health`)).status).toBe(200)
  })
})

describe("redaction", () => {
  const email = "ada@example.com"
  const cookie = "session=s3cr3t-cookie-value; theme=dark-mode"
  const bearer = "Bearer tok-0123456789abcdef"

  test("identity, cookies and auth headers never reach the log or the trace", async () => {
    const trace = new TraceFile(path.join(dir, "data", "trace.jsonl"))
    const { log, lines } = captureLog(trace)
    // A route that puts everything it was sent into its error, as careless
    // code does: `throw new Error(\`failed for ${req.headers.cookie}\`)`.
    const base = await startApp({
      log,
      ui: (req) => {
        const err = new Error(
          `failed for ${String(req.headers["x-forwarded-user"])} ` +
            `cookie ${String(req.headers.cookie)} auth ${String(req.headers.authorization)}`
        )
        Object.assign(err, { headers: req.headers, token: "tok-0123456789abcdef" })
        throw err
      },
    })
    const res = await fetch(`${base}/page`, {
      headers: { "x-forwarded-user": email, cookie, authorization: bearer },
    })
    expect(res.status).toBe(500)
    await sleep(20)

    const logged = lines.join("\n")
    const traced = await readFile(trace.file, "utf8")
    expect(traced).toContain("unhandled_error")
    for (const text of [logged, traced]) {
      for (const secret of [
        email,
        "s3cr3t-cookie-value",
        "dark-mode",
        "tok-0123456789abcdef",
        "Bearer",
      ]) {
        expect(text, secret).not.toContain(secret)
      }
      expect(text).toContain("[redacted]")
    }
  })

  test("sensitive keys are dropped at any depth", () => {
    expect(
      redact({ a: { Authorization: "x", cookie: "y", nested: [{ password: "z", ok: 1 }] } })
    ).toEqual({
      a: {
        Authorization: "[redacted]",
        cookie: "[redacted]",
        nested: [{ password: "[redacted]", ok: 1 }],
      },
    })
  })
})

describe("trace file", () => {
  test("rotates at its size cap, keeping one previous file", () => {
    const file = path.join(dir, "data", "trace.jsonl")
    const trace = new TraceFile(file, { maxBytes: 200 })
    for (let i = 0; i < 20; i += 1) trace.write({ i, pad: "x".repeat(40) })
    const all = readTrace(file)
    expect(all.length).toBeGreaterThan(0)
    expect(all.length).toBeLessThan(20)
    expect(all.at(-1)).toMatchObject({ i: 19 })
  })

  test("skips a line cut short by a crash", async () => {
    const file = path.join(dir, "trace.jsonl")
    await writeFile(previousFile(file), '{"i":1}\n')
    await writeFile(file, '{"i":2}\n{"i":3, "cut')
    expect(readTrace(file)).toEqual([{ i: 1 }, { i: 2 }])
  })

  test("a write that fails turns the trace off; the app carries on", async () => {
    const blocker = path.join(dir, "not-a-dir")
    await writeFile(blocker, "")
    const errors: unknown[] = []
    const trace = new TraceFile(path.join(blocker, "trace.jsonl"), {
      onError: (err) => errors.push(err),
    })
    const { log } = captureLog(trace)
    const base = await startApp({ log })
    expect((await fetch(`${base}/api/health`)).status).toBe(200)
    expect(errors).toHaveLength(1)
  })

  // The trace is a file on the bot's disk: no route serves it, and it is not
  // part of the built UI, so the Bot Page proxy cannot reach it.
  test.skipIf(process.platform !== "linux")("is never served over HTTP", async () => {
    const root = path.join(dir, "app")
    await mkdir(path.join(root, "dist", "client"), { recursive: true })
    await writeFile(path.join(root, "dist", "client", "index.html"), "<!doctype html>app")
    const trace = new TraceFile(path.join(root, "data", "trace.jsonl"))
    const { log } = captureLog(trace)
    const base = await startApp({
      log,
      staticFiles: await loadStatic(path.join(root, "dist", "client")),
    })
    await fetch(`${base}/api/health?marker=trace-marker`)
    await fetch(`${base}/trace-marker-path`)
    expect(await readFile(trace.file, "utf8")).toContain("trace-marker-path")
    for (const probe of [
      "/data/trace.jsonl",
      "/trace.jsonl",
      "/../data/trace.jsonl",
      "/%2e%2e/data/trace.jsonl",
      "/api/trace",
      "/api/../data/trace.jsonl",
    ]) {
      const text = await (await fetch(`${base}${probe}`)).text()
      expect(text, probe).not.toContain("trace-marker-path")
      expect(text, probe).not.toContain('"event"')
    }
  })
})
