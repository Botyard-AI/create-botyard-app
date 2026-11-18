// Starts the app on 127.0.0.1:<port from botyard.json>.
//
//   node server/index.ts         serves the built UI from dist/client, read at startup (npm start)
//   node server/index.ts --dev   serves the UI through Vite, with hot reload (npm run dev)
import { createServer } from "node:http"
import path from "node:path"
import { createBotPage } from "@botyard/botpage"
import { listenLoopback } from "@botyard/botpage/node"
import { createRuntime, TransportError } from "@botyard/runtime"
import { createApp, type Middleware } from "./app.ts"
import { MEMBER_CACHE } from "./members.ts"
import { appRoot, HOST, loadConfig } from "./config.ts"
import { CRM_SEED } from "./quotes/crm-seed.ts"
import { QuoteDesk } from "./quotes/desk.ts"
import { ERP_SEED } from "./quotes/erp-seed.ts"
import { SettingsStore } from "./quotes/settings.ts"
import {
  loadSettings,
  loadState,
  readJson,
  saveSettings,
  saveState,
  writeJson,
} from "./quotes/store.ts"
import { HandoffStore, parseHandoffs } from "./review/handoffs.ts"
import { ReviewRelay } from "./review/relay.ts"
import { fileHosts as parseFileHosts } from "./review/verdict.ts"
import { loadStatic, StaticLoadError, type StaticFiles } from "./static.ts"

const dev = process.argv.includes("--dev")
const config = await loadConfig()

let runtime
try {
  // Talks to Botyard through the bot it runs in. See @botyard/runtime.
  runtime = createRuntime()
} catch (err) {
  if (err instanceof TransportError) {
    process.stderr.write(
      `${err.message}\n\nThis app calls Botyard through the bot it runs in. ` +
        "Outside a bot, use `npm run dev:mock`.\n"
    )
    process.exit(1)
  }
  throw err
}
// Approvals act on the member list, so keep it fresh: a removed or demoted
// member loses access within 30 s, and while the directory is unreachable the
// app refuses (503) rather than authorize from an older list.
const botpage = createBotPage({ tools: runtime, members: MEMBER_CACHE })

// Quotes live in one JSON file, data/state.json by default (QUOTE_DESK_DATA_DIR
// moves it). DEMO_TODAY (YYYY-MM-DD) overrides the demo's date, which is
// otherwise the seed's.
const dataDir = process.env["QUOTE_DESK_DATA_DIR"] ?? path.join(appRoot, "data")
const stateFile = path.join(dataDir, "state.json")
// Who approves: data/settings.json, edited on the Settings tab by org owners and admins.
const settingsFile = path.join(dataDir, "settings.json")
const today = process.env["DEMO_TODAY"]
if (today !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
  process.stderr.write("DEMO_TODAY must be a date like 2026-11-10.\n")
  process.exit(1)
}
const desk = new QuoteDesk({
  erp: ERP_SEED,
  crm: CRM_SEED,
  ...(today !== undefined && { today }),
  state: loadState(stateFile),
  save: (state) => {
    saveState(stateFile, state)
  },
})

const settings = new SettingsStore({
  settings: loadSettings(settingsFile),
  save: (next) => {
    saveSettings(settingsFile, next)
  },
})

// The reviewer bot's handoffs: data/handoffs.json. The relay hands quotes in
// finance review to the reviewer bot as workforce tasks (Settings picks the
// board) and records its verdicts. QUOTE_DESK_FILE_HOSTS lists the storage
// hosts verdict.json links may point at.
const handoffsFile = path.join(dataDir, "handoffs.json")
const handoffs = new HandoffStore({
  handoffs: readJson(handoffsFile, parseHandoffs),
  save: (next) => writeJson(handoffsFile, { handoffs: next }),
})
const fileHosts = parseFileHosts(process.env["QUOTE_DESK_FILE_HOSTS"])
const relay = new ReviewRelay({ desk, settings, handoffs, tools: runtime, fileHosts })
relay.start()

const server = createServer()
let ui: Middleware | undefined
if (dev) {
  const { createServer: createVite } = await import("vite")
  const vite = await createVite({
    root: appRoot,
    appType: "spa",
    server: { middlewareMode: true, hmr: { server } },
  })
  ui = vite.middlewares
}

const handler = createApp(
  dev
    ? { botpage, tools: runtime, desk, settings, relay, fileHosts, ...(ui && { ui }) }
    : {
        botpage,
        tools: runtime,
        desk,
        settings,
        relay,
        fileHosts,
        staticFiles: await loadBuiltUi(),
      }
)
server.on("request", (req, res) => {
  handler(req, res).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    if (!res.headersSent) res.writeHead(500).end()
    else res.destroy()
  })
})

await listenLoopback(server, config.port, { host: HOST, botpage })
process.stdout.write(
  `${config.name} listening on http://${HOST}:${String(config.port)} ` +
    `(${dev ? "dev" : "production"}, runtime: ${runtime.transportKind}). ` +
    "Publish it with `npm run expose`.\n"
)

async function loadBuiltUi(): Promise<StaticFiles> {
  const dir = path.join(appRoot, "dist", "client")
  try {
    return await loadStatic(dir)
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      process.stderr.write(`No built UI in ${dir}. Run \`npm run build\` first.\n`)
      process.exit(1)
    }
    if (err instanceof StaticLoadError) {
      process.stderr.write(`${err.message}\n`)
      process.exit(1)
    }
    throw err
  }
}
