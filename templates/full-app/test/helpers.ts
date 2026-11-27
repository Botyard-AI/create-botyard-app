import { fileURLToPath } from "node:url"
import { createServer, type Server } from "node:http"
import { createBotPage } from "@botyard/botpage"
import { listenLoopback } from "@botyard/botpage/node"
import { createRuntime, loadMockFixtures, type Runtime } from "@botyard/runtime"
import { afterEach } from "vitest"
import { createApp, type AppOptions } from "../server/app.ts"
import { createLog, type Log } from "../server/log.ts"
import type { TraceFile } from "../server/trace.ts"

/** The mock runtime, loaded with the same fixtures as `npm run dev:mock`. */
export function mockRuntime(): Runtime {
  const fixtures = loadMockFixtures(fileURLToPath(new URL("../fixtures/dev.json", import.meta.url)))
  return createRuntime({ transport: "mock", mock: fixtures })
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => {
            resolve()
          })
        })
    )
  )
})

/** A log that keeps its lines (and writes them to `trace`, if given) instead of printing them. */
export function captureLog(trace?: TraceFile): { log: Log; lines: string[] } {
  const lines: string[] = []
  const log = createLog({
    trace,
    write: (_level, line) => {
      lines.push(line)
    },
  })
  return { log, lines }
}

/**
 * Starts the app on a free loopback port and returns its base URL. Its log is
 * silent unless you pass one, and /api/ready checks the mock runtime.
 */
export async function startApp(options: Omit<AppOptions, "botpage"> = {}): Promise<string> {
  const runtime = mockRuntime()
  const botpage = createBotPage({ tools: runtime, env: {} })
  const handler = createApp({
    botpage,
    log: captureLog().log,
    readyChecks: { runtime: () => runtime.listTools({ refresh: true }) },
    ...options,
  })
  const server = createServer((req, res) => void handler(req, res))
  servers.push(server)
  const { port } = await listenLoopback(server, 0, { botpage })
  return `http://127.0.0.1:${String(port)}`
}

/** A request as the Bot Page proxy sends it, for the given viewer. */
export function asViewer(subject: string): RequestInit {
  return { headers: { "x-forwarded-user": subject } }
}
