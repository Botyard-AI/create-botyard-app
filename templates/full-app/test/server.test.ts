// Starts the real server (server/index.ts) as a child process and checks how
// it starts, logs, serves and stops.
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { loadConfig } from "../server/config.ts"
import { appRoot, fakeBotyard, stopServers, startServer } from "./server-harness.ts"

let dir: string
const cleanup: (() => Promise<void>)[] = []
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "full-app-server-"))
})
afterEach(async () => {
  await stopServers()
  for (const undo of cleanup.splice(0)) await undo()
  await rm(dir, { recursive: true, force: true })
})

async function packageVersion(): Promise<string> {
  const pkg: unknown = JSON.parse(await readFile(path.join(appRoot, "package.json"), "utf8"))
  const version = typeof pkg === "object" && pkg !== null && "version" in pkg ? pkg.version : null
  if (typeof version !== "string") throw new Error("package.json has no version")
  return version
}

/**
 * Waits for `file` to contain `text`. A request's line reaches the trace just
 * after the response, and after stdout, so neither says it is there yet.
 */
async function fileContains(file: string, text: string): Promise<void> {
  for (let tries = 0; tries < 100; tries += 1) {
    const content = await readFile(file, "utf8").catch(() => "")
    if (content.includes(text)) return
    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
  }
  throw new Error(`${file} never contained "${text}"`)
}

const asAda = { headers: { "x-forwarded-user": "ada@example.com" } }

describe("starting and stopping", () => {
  test("logs one startup line, serves, and stops cleanly on SIGTERM", async () => {
    const trace = path.join(dir, "trace.jsonl")
    const run = await startServer({ env: { TRACE_FILE: trace } })
    const startup: unknown = JSON.parse(await run.waitFor('"event":"startup"'))
    expect(startup).toMatchObject({
      level: "info",
      app: (await loadConfig(appRoot, {})).name,
      version: await packageVersion(),
      port: run.port,
      transport: "mock",
      nodeEnv: "development",
      mode: "dev",
    })

    expect((await fetch(`${run.base}/api/health`)).status).toBe(200)
    expect(await (await fetch(`${run.base}/api/ready`)).json()).toMatchObject({ ok: true })

    run.kill("SIGTERM")
    expect(await run.closed).toBe(0)
    expect(run.stdout()).toContain('"event":"shutdown","reason":"SIGTERM"')
    expect(run.stdout()).toContain('"event":"stopped"')
    const traced = await readFile(trace, "utf8")
    expect(traced).toContain('"path":"/api/ready"')
    expect(traced).toContain('"event":"startup"')
  }, 30_000)

  test("a request already in its handler finishes before the server stops", async () => {
    const botyard = await fakeBotyard()
    cleanup.push(botyard.close)
    const run = await startServer({
      env: { BOTYARD_RUNTIME_TRANSPORT: "mcp", BOTYARD_RUNTIME_MCP_URL: botyard.url },
    })
    await run.waitFor('"event":"startup"')
    // /api/hello asks Botyard for the member list; hold that call open.
    const held = botyard.holdCalls()
    const pending = fetch(`${run.base}/api/hello`, asAda)
    await held.arrived
    run.kill("SIGTERM")
    await run.waitFor('"event":"shutdown"')
    held.release()
    const res = await pending
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ message: "Hello, Ada Lovelace!" })
    expect(await run.closed).toBe(0)
  }, 30_000)

  test("an open hot-reload connection does not hold up shutdown", async () => {
    const botyard = await fakeBotyard()
    cleanup.push(botyard.close)
    const run = await startServer({
      env: { BOTYARD_RUNTIME_TRANSPORT: "mcp", BOTYARD_RUNTIME_MCP_URL: botyard.url },
    })
    await run.waitFor('"event":"startup"')
    // What a dev tab keeps open: Vite's HMR WebSocket on the same port.
    const socket = new WebSocket(`ws://127.0.0.1:${String(run.port)}/`, "vite-hmr")
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => {
        resolve()
      })
      socket.addEventListener("error", () => {
        reject(new Error("no HMR connection"))
      })
    })
    const held = botyard.holdCalls()
    const pending = fetch(`${run.base}/api/hello`, asAda)
    await held.arrived

    const stopped = Date.now()
    run.kill("SIGTERM")
    await run.waitFor('"event":"shutdown"')
    held.release()
    expect((await pending).status).toBe(200)
    expect(await run.closed).toBe(0)
    expect(Date.now() - stopped).toBeLessThan(5000)
    expect(run.stdout()).not.toContain("shutdown_forced")
  }, 30_000)

  test.each([
    ["a bad PORT", { PORT: "not-a-port" }, "PORT"],
    [
      "the dev viewer in production",
      { NODE_ENV: "production", BOTYARD_DEV_VIEWER: "ada@example.com" },
      "BOTYARD_DEV_VIEWER",
    ],
    ["no Botyard transport", { BOTYARD_RUNTIME_TRANSPORT: "carrier-pigeon" }, "npm run dev:mock"],
    ["a TRACE_FILE that is not .jsonl", { TRACE_FILE: "/tmp/trace.log" }, ".jsonl"],
    ["a TRACE_FILE the app could serve", { TRACE_FILE: "dist/client/trace.jsonl" }, "data/"],
  ])(
    "fails fast with a clear message on %s",
    async (_label, env, hint) => {
      const run = await startServer({ env })
      expect(await run.closed).toBe(1)
      expect(run.stderr()).toContain(hint)
      expect(run.stderr()).toContain('"event":"startup_failed"')
      expect(run.stderr()).not.toMatch(/^\s+at /m)
    },
    30_000
  )
})

test("refuses to start when TRACE_FILE really points into the app, through a symlink", async () => {
  // An alias outside the app for the app's own root: the path looks harmless.
  const alias = path.join(dir, "alias")
  await symlink(appRoot, alias)
  const run = await startServer({ env: { TRACE_FILE: path.join(alias, "trace.jsonl") } })
  expect(await run.closed).toBe(1)
  expect(run.stderr()).toContain("not under its data/ directory")
  await expect(stat(path.join(appRoot, "trace.jsonl"))).rejects.toThrow()
}, 30_000)

// public/ made a symlink to a directory outside the app, as a release layout
// might. Only when the app has no public/ of its own, which is left alone.
const publicDir = path.join(appRoot, "public")
test.skipIf(existsSync(publicDir))(
  "refuses to start when the trace would land in a served directory that lives outside the app",
  async () => {
    const release = path.join(dir, "release")
    await mkdir(release)
    await symlink(release, publicDir)
    cleanup.push(async () => {
      await rm(publicDir, { force: true })
    })
    const run = await startServer({ env: { TRACE_FILE: path.join(release, "trace.jsonl") } })
    expect(await run.closed).toBe(1)
    expect(run.stderr()).toContain("not under its data/ directory")
    await expect(stat(path.join(release, "trace.jsonl"))).rejects.toThrow()
  },
  30_000
)

test("starts and stays healthy when the trace cannot be kept", async () => {
  // A file where the trace's directory should be.
  const blocker = path.join(dir, "blocker")
  await writeFile(blocker, "")
  const run = await startServer({ env: { TRACE_FILE: path.join(blocker, "trace.jsonl") } })
  const warning: unknown = JSON.parse(await run.waitFor('"event":"trace_off"'))
  expect(warning).toMatchObject({ level: "warn" })
  await run.waitFor('"event":"startup"')
  expect((await fetch(`${run.base}/api/health`)).status).toBe(200)
  expect((await fetch(`${run.base}/api/ready`)).status).toBe(200)
  run.kill("SIGTERM")
  expect(await run.closed).toBe(0)
  expect((await stat(blocker)).isFile()).toBe(true)
}, 30_000)

describe("errors nothing caught", () => {
  // A preload that, on SIGUSR2, throws or rejects outside any request.
  const preload = async (kind: "throw" | "reject"): Promise<string> => {
    const file = path.join(dir, `fatal-${kind}.mjs`)
    const fail =
      kind === "throw"
        ? 'setImmediate(() => { throw new Error("fatal for grace@example.com") })'
        : 'void Promise.reject(new Error("fatal for grace@example.com"))'
    await writeFile(file, `process.on("SIGUSR2", () => { ${fail} })\n`)
    return file
  }

  test.each([
    ["throw", "uncaughtException"],
    ["reject", "unhandledRejection"],
  ] as const)(
    "%s: logged, then the process exits 1",
    async (kind, event) => {
      const trace = path.join(dir, "trace.jsonl")
      const run = await startServer({
        env: { TRACE_FILE: trace },
        nodeArgs: ["--import", await preload(kind)],
      })
      await run.waitFor('"event":"startup"')
      run.kill("SIGUSR2")
      expect(await run.closed).toBe(1)
      const line: unknown = JSON.parse(await run.waitFor(`"event":"${event}"`))
      expect(line).toMatchObject({ level: "error", error: { name: "Error" } })
      expect(JSON.stringify(line)).toContain("fatal for [redacted]")
      expect(run.stdout()).toContain('"event":"stopped"')
      const traced = await readFile(trace, "utf8")
      expect(traced).toContain(event)
      expect(traced).not.toContain("grace@example.com")
    },
    30_000
  )
})

describe("the trace and the dev server", () => {
  // `npm run dev` serves files under the app's root through Vite, and can be
  // published as a Bot Page: the trace must not be among them.
  test("neither trace file can be fetched; the trace reader still works", async () => {
    const name = `test-${String(process.pid)}-${String(Date.now())}`
    const dataDir = path.join(appRoot, "data")
    const inData = path.join(dataDir, `${name}.jsonl`)
    // Outside the app but, in a monorepo, inside what Vite may serve (/@fs/).
    const beside = path.join(appRoot, "..", `.${name}.jsonl`)
    for (const trace of [inData, beside]) {
      cleanup.push(async () => {
        await rm(trace, { force: true })
        await rm(trace.replace(/\.jsonl$/, ".1.jsonl"), { force: true })
      })
    }
    await mkdir(dataDir, { recursive: true })
    // Anything else in data/, such as a block's store, is kept out too.
    const store = path.join(dataDir, `${name}-store.json`)
    cleanup.push(async () => {
      await rm(store, { force: true })
    })
    await writeFile(store, '{"store":"store-marker"}')

    for (const trace of [inData, beside]) {
      const rotated = trace.replace(/\.jsonl$/, ".1.jsonl")
      await writeFile(rotated, '{"event":"rotated-marker"}\n')
      const run = await startServer({ env: { TRACE_FILE: trace } })
      await run.waitFor('"event":"startup"')
      await fetch(`${run.base}/api/health?q=active-marker`)
      await fetch(`${run.base}/active-marker`)
      await fileContains(trace, "active-marker")

      const rel = path.relative(appRoot, trace)
      const relRotated = path.relative(appRoot, rotated)
      for (const probe of [
        `/${rel}`,
        `/${relRotated}`,
        `/@fs${trace}`,
        `/@fs${rotated}`,
        `/${rel}?raw`,
        `/${rel}?import`,
        `/data/${name}-store.json`,
        `/@fs${store}`,
      ]) {
        const text = await (await fetch(`${run.base}${probe}`)).text()
        expect(text, probe).not.toContain("active-marker")
        expect(text, probe).not.toContain("rotated-marker")
        expect(text, probe).not.toContain("store-marker")
      }
      // Vite's own deny list still applies.
      expect(await (await fetch(`${run.base}/.npmrc`)).text()).not.toContain("ignore-scripts")
      run.kill("SIGTERM")
      expect(await run.closed).toBe(0)
    }
  }, 60_000)

  test("a symlink in what Vite serves does not lead to the trace, or to data/", async () => {
    const name = `alias-${String(process.pid)}-${String(Date.now())}`
    const dataDir = path.join(appRoot, "data")
    await mkdir(dataDir, { recursive: true })
    const trace = path.join(dataDir, `${name}.jsonl`)
    const rotated = trace.replace(/\.jsonl$/, ".1.jsonl")
    // Outside the app too: denied by name, but an alias has another name.
    const outside = path.join(dir, `${name}.jsonl`)
    const outsideRotated = outside.replace(/\.jsonl$/, ".1.jsonl")
    // Aliases that already exist in the served tree, with harmless names.
    const links: [string, string][] = [
      [path.join(appRoot, "src", `${name}-active.txt`), trace],
      [path.join(appRoot, "src", `${name}-rotated.txt`), rotated],
      [path.join(appRoot, `${name}-data`), dataDir],
      [path.join(appRoot, "src", `${name}-out-active.txt`), outside],
      [path.join(appRoot, "src", `${name}-out-rotated.txt`), outsideRotated],
    ]
    cleanup.push(async () => {
      for (const file of [trace, rotated, ...links.map(([link]) => link)]) {
        await rm(file, { force: true })
      }
    })
    for (const [link, target] of links) await symlink(target, link)

    for (const [active, old] of [
      [trace, rotated],
      [outside, outsideRotated],
    ] as const) {
      await writeFile(old, '{"event":"rotated-marker"}\n')
      const run = await startServer({ env: { TRACE_FILE: active } })
      await run.waitFor('"event":"startup"')
      await fetch(`${run.base}/active-marker`)
      await fileContains(active, "active-marker")

      const dataAliasTrace = path.join(appRoot, `${name}-data`, path.basename(trace))
      const probes = [
        ...links.flatMap(([link]) => {
          const rel = `/${path.relative(appRoot, link)}`
          return [rel, `${rel}?raw`, `${rel}?import`, `${rel}?url`, `${rel}?inline`, `/@fs${link}`]
        }),
        `/${name}-data/${path.basename(trace)}`,
        `/${name}-data/${path.basename(rotated)}`,
        `/@fs${dataAliasTrace}`,
      ]
      for (const probe of probes) {
        const text = await (await fetch(`${run.base}${probe}`)).text()
        expect(text, probe).not.toContain("active-marker")
        expect(text, probe).not.toContain("rotated-marker")
      }
      // The rest of the app is still served.
      expect((await fetch(`${run.base}/src/main.tsx`)).status).toBe(200)
      run.kill("SIGTERM")
      expect(await run.closed).toBe(0)
    }
  }, 60_000)
})
