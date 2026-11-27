// Runs `npm run smoke` against the built full-app template, as CI does after
// `pnpm run build`: starts it the way `npm start` does (NODE_ENV=production,
// serving dist/client), with the mock runtime and its fixtures, on a free
// port, then runs the template's smoke script against it and stops it.
//
// Usage: node scripts/smoke-template.ts [app-dir]   (run `pnpm run build` first)
// app-dir defaults to templates/full-app; tests pass a stand-in.
//
// Exits with the smoke script's status, or 1 if the app does not start or
// does not stop. It returns only once the app has exited (SIGTERM, then
// SIGKILL after 15 s), so nothing is left running and the app's temporary
// trace directory is removed only after the app stops writing to it.
// SIGINT or SIGTERM to this script stops the app the same way, and fails the run.

import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"

const app = process.argv[2] ?? path.join(import.meta.dirname, "..", "templates", "full-app")
// Tests shorten it.
const STOP_GRACE_MS = Number(process.env["SMOKE_STOP_GRACE_MS"] ?? 15_000)

/** Resolves with the exit code once `child` has exited and its output closed. */
function closed(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode ?? 1)
      return
    }
    child.once("close", (code) => {
      resolve(code ?? 1)
    })
    // A child that never started (spawn failed) emits "error", not "close".
    child.once("error", () => {
      resolve(1)
    })
  })
}

/** SIGTERM, then SIGKILL if it has not exited within the grace period. */
async function stop(child: ChildProcess, exited: Promise<number>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  const timer = setTimeout(() => {
    process.stderr.write(
      `the app did not stop within ${String(STOP_GRACE_MS / 1000)} s; killing it\n`
    )
    child.kill("SIGKILL")
  }, STOP_GRACE_MS)
  await exited
  clearTimeout(timer)
}

const port = await new Promise<number>((resolve, reject) => {
  const probe = createServer()
  probe.once("error", reject)
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address()
    probe.close(() => {
      resolve(typeof address === "object" && address !== null ? address.port : 0)
    })
  })
})
// Keep the run's trace out of the template's own data/.
const traceDir = await mkdtemp(path.join(os.tmpdir(), "smoke-template-"))

const server = spawn(process.execPath, ["server/index.ts"], {
  cwd: app,
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    BOTYARD_RUNTIME_TRANSPORT: "mock",
    BOTYARD_RUNTIME_MOCK_FIXTURES: "fixtures/dev.json",
    TRACE_FILE: path.join(traceDir, "trace.jsonl"),
  },
  stdio: ["ignore", "pipe", "inherit"],
})
const serverExited = closed(server)
let smoke: { child: ChildProcess; exited: Promise<number> } | undefined

let cleaning: Promise<void> | undefined

/**
 * Stops whatever is running, then removes the trace directory. Single-flight:
 * a second call (a signal during a normal stop, say) waits for the first
 * instead of signalling the app again. The app takes a second SIGTERM as
 * "exit now", which would cut its drain short.
 */
function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    await Promise.all([
      smoke ? stop(smoke.child, smoke.exited) : Promise.resolve(),
      stop(server, serverExited),
    ])
    await rm(traceDir, { recursive: true, force: true })
  })()
  return cleaning
}

// A signal records the cancellation and starts cleanup; the main path below
// still owns the exit, after joining that same cleanup, so a cancelled run
// always ends with 1 and never before the app has stopped. `on`, not `once`:
// a repeated signal must land here too rather than fall through to Node's
// default and kill this script with the app running and its trace left behind.
const run = { cancelled: false }
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    run.cancelled = true
    void cleanup()
  })
}

let status: number
try {
  await new Promise<void>((resolve, reject) => {
    let out = ""
    const timer = setTimeout(() => {
      reject(new Error(`the app did not start within 30 s:\n${out}`))
    }, 30_000)
    server.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString()
      if (out.includes('"event":"startup"')) {
        clearTimeout(timer)
        resolve()
      }
    })
    void serverExited.then((code) => {
      clearTimeout(timer)
      reject(new Error(`the app exited with ${String(code)} before starting:\n${out}`))
    })
  })
  // Cancelled while it started: cleanup is already stopping it, so do not
  // start a smoke run that cleanup would not stop.
  if (run.cancelled) throw new Error("cancelled")
  const child = spawn(process.execPath, ["scripts/smoke.ts", `http://127.0.0.1:${String(port)}`], {
    cwd: app,
    stdio: "inherit",
  })
  smoke = { child, exited: closed(child) }
  status = await smoke.exited
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  status = 1
}
await cleanup()
// A server that did not stop cleanly (killed, or a non-zero exit) fails the run.
if ((await serverExited) !== 0 || run.cancelled) status = 1
process.exit(status)
