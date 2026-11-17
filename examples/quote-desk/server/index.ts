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
import { appRoot, HOST, loadConfig } from "./config.ts"
import { CRM_SEED } from "./quotes/crm-seed.ts"
import { QuoteDesk } from "./quotes/desk.ts"
import { ERP_SEED } from "./quotes/erp-seed.ts"
import { loadState, saveState } from "./quotes/store.ts"
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
const botpage = createBotPage({ tools: runtime })

// Quotes live in one JSON file, data/state.json by default (QUOTE_DESK_DATA_DIR
// moves it). DEMO_TODAY (YYYY-MM-DD) overrides the demo's date, which is
// otherwise the seed's.
const stateFile = path.join(
  process.env["QUOTE_DESK_DATA_DIR"] ?? path.join(appRoot, "data"),
  "state.json"
)
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
  dev ? { botpage, desk, ...(ui && { ui }) } : { botpage, desk, staticFiles: await loadBuiltUi() }
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
