// Starts the app on 127.0.0.1:<port from botyard.json>.
//
//   node server/index.ts         serves the built UI from dist/client, read at startup (npm start)
//   node server/index.ts --dev   serves the UI through Vite, with hot reload (npm run dev)
//
// Logs are JSON lines on stdout and stderr; recent ones are also kept in
// data/trace.jsonl, which `npm run trace` prints. See "When the app
// misbehaves" in the README.
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import path from "node:path"
import { BotPageConfigError, createBotPage } from "@botyard/botpage"
import { listenLoopback } from "@botyard/botpage/node"
import { createRuntime, TransportError } from "@botyard/runtime"
import { createApp, type Middleware } from "./app.ts"
import { appRoot, ConfigError, HOST, loadConfig } from "./config.ts"
import { createLog } from "./log.ts"
import { runtimeCheck, type ReadyChecks } from "./ready.ts"
import { loadStatic, StaticLoadError, type StaticFiles } from "./static.ts"
import { previousFile, TraceFile, traceFilePath, TraceUnavailableError } from "./trace.ts"

const dev = process.argv.includes("--dev")
// TRACE_FILE moves the trace (tests point it at a temporary directory); see trace.ts.
const { trace, traceDeny, traceError, traceOff } = openTrace()
const log = createLog({ trace })
// The trace is optional: when it cannot be kept, say so and carry on.
if (traceOff !== undefined) log.warn("trace_off", { message: traceOff })
let stopping = false

/** Stops at startup with one clear line, before anything listens. */
function fail(reason: string, message: string): never {
  log.error("startup_failed", { reason, message })
  process.stderr.write(`\n${message}\n`)
  process.exit(1)
}

if (traceError !== undefined) fail("config", traceError.message)
const config = await loadConfigOrFail()
const runtime = createRuntimeOrFail()
// /api/ready probes Botyard through a runtime of its own, so a probe never
// touches the tool list the app's own calls use.
const probe = createRuntimeOrFail()
const botpage = createBotPageOrFail()

const server = createServer()
let ui: Middleware | undefined
let closeVite: (() => Promise<void>) | undefined
if (dev) {
  const { createServer: createVite } = await import("vite")
  const vite = await createVite({
    root: appRoot,
    appType: "spa",
    server: {
      middlewareMode: true,
      hmr: { server },
      // vite.config.ts keeps data/ out of what the dev server serves; this
      // adds the trace files themselves, wherever TRACE_FILE puts them.
      fs: { deny: traceDeny },
    },
  })
  ui = vite.middlewares
  closeVite = () => vite.close()
}
const staticFiles = dev ? undefined : await loadBuiltUi()

// What GET /api/ready checks. Add your own: a store that loads a file, a
// database connection. Each throws when not ready.
const readyChecks: ReadyChecks = {
  runtime: runtimeCheck(probe),
  ...(staticFiles && {
    ui: () => {
      if (!staticFiles.has("/index.html")) throw new Error("dist/client has no index.html")
    },
  }),
}

const handler = createApp({
  botpage,
  log,
  readyChecks,
  ...(staticFiles && { staticFiles }),
  ...(ui && { ui }),
})
server.on("request", (req, res) => {
  void handler(req, res)
})

try {
  await listenLoopback(server, config.port, { host: HOST, botpage })
} catch (err) {
  if (err instanceof Error && "code" in err && err.code === "EADDRINUSE") {
    fail(
      "port_in_use",
      `Port ${String(config.port)} is in use: is the app already running? ` +
        "Stop it, or set PORT to use another port."
    )
  }
  throw err
}
log.info("startup", {
  app: config.name,
  version: appVersion(),
  url: `http://${HOST}:${String(config.port)}`,
  port: config.port,
  mode: dev ? "dev" : "production",
  nodeEnv: process.env["NODE_ENV"] ?? null,
  transport: runtime.transportKind,
  node: process.version,
  pid: process.pid,
})

// Errors nothing caught. The app's state is unknown after one, so log it,
// and stop; the bot's service manager starts it again.
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (err: unknown) => {
    log.error(event, {}, err)
    process.exitCode = 1
    shutdown(event)
  })
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    shutdown(signal)
  })
}

/**
 * Stops taking new connections, lets requests in flight finish (up to 10
 * seconds), then exits. A second signal exits at once.
 */
function shutdown(reason: string): void {
  if (stopping) {
    process.exit(process.exitCode ?? 1)
  }
  stopping = true
  log.info("shutdown", { reason })
  const force = setTimeout(() => {
    log.warn("shutdown_forced", { reason: "requests still open after 10 s" })
    server.closeAllConnections()
    process.exit(process.exitCode ?? 1)
  }, 10_000)
  force.unref()
  // Vite's hot reload keeps a WebSocket open on this server for each dev tab,
  // and server.close() waits for those too: close them now, alongside the drain.
  const viteClosed = (closeVite?.() ?? Promise.resolve()).catch((err: unknown) => {
    log.warn("vite_close_failed", {}, err)
  })
  const httpClosed = new Promise<void>((resolve) => {
    server.close(() => {
      resolve()
    })
  })
  // Keep-alive connections with no request in flight would hold close() open.
  server.closeIdleConnections()
  void Promise.all([viteClosed, httpClosed]).then(() => {
    log.info("stopped")
    process.exit()
  })
}

type OpenedTrace = {
  trace?: TraceFile
  /** For the dev server's deny list. */
  traceDeny: string[]
  /** TRACE_FILE is set to somewhere unsafe: refuse to start. */
  traceError?: ConfigError
  /** Why there is no trace, when it could not be kept. */
  traceOff?: string
}

function openTrace(): OpenedTrace {
  try {
    const { file, real } = traceFilePath(appRoot)
    // Both spellings of both files.
    const traceDeny = [...new Set([file, real].flatMap((f) => [f, previousFile(f)]))]
    const trace = new TraceFile(real, {
      onError: (err) => {
        process.stderr.write(`trace: turned off, could not write ${file}: ${String(err)}\n`)
      },
    })
    return { trace, traceDeny }
  } catch (err) {
    if (err instanceof ConfigError) return { traceDeny: [], traceError: err }
    if (err instanceof TraceUnavailableError) return { traceDeny: [], traceOff: err.message }
    throw err
  }
}

async function loadConfigOrFail(): Promise<Awaited<ReturnType<typeof loadConfig>>> {
  try {
    return await loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) fail("config", err.message)
    throw err
  }
}

function createRuntimeOrFail(): ReturnType<typeof createRuntime> {
  try {
    // Talks to Botyard through the bot it runs in. See @botyard/runtime.
    return createRuntime()
  } catch (err) {
    if (err instanceof TransportError) {
      fail(
        "transport",
        `${err.message}\n\nThis app calls Botyard through the bot it runs in. ` +
          "Outside a bot, use `npm run dev:mock`."
      )
    }
    throw err
  }
}

function createBotPageOrFail(): ReturnType<typeof createBotPage> {
  try {
    return createBotPage({
      tools: runtime,
      logger: {
        warn: (message) => {
          log.warn("botpage", { message })
        },
      },
    })
  } catch (err) {
    // For example BOTYARD_DEV_VIEWER set with NODE_ENV=production.
    if (err instanceof BotPageConfigError) fail("config", err.message)
    throw err
  }
}

function appVersion(): string | null {
  try {
    const pkg: unknown = JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8"))
    const version = typeof pkg === "object" && pkg !== null && "version" in pkg ? pkg.version : null
    return typeof version === "string" ? version : null
  } catch {
    return null
  }
}

async function loadBuiltUi(): Promise<StaticFiles> {
  const dir = path.join(appRoot, "dist", "client")
  try {
    return await loadStatic(dir)
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      fail("no_build", `No built UI in ${dir}. Run \`npm run build\` first.`)
    }
    if (err instanceof StaticLoadError) fail("static", err.message)
    throw err
  }
}
