// scripts/smoke-template.ts against stand-in apps: it must wait for the app
// to stop before it removes the app's trace directory or returns, and fail
// when the app does not start or does not stop.
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

const runner = path.join(import.meta.dirname, "smoke-template.ts")
let app: string

beforeEach(async () => {
  app = await mkdtemp(path.join(os.tmpdir(), "smoke-template-test-"))
  await mkdir(path.join(app, "server"))
  await mkdir(path.join(app, "scripts"))
  // A smoke script that only checks the app answers.
  await writeFile(
    path.join(app, "scripts", "smoke.ts"),
    `const res = await fetch(new URL("/api/health", process.argv[2]))
process.exit(res.status === 200 ? 0 : 1)
`
  )
})
afterEach(async () => {
  // Never leave a stand-in running, whatever the runner did.
  const pid = Number(await readFile(path.join(app, "pid.txt"), "utf8").catch(() => "0"))
  if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL")
  await rm(app, { recursive: true, force: true })
})

/**
 * A stand-in server. On SIGTERM it waits `drainMs`, records whether its trace
 * directory still exists, and exits 0; with `ignoreTerm` it keeps running.
 * It counts the SIGTERMs it gets (terms.txt) and notes when it starts draining.
 * `failAtStart` exits 1 before it listens. It notes its pid and TRACE_FILE.
 */
async function standIn(
  options: { drainMs?: number; ignoreTerm?: boolean; failAtStart?: boolean } = {}
): Promise<void> {
  const { drainMs = 0, ignoreTerm = false, failAtStart = false } = options
  await writeFile(
    path.join(app, "server", "index.ts"),
    `import { createServer } from "node:http"
import { existsSync, writeFileSync } from "node:fs"
import path from "node:path"
const trace = process.env.TRACE_FILE
writeFileSync("pid.txt", String(process.pid))
writeFileSync("trace-dir.txt", path.dirname(trace))
if (${String(failAtStart)}) process.exit(1)
const server = createServer((req, res) => { res.end("{}") })
server.listen(Number(process.env.PORT), "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "startup" }))
})
let terms = 0
process.on("SIGTERM", () => {
  terms += 1
  writeFileSync("terms.txt", String(terms))
  if (${String(ignoreTerm)} || terms > 1) return
  writeFileSync("draining.txt", "")
  setTimeout(() => {
    writeFileSync("stopped.txt", existsSync(path.dirname(trace)) ? "trace dir present" : "trace dir gone")
    process.exit(0)
  }, ${String(drainMs)})
})
`
  )
}

/**
 * The runner's exit code. Its output is not kept: a stand-in left running
 * would hold an output pipe open. A runner still going after 30 s is killed,
 * and that counts as a failure (-1).
 */
function run(
  env: Record<string, string> = {},
  started: (runner: ChildProcess) => void = () => {}
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runner, app], {
      env: { ...process.env, ...env },
      stdio: "ignore",
    })
    started(child)
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
    }, 30_000)
    child.once("exit", (code) => {
      clearTimeout(timer)
      resolve(code ?? -1)
    })
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("smoke-template", () => {
  it("returns only after an app that drains slowly has stopped, then removes its trace directory", async () => {
    await standIn({ drainMs: 800 })
    assert.equal(await run(), 0)
    assert.equal(await readFile(path.join(app, "stopped.txt"), "utf8"), "trace dir present")
    assert.equal(alive(Number(await readFile(path.join(app, "pid.txt"), "utf8"))), false)
    assert.equal(existsSync(await readFile(path.join(app, "trace-dir.txt"), "utf8")), false)
  })

  it("stopped while the app drains, it waits for that drain without a second SIGTERM", async () => {
    await standIn({ drainMs: 1500 })
    const code = await run({}, (child) => {
      // Once the app has its first SIGTERM (the run's normal stop), stop the runner.
      const poll = setInterval(() => {
        if (existsSync(path.join(app, "draining.txt"))) {
          clearInterval(poll)
          child.kill("SIGTERM")
        }
      }, 20)
    })
    assert.equal(code, 1)
    assert.equal(await readFile(path.join(app, "terms.txt"), "utf8"), "1")
    assert.equal(await readFile(path.join(app, "stopped.txt"), "utf8"), "trace dir present")
    assert.equal(alive(Number(await readFile(path.join(app, "pid.txt"), "utf8"))), false)
    assert.equal(existsSync(await readFile(path.join(app, "trace-dir.txt"), "utf8")), false)
  })

  it("fails, and cleans up, when the app exits before starting", async () => {
    await standIn({ failAtStart: true })
    assert.equal(await run(), 1)
    assert.equal(existsSync(await readFile(path.join(app, "trace-dir.txt"), "utf8")), false)
  })

  it("kills an app that does not stop, and fails", async () => {
    await standIn({ ignoreTerm: true })
    assert.equal(await run({ SMOKE_STOP_GRACE_MS: "500" }), 1)
    assert.equal(alive(Number(await readFile(path.join(app, "pid.txt"), "utf8"))), false)
    assert.equal(existsSync(await readFile(path.join(app, "trace-dir.txt"), "utf8")), false)
  })
})
