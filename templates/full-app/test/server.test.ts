// Starts the real server (server/index.ts) as a child process, the way
// `npm run dev:mock` does, and checks how it starts, logs and stops.
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { connect, createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { loadConfig } from "../server/config.ts"

const appRoot = fileURLToPath(new URL("..", import.meta.url))

let dir: string
const children: ChildProcess[] = []
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "full-app-server-"))
})
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL")
  await rm(dir, { recursive: true, force: true })
})

async function packageVersion(): Promise<unknown> {
  const pkg: unknown = JSON.parse(await readFile(path.join(appRoot, "package.json"), "utf8"))
  return typeof pkg === "object" && pkg !== null && "version" in pkg ? pkg.version : undefined
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      probe.close(() => {
        resolve(port)
      })
    })
  })
}

type Run = {
  child: ChildProcess
  stdout: () => string
  stderr: () => string
  exited: Promise<number | null>
  /** Resolves with the first stdout line containing `text`. */
  waitFor: (text: string) => Promise<string>
}

function start(env: Record<string, string>): Run {
  const child = spawn(process.execPath, ["server/index.ts", "--dev"], {
    cwd: appRoot,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: dir,
      NODE_ENV: "development",
      BOTYARD_RUNTIME_TRANSPORT: "mock",
      BOTYARD_RUNTIME_MOCK_FIXTURES: "fixtures/dev.json",
      TRACE_FILE: path.join(dir, "trace.jsonl"),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  children.push(child)
  let out = ""
  let err = ""
  const waiters: { text: string; resolve: (line: string) => void }[] = []
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString()
    for (const w of [...waiters]) {
      const line = out.split("\n").find((l) => l.includes(w.text))
      if (line !== undefined) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(line)
      }
    }
  })
  child.stderr.on("data", (chunk: Buffer) => {
    err += chunk.toString()
  })
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      resolve(code)
    })
  })
  return {
    child,
    stdout: () => out,
    stderr: () => err,
    exited,
    waitFor: (text) =>
      new Promise((resolve, reject) => {
        const line = out.split("\n").find((l) => l.includes(text))
        if (line !== undefined) resolve(line)
        else waiters.push({ text, resolve })
        void exited.then(() => {
          reject(new Error(`exited before "${text}"\n${out}\n${err}`))
        })
      }),
  }
}

describe("the server process", () => {
  test("logs one startup line, serves, and stops cleanly on SIGTERM", async () => {
    const port = await freePort()
    const run = start({ PORT: String(port) })
    const startup: unknown = JSON.parse(await run.waitFor('"event":"startup"'))
    expect(startup).toMatchObject({
      level: "info",
      app: (await loadConfig(appRoot, {})).name,
      port,
      transport: "mock",
      nodeEnv: "development",
      mode: "dev",
    })
    expect(startup).toHaveProperty("version", await packageVersion())

    const base = `http://127.0.0.1:${String(port)}`
    expect((await fetch(`${base}/api/health`)).status).toBe(200)
    expect(await (await fetch(`${base}/api/ready`)).json()).toMatchObject({ ok: true })

    run.child.kill("SIGTERM")
    expect(await run.exited).toBe(0)
    expect(run.stdout()).toContain('"event":"shutdown","reason":"SIGTERM"')
    expect(run.stdout()).toContain('"event":"stopped"')

    const trace = await readFile(path.join(dir, "trace.jsonl"), "utf8")
    expect(trace).toContain('"path":"/api/ready"')
    expect(trace).toContain('"event":"startup"')
  }, 30_000)

  test("lets a request in flight finish before it stops", async () => {
    const port = await freePort()
    const run = start({ PORT: String(port) })
    await run.waitFor('"event":"startup"')
    // Send half a request, so it is in flight when SIGTERM arrives.
    const socket = connect(port, "127.0.0.1")
    await new Promise((resolve) => {
      socket.once("connect", resolve)
    })
    socket.write("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n")
    let answer = ""
    socket.on("data", (chunk: Buffer) => {
      answer += chunk.toString()
    })
    run.child.kill("SIGTERM")
    await run.waitFor('"event":"shutdown"')
    await new Promise((resolve) => {
      setTimeout(resolve, 200)
    })
    expect(run.child.exitCode).toBeNull()
    socket.end("\r\n")
    expect(await run.exited).toBe(0)
    expect(answer).toMatch(/^HTTP\/1\.1 200/)
    expect(answer).toContain('{"ok":true}')
  }, 30_000)

  test.each([
    ["a bad PORT", { PORT: "not-a-port" }, "PORT"],
    [
      "the dev viewer in production",
      { NODE_ENV: "production", BOTYARD_DEV_VIEWER: "ada@example.com" },
      "BOTYARD_DEV_VIEWER",
    ],
    ["no Botyard transport", { BOTYARD_RUNTIME_TRANSPORT: "carrier-pigeon" }, "npm run dev:mock"],
  ])(
    "fails fast with a clear message on %s",
    async (_label, env, hint) => {
      const run = start(env)
      expect(await run.exited).toBe(1)
      expect(run.stderr()).toContain(hint)
      expect(run.stderr()).toContain('"event":"startup_failed"')
      expect(run.stderr()).not.toMatch(/^\s+at /m)
    },
    30_000
  )
})
