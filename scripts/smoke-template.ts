// Runs `npm run smoke` against the built full-app template, as CI does after
// `pnpm run build`: starts it the way `npm start` does (NODE_ENV=production,
// serving dist/client), with the mock runtime and its fixtures, on a free
// port, then runs the template's smoke script against it and stops it.
//
// Usage: node scripts/smoke-template.ts   (run `pnpm run build` first)
// Exits with the smoke script's status, or 1 if the app does not start.

import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"

const app = path.join(import.meta.dirname, "..", "templates", "full-app")

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

let status = 1
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
    server.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`the app exited with ${String(code)} before starting:\n${out}`))
    })
  })
  const smoke = spawn(process.execPath, ["scripts/smoke.ts", `http://127.0.0.1:${String(port)}`], {
    cwd: app,
    stdio: "inherit",
  })
  status = await new Promise<number>((resolve) => {
    smoke.once("exit", (code) => {
      resolve(code ?? 1)
    })
  })
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
} finally {
  server.kill("SIGTERM")
  await rm(traceDir, { recursive: true, force: true })
}
process.exit(status)
