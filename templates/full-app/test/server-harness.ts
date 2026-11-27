// Helpers for test/server.test.ts: start the real server (server/index.ts) as
// a child process, and a fake Botyard to put behind it.
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const appRoot = fileURLToPath(new URL("..", import.meta.url))

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
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

/** `value[key]` when value is an object that has it. */
function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined
  const found: unknown = Object.getOwnPropertyDescriptor(value, key)?.value
  return found
}

/** A deferred: a promise and the function that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

export type ServerRun = {
  readonly port: number
  readonly base: string
  readonly kill: (signal: NodeJS.Signals) => void
  /** Exit code, once the process has exited and its output is all read. */
  readonly closed: Promise<number | null>
  readonly stdout: () => string
  readonly stderr: () => string
  /** The first line of output (stdout or stderr) containing `text`. */
  readonly waitFor: (text: string) => Promise<string>
}

type StartOptions = {
  env?: Record<string, string>
  /** Extra node flags, such as `--import` of a test preload. */
  nodeArgs?: readonly string[]
  dev?: boolean
}

/** Starts server/index.ts on a free port, with the mock runtime unless `env` says otherwise. */
export async function startServer({
  env = {},
  nodeArgs = [],
  dev = true,
}: StartOptions = {}): Promise<ServerRun> {
  const port = await freePort()
  const defaultTrace = path.join(
    tmpdir(),
    `full-app-test-${String(process.pid)}-${String(port)}.jsonl`
  )
  leftovers.push(defaultTrace, defaultTrace.replace(/\.jsonl$/, ".1.jsonl"))
  const child = spawn(
    process.execPath,
    [...nodeArgs, "server/index.ts", ...(dev ? ["--dev"] : [])],
    {
      cwd: appRoot,
      env: {
        PATH: process.env["PATH"] ?? "",
        NODE_ENV: "development",
        BOTYARD_RUNTIME_TRANSPORT: "mock",
        BOTYARD_RUNTIME_MOCK_FIXTURES: "fixtures/dev.json",
        PORT: String(port),
        // Never the app's own data/trace.jsonl.
        TRACE_FILE: defaultTrace,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
  started.push(child)
  let out = ""
  let err = ""
  const waiters: { text: string; resolve: (line: string) => void }[] = []
  const check = (): void => {
    for (const w of [...waiters]) {
      const line = `${out}\n${err}`.split("\n").find((l) => l.includes(w.text))
      if (line !== undefined) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(line)
      }
    }
  }
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString()
    check()
  })
  child.stderr.on("data", (chunk: Buffer) => {
    err += chunk.toString()
    check()
  })
  // "close", not "exit": it comes after the output has all been read.
  const closed = new Promise<number | null>((resolve) => {
    child.once("close", (code) => {
      resolve(code)
    })
  })
  return {
    port,
    base: `http://127.0.0.1:${String(port)}`,
    kill: (signal) => {
      child.kill(signal)
    },
    closed,
    stdout: () => out,
    stderr: () => err,
    waitFor: (text) =>
      new Promise((resolve, reject) => {
        waiters.push({ text, resolve })
        check()
        void closed.then(() => {
          reject(new Error(`exited before "${text}"\n${out}\n${err}`))
        })
      }),
  }
}

const started: { kill: (signal: NodeJS.Signals) => boolean }[] = []
const leftovers: string[] = []

/** Kills every server a test started and removes their trace files. Call from afterEach. */
export async function stopServers(): Promise<void> {
  for (const child of started.splice(0)) child.kill("SIGKILL")
  await Promise.all(leftovers.splice(0).map((file) => rm(file, { force: true })))
}

export type FakeBotyard = {
  /** For BOTYARD_RUNTIME_MCP_URL. */
  readonly url: string
  /** Resolves when the next tools/call arrives; the call waits until `release`. */
  holdCalls(): { arrived: Promise<void>; release: () => void }
  /** From now on, tools/list never answers. */
  hangLists(): void
  readonly close: () => Promise<void>
}

/**
 * A stand-in for the bot's MCP endpoint: answers tools/list and tools/call
 * (list_org_members, from fixtures/dev.json) over JSON-RPC, as the OpenClaw
 * bridge's loopback proxy does.
 */
export async function fakeBotyard(): Promise<FakeBotyard> {
  const fixtures: unknown = JSON.parse(
    readFileSync(new URL("../fixtures/dev.json", import.meta.url), "utf8")
  )
  const membersResult = field(field(field(fixtures, "tools"), "list_org_members"), "result")

  let hold: { arrived: () => void; released: Promise<void> } | null = null
  let listsHang = false
  const server: Server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString()
    })
    req.on("end", () => {
      void (async () => {
        const rpc: unknown = JSON.parse(body)
        const id = field(rpc, "id") ?? null
        const method = field(rpc, "method")
        const answer = (result: unknown): void => {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ jsonrpc: "2.0", id, result }))
        }
        if (method === "tools/list") {
          if (listsHang) return
          answer({ tools: [{ name: "list_org_members", inputSchema: { type: "object" } }] })
        } else if (method === "tools/call") {
          if (hold !== null) {
            const current = hold
            hold = null
            current.arrived()
            await current.released
          }
          answer({ content: [], structuredContent: membersResult })
        } else {
          res.writeHead(404).end()
        }
      })()
    })
  })
  const port = await freePort()
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve)
  })
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    holdCalls: () => {
      const arrived = deferred()
      const released = deferred()
      hold = { arrived: arrived.resolve, released: released.promise }
      return { arrived: arrived.promise, release: released.resolve }
    },
    hangLists: () => {
      listsHang = true
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}
