import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { ConfigError } from "../server/config.ts"
import { describeError, scrubber } from "../server/log.ts"
import { createRuntime, type Transport } from "@botyard/runtime"
import { createReadiness, runtimeCheck } from "../server/ready.ts"
import { loadStatic } from "../server/static.ts"
import {
  previousFile,
  readTrace,
  TraceFile,
  traceFilePath,
  TraceUnavailableError,
} from "../server/trace.ts"
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
    const base = await startApp({
      readyChecks: {
        runtime: () => {
          runs += 1
        },
      },
    })
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

  // Anything can be thrown, not only an Error: its keys and contents never reach a line.
  test.each([
    ["an object keyed by the viewer", () => ({ [email]: "x", [cookie]: { nested: email } })],
    ["a bigint", () => 10n],
    ["a string", () => `boom for ${email}`],
    [
      "an Error whose getter throws",
      () =>
        Object.defineProperty(new Error("x"), "message", {
          get: () => {
            throw new Error("no")
          },
        }),
    ],
  ])("throwing %s still answers a JSON 500, logged safely", async (_label, make) => {
    const trace = new TraceFile(path.join(dir, "data", "trace.jsonl"))
    const { log, lines } = captureLog(trace)
    const base = await startApp({
      log,
      ui: () => {
        throw make()
      },
    })
    const res = await fetch(`${base}/page`, { headers: { "x-forwarded-user": email, cookie } })
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: "internal_error" })
    await sleep(20)
    const error = records(lines).find((r) => r["event"] === "unhandled_error")
    expect(error).toBeDefined()
    for (const text of [lines.join("\n"), await readFile(trace.file, "utf8")]) {
      expect(text).toContain("unhandled_error")
      expect(text).not.toContain(email)
      expect(text).not.toContain("s3cr3t-cookie-value")
    }
  })

  test("only a real Error is read, and only its name, message and stack", () => {
    const clean = scrubber([])
    expect(describeError(new TypeError(`bad ${email}`), clean)).toMatchObject({
      name: "TypeError",
      message: "bad [redacted]",
    })
    expect(describeError({ [email]: 1 }, clean)).toEqual({ thrown: "object" })
    expect(describeError(null, clean)).toEqual({ thrown: "null" })
  })

  test("email addresses and Bearer tokens are blanked out of any line", () => {
    const clean = scrubber([])
    expect(clean("for grace@example.com with Bearer abc.def-123")).toBe(
      "for [redacted] with [redacted]"
    )
    // Not email addresses: package paths in a stack.
    expect(clean("at node_modules/@botyard/runtime/dist/x.js (vite@8.3.8)")).toBe(
      "at node_modules/@botyard/runtime/dist/x.js (vite@8.3.8)"
    )
  })
})

describe("readiness checks", () => {
  // A transport whose tool listings can be made to hang; tool calls always answer.
  const controllable = (): { transport: Transport; hang: () => void } => {
    let hanging = false
    return {
      hang: () => {
        hanging = true
      },
      transport: {
        kind: "mock",
        listTools: () =>
          hanging
            ? new Promise(() => {})
            : Promise.resolve([{ name: "list_org_members", inputSchema: {} }]),
        callTool: () =>
          Promise.resolve({ content: [], structuredContent: { ok: 1 }, isError: false }),
      },
    }
  }

  test("probing Botyard through its own runtime leaves the app's calls alone", async () => {
    const { transport, hang } = controllable()
    const app = createRuntime({ transport })
    await app.call("list_org_members") // the app learns the tool list
    hang()
    const ready = createReadiness(
      { runtime: runtimeCheck(createRuntime({ transport })) },
      { timeoutMs: 50 }
    )
    expect(await ready()).toMatchObject({ ok: false, checks: { runtime: { reason: "timeout" } } })
    await expect(app.call("list_org_members", {}, { timeoutMs: 500 })).resolves.toEqual({ ok: 1 })
  })

  test("(why: probing through the app's own runtime would hold up its calls)", async () => {
    const { transport, hang } = controllable()
    const app = createRuntime({ transport })
    await app.call("list_org_members")
    hang()
    const ready = createReadiness({ runtime: runtimeCheck(app) }, { timeoutMs: 50 })
    await ready()
    // The call waits on the probe's listing, past its own deadline.
    const call = app.call("list_org_members", {}, { timeoutMs: 100 }).then(
      () => "answered",
      () => "failed"
    )
    expect(await Promise.race([call, sleep(300).then(() => "still waiting")])).toBe("still waiting")
  })

  test("a check that outlives its deadline is aborted, and never runs twice at once", async () => {
    let runs = 0
    let finish = (): void => {}
    let aborted = false
    const ready = createReadiness(
      {
        slow: (signal) =>
          new Promise<void>((resolve) => {
            runs += 1
            signal.addEventListener("abort", () => {
              aborted = true
            })
            finish = resolve
          }),
      },
      { timeoutMs: 30, cacheMs: 0 }
    )
    expect(await ready()).toEqual({ ok: false, checks: { slow: { ok: false, reason: "timeout" } } })
    expect(aborted).toBe(true)
    // Still running: later reports wait on the same run instead of starting another.
    expect((await ready()).ok).toBe(false)
    expect((await ready()).ok).toBe(false)
    expect(runs).toBe(1)
    finish()
    await sleep(5)
    expect((await ready()).ok).toBe(false)
    expect(runs).toBe(2)
  })
})

describe("readiness: how a check ends", () => {
  test("a check that throws synchronously recovers once it passes", async () => {
    let calls = 0
    const ready = createReadiness(
      {
        flaky: () => {
          calls += 1
          if (calls === 1) throw new TypeError("not yet")
        },
      },
      { timeoutMs: 100, cacheMs: 20 }
    )
    expect(await ready()).toEqual({
      ok: false,
      checks: { flaky: { ok: false, reason: "TypeError" } },
    })
    await sleep(30)
    expect(await ready()).toEqual({ ok: true, checks: { flaky: { ok: true } } })
    expect(calls).toBe(2)
  })

  test("an error whose name cannot be read is a 503 all the same, and nothing escapes", async () => {
    const escaped: unknown[] = []
    const onEscape = (err: unknown): void => {
      escaped.push(err)
    }
    process.on("unhandledRejection", onEscape)
    try {
      const { log, lines } = captureLog()
      const base = await startApp({
        log,
        readyChecks: {
          tricky: () => {
            const err = new Error("store for ada@example.com is gone")
            Object.defineProperty(err, "name", {
              get: () => {
                throw new Error("no name for you")
              },
            })
            throw err
          },
        },
      })
      const res = await Promise.race([
        fetch(`${base}/api/ready`),
        sleep(2000).then(() => {
          throw new Error("/api/ready never answered")
        }),
      ])
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({
        ok: false,
        checks: { tricky: { ok: false, reason: "error" } },
      })
      await sleep(20)
      expect(escaped).toEqual([])
      expect(lines.join("\n")).toContain("ready_check_failed")
      expect(lines.join("\n")).not.toContain("ada@example.com")
    } finally {
      process.off("unhandledRejection", onEscape)
    }
  })

  test.each([
    ["a plain class name", "RangeError", "RangeError"],
    ["a name with spaces and an email", "bad for ada@example.com", "error"],
    ["a very long name", "E".repeat(41), "error"],
    ["an empty name", "", "error"],
  ])("reports %s as a bounded code", async (_label, name, reason) => {
    const ready = createReadiness({
      named: () => {
        const err = new Error("x")
        err.name = name
        throw err
      },
    })
    expect((await ready()).checks).toEqual({ named: { ok: false, reason } })
  })

  test("a thrown value that is not an Error is reported as error", async () => {
    const ready = createReadiness({
      odd: () => {
        throw { name: "ada@example.com" }
      },
    })
    expect((await ready()).checks).toEqual({ odd: { ok: false, reason: "error" } })
  })

  test("a check that only finishes while being stopped still reports timeout", async () => {
    const ready = createReadiness(
      {
        stuck: (signal) =>
          new Promise<void>((resolve) => {
            // Resolves only when told to stop, as a well-behaved check might.
            signal.addEventListener("abort", () => {
              resolve()
            })
          }),
      },
      { timeoutMs: 30, cacheMs: 0 }
    )
    expect(await ready()).toEqual({
      ok: false,
      checks: { stuck: { ok: false, reason: "timeout" } },
    })
  })

  test("a late result from an expired run never wins a later report", async () => {
    let finish = (): void => {}
    let runs = 0
    const ready = createReadiness(
      {
        late: () =>
          new Promise<void>((resolve) => {
            runs += 1
            finish = resolve
          }),
      },
      { timeoutMs: 30, cacheMs: 0 }
    )
    expect((await ready()).ok).toBe(false)
    // The expired run is still going; a new report must not race it again.
    const second = ready()
    finish()
    expect(await second).toEqual({ ok: false, checks: { late: { ok: false, reason: "timeout" } } })
    expect(runs).toBe(1)
  })
})

describe("trace file", () => {
  test("rotates before the cap, keeping one previous file; neither passes the cap", async () => {
    const file = path.join(dir, "data", "trace.jsonl")
    const trace = new TraceFile(file, { maxBytes: 200 })
    const time = new Date().toISOString()
    for (let i = 0; i < 20; i += 1) trace.write(JSON.stringify({ i, pad: "x".repeat(40) }), time)
    // One record bigger than a whole file becomes a short note.
    trace.write(JSON.stringify({ i: 20, pad: "x".repeat(500) }), time)
    for (const name of [file, previousFile(file)]) {
      expect((await stat(name)).size, name).toBeLessThanOrEqual(200)
    }
    const all = readTrace(file)
    expect(all.at(-2)).toMatchObject({ i: 19 })
    expect(all.at(-1)).toMatchObject({ event: "trace_record_too_big", time })
  })

  describe("where TRACE_FILE may point", () => {
    let root: string
    beforeEach(async () => {
      root = path.join(dir, "app")
      await mkdir(path.join(root, "dist", "client"), { recursive: true })
      await mkdir(path.join(root, "public"), { recursive: true })
    })
    const place = (TRACE_FILE?: string): string =>
      traceFilePath(root, TRACE_FILE === undefined ? {} : { TRACE_FILE }).real

    test("data/ inside the app, or anywhere outside it", () => {
      expect(place()).toBe(path.join(root, "data", "trace.jsonl"))
      expect(place("data/x/t.jsonl")).toBe(path.join(root, "data", "x", "t.jsonl"))
      expect(place(path.join(dir, "elsewhere", "t.jsonl"))).toBe(
        path.join(dir, "elsewhere", "t.jsonl")
      )
    })

    test.each([
      ["not .jsonl", "data/trace.log"],
      ["no extension", "data/trace"],
      ["the built UI", "dist/client/t.jsonl"],
      ["the app root", "t.jsonl"],
      ["a name beginning data", "data.jsonl"],
      ["a name beginning with two dots", "..trace.jsonl"],
      ["public/", "public/t.jsonl"],
    ])("refuses %s", (_label, bad) => {
      expect(() => place(bad)).toThrow(ConfigError)
    })

    test("refuses a path that is really inside a served directory, through a symlink", async () => {
      // An alias outside the app pointing into its built UI.
      await symlink(path.join(root, "dist", "client"), path.join(dir, "alias"))
      expect(() => place(path.join(dir, "alias", "t.jsonl"))).toThrow(ConfigError)
      // data/ itself a symlink into public/.
      await symlink(path.join(root, "public"), path.join(root, "data"))
      expect(() => place()).toThrow(ConfigError)
    })

    test.each([
      ["the built UI", path.join("dist", "client")],
      ["public/", "public"],
    ])(
      "refuses a path inside %s when that is a symlink to a directory outside the app",
      async (_label, served) => {
        // A release directory outside the app, served through the symlink.
        const release = path.join(dir, "release")
        await mkdir(release)
        await rm(path.join(root, served), { recursive: true })
        await symlink(release, path.join(root, served))
        expect(() => place(path.join(release, "t.jsonl"))).toThrow(ConfigError)
        expect(() => place(path.join(release, "deep", "t.jsonl"))).toThrow(ConfigError)
        // Beside it is fine.
        expect(place(path.join(dir, "logs", "t.jsonl"))).toBe(path.join(dir, "logs", "t.jsonl"))
      }
    )

    test("a directory that cannot be created means no trace, not a config error", async () => {
      // A file where the trace's directory should be.
      await writeFile(path.join(dir, "blocker"), "")
      expect(() => place(path.join(dir, "blocker", "t.jsonl"))).toThrow(TraceUnavailableError)
      // Unsafe placement is still refused first, whatever the disk says.
      await writeFile(path.join(root, "dist", "client", "blocker"), "")
      expect(() => place("dist/client/blocker/t.jsonl")).toThrow(ConfigError)
    })

    test("refuses an existing trace or rotated file that is a symlink", async () => {
      await mkdir(path.join(root, "data"))
      const target = path.join(root, "dist", "client", "x.jsonl")
      await writeFile(target, "")
      await symlink(target, path.join(root, "data", "trace.jsonl"))
      expect(() => place()).toThrow(ConfigError)
      await rm(path.join(root, "data", "trace.jsonl"))
      await symlink(target, path.join(root, "data", "trace.1.jsonl"))
      expect(() => place()).toThrow(ConfigError)
    })

    test("a TraceFile name must end in .jsonl", () => {
      expect(() => new TraceFile(path.join(dir, "trace.log"))).toThrow(ConfigError)
    })
  })

  test("never writes through a trace file swapped for a symlink", async () => {
    const file = path.join(dir, "data", "trace.jsonl")
    const errors: unknown[] = []
    const trace = new TraceFile(file, { onError: (err) => errors.push(err) })
    const outside = path.join(dir, "outside.txt")
    await writeFile(outside, "")
    await symlink(outside, file)
    trace.write('{"event":"x"}', new Date().toISOString())
    expect(await readFile(outside, "utf8")).toBe("")
    expect(errors).toHaveLength(1)
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
