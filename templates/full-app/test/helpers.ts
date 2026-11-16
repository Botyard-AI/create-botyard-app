import { fileURLToPath } from "node:url"
import { createServer, type Server } from "node:http"
import { createBotPage } from "@botyard/botpage"
import { listenLoopback } from "@botyard/botpage/node"
import { createRuntime, loadMockFixtures, type Runtime } from "@botyard/runtime"
import { afterEach } from "vitest"
import { createApp, type AppOptions } from "../server/app.ts"

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

/** Starts the app on a free loopback port and returns its base URL. */
export async function startApp(options: Omit<AppOptions, "botpage"> = {}): Promise<string> {
  const botpage = createBotPage({ tools: mockRuntime(), env: {} })
  const handler = createApp({ botpage, ...options })
  const server = createServer((req, res) => void handler(req, res))
  servers.push(server)
  const { port } = await listenLoopback(server, 0, { botpage })
  return `http://127.0.0.1:${String(port)}`
}

/** A request as the Bot Page proxy sends it, for the given viewer. */
export function asViewer(subject: string): RequestInit {
  return { headers: { "x-forwarded-user": subject } }
}
