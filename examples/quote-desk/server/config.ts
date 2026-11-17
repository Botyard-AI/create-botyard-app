import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** The app's root directory, the one holding botyard.json. */
export const appRoot = fileURLToPath(new URL("..", import.meta.url))

/** Bot Page apps listen on loopback only: the Bot Page proxy is the way in. */
export const HOST = "127.0.0.1"

type AppConfig = {
  /** The Bot Page name (`expose_botpage`'s `name`). */
  readonly name: string
  /** The loopback port the app listens on and the Bot Page exposes. */
  readonly port: number
}

export class ConfigError extends Error {
  override name = "ConfigError"
}

/** Reads botyard.json. `PORT` in the environment overrides its port. */
export async function loadConfig(
  root: string = appRoot,
  env: NodeJS.ProcessEnv = process.env
): Promise<AppConfig> {
  const file = path.join(root, "botyard.json")
  let json: unknown
  try {
    json = JSON.parse(await readFile(file, "utf8"))
  } catch (err) {
    throw new ConfigError(
      `Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  return parseConfig(json, env)
}

export function parseConfig(json: unknown, env: NodeJS.ProcessEnv = {}): AppConfig {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new ConfigError("botyard.json must be a JSON object.")
  }
  const name = "name" in json ? json.name : undefined
  if (typeof name !== "string" || name.length < 1 || name.length > 80) {
    throw new ConfigError('botyard.json "name" must be a string of 1 to 80 characters.')
  }
  const fromEnv = env["PORT"]
  let port: number | null
  if (fromEnv === undefined) port = parsePort("port" in json ? json.port : undefined)
  else port = /^\d+$/.test(fromEnv) ? parsePort(Number(fromEnv)) : null
  if (port === null) {
    throw new ConfigError('botyard.json "port" (or PORT) must be an integer from 1 to 65535.')
  }
  return { name, port }
}

function parsePort(port: unknown): number | null {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535
    ? port
    : null
}
