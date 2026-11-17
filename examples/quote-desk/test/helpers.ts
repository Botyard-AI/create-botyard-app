import { fileURLToPath } from "node:url"
import { createServer, type Server } from "node:http"
import { createBotPage } from "@botyard/botpage"
import { listenLoopback } from "@botyard/botpage/node"
import { createRuntime, loadMockFixtures, type MockHandler, type Runtime } from "@botyard/runtime"
import { afterEach } from "vitest"
import { createApp, type AppOptions } from "../server/app.ts"
import { MEMBER_CACHE } from "../server/members.ts"
import { CRM_SEED } from "../server/quotes/crm-seed.ts"
import { QuoteDesk } from "../server/quotes/desk.ts"
import { SettingsStore } from "../server/quotes/settings.ts"
import { ERP_SEED } from "../server/quotes/erp-seed.ts"

/** The mock runtime, loaded with the same fixtures as `npm run dev:mock`. */
export function mockRuntime(overrides: Readonly<Record<string, MockHandler>> = {}): Runtime {
  const fixtures = loadMockFixtures(fileURLToPath(new URL("../fixtures/dev.json", import.meta.url)))
  return createRuntime({
    transport: "mock",
    mock: { ...fixtures, tools: { ...fixtures.tools, ...overrides } },
  })
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
  options: Partial<Omit<AppOptions, "botpage">> & {
    /** Member cache settings. Default: the app's own (MEMBER_CACHE). */
    members?: Parameters<typeof createBotPage>[0]["members"]
  } = {}
): Promise<string> {
  const tools = options.tools ?? mockRuntime()
  const botpage = createBotPage({
    tools,
    env: {},
    members: options.members ?? MEMBER_CACHE,
  })
  const handler = createApp({
    botpage,
    tools,
    desk: options.desk ?? memoryDesk(),
    settings: options.settings ?? new SettingsStore(),
    ...(options.staticFiles && { staticFiles: options.staticFiles }),
    ...(options.ui && { ui: options.ui }),
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
