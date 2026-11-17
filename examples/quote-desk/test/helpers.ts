import { fileURLToPath } from "node:url"
import { createServer, type Server } from "node:http"
import { createBotPage } from "@botyard/botpage"
import { listenLoopback } from "@botyard/botpage/node"
import { createRuntime, loadMockFixtures, type Runtime } from "@botyard/runtime"
import { afterEach } from "vitest"
import { createApp, type AppOptions } from "../server/app.ts"
import { CRM_SEED } from "../server/quotes/crm-seed.ts"
import { QuoteDesk } from "../server/quotes/desk.ts"
import { ERP_SEED } from "../server/quotes/erp-seed.ts"

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

/** A fresh desk on the seed data, in memory, with a fixed clock. */
export function memoryDesk(): QuoteDesk {
  return new QuoteDesk({
    erp: ERP_SEED,
    crm: CRM_SEED,
    now: () => new Date("2026-11-10T09:00:00Z"),
  })
}

/** Starts the app on a free loopback port and returns its base URL. */
export async function startApp(
  options: Omit<AppOptions, "botpage" | "desk"> & { desk?: QuoteDesk } = {}
): Promise<string> {
  const botpage = createBotPage({ tools: mockRuntime(), env: {} })
  const handler = createApp({ botpage, desk: options.desk ?? memoryDesk(), ...options })
  const server = createServer((req, res) => void handler(req, res))
  servers.push(server)
  const { port } = await listenLoopback(server, 0, { botpage })
  return `http://127.0.0.1:${String(port)}`
}

/** A request as the Bot Page proxy sends it, for the given viewer. */
export function asViewer(subject: string): RequestInit {
  return { headers: { "x-forwarded-user": subject } }
}
