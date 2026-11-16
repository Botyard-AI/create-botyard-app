// Starts the app on 127.0.0.1:<port from botyard.json>.
//
//   node server/index.ts         serves the built UI from dist/client (npm start)
//   node server/index.ts --dev   serves the UI through Vite, with hot reload (npm run dev)
import { createServer } from "node:http"
import path from "node:path"
import { createBotPage } from "@botyard/botpage"
import { listenLoopback } from "@botyard/botpage/node"
import { createRuntime, TransportError } from "@botyard/runtime"
import { createApp, type Middleware } from "./app.ts"
import { appRoot, HOST, loadConfig } from "./config.ts"

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
    ? { botpage, ...(ui && { ui }) }
    : { botpage, staticDir: path.join(appRoot, "dist", "client") }
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
