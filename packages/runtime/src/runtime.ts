import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  BotyardError,
  InvalidInputError,
  ToolError,
  TransportError,
  UnknownToolError,
} from "./errors.ts"
import { bounded, contentText, isRecord } from "./internal.ts"
import { createBotyarddTransport, DEFAULT_BOTYARDD_PATH } from "./transports/botyardd.ts"
import { createMcpTransport, DEFAULT_MCP_PROXY_PORT } from "./transports/mcp.ts"
import { createMockTransport, loadMockFixtures, type MockOptions } from "./transports/mock.ts"
import {
  TRANSPORT_KINDS,
  type CallOptions,
  type Identity,
  type RequestOptions,
  type ToolCaller,
  type ToolDescriptor,
  type ToolResult,
  type Transport,
  type TransportKind,
} from "./types.ts"

export const DEFAULT_TIMEOUT_MS = 60_000

/** Environment variables this package reads. */
export const ENV = {
  /** Force a transport: `botyardd`, `mcp` or `mock`. */
  TRANSPORT: "BOTYARD_RUNTIME_TRANSPORT",
  /** Path to the `botyardd` binary. */
  BOTYARDD: "BOTYARD_RUNTIME_BOTYARDD",
  /** Full MCP endpoint URL, overriding the proxy port. Loopback URLs only. */
  MCP_URL: "BOTYARD_RUNTIME_MCP_URL",
  /** JSON fixture file for the mock transport. */
  MOCK_FIXTURES: "BOTYARD_RUNTIME_MOCK_FIXTURES",
} as const

export interface RuntimeOptions {
  /** Force a transport by kind, or pass your own. Overrides `BOTYARD_RUNTIME_TRANSPORT`. */
  transport?: TransportKind | Transport
  /** Environment to detect from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Path to `botyardd`. */
  botyarddPath?: string
  /**
   * Full MCP endpoint URL. Any host is accepted here, because this is an
   * explicit choice in application code. `BOTYARD_RUNTIME_MCP_URL` accepts
   * loopback URLs only.
   */
  mcpUrl?: string
  /** Tools and identity for the mock transport. */
  mock?: MockOptions
  /** Deadline for calls that pass no `timeoutMs`. Defaults to 60 s. */
  defaultTimeoutMs?: number
  /** `fetch` for the MCP transport. Injection point for tests. */
  fetch?: typeof fetch
}

export interface Runtime extends ToolCaller {
  /** The transport this runtime chose. */
  readonly transportKind: TransportKind
  /** Why it chose it, e.g. "daemon socket /home/x/.botyard/daemon.sock". */
  readonly transportReason: string
  /** The live tool list. Cached; pass `refresh` to fetch it again. */
  listTools(opts?: CallOptions & { refresh?: boolean }): Promise<readonly ToolDescriptor[]>
  /** Map a canonical name to its live name. Throws `UnknownToolError`. */
  resolveToolName(tool: string, opts?: CallOptions): Promise<string>
  /** The bot, its org and the transport in use. Cached after the first success. */
  getIdentity(opts?: CallOptions): Promise<Identity>
}

interface Selected {
  readonly transport: Transport
  readonly reason: string
}

/**
 * Choose a transport. In order:
 *
 * 1. `options.transport`, then `BOTYARD_RUNTIME_TRANSPORT`.
 * 2. `botyardd`, when the native daemon's socket exists.
 * 3. `mcp`, when `BOTYARD_RUNTIME_MCP_URL` or `MCP_PROXY_PORT` is set
 *    (the OpenClaw bridge's loopback proxy).
 *
 * The mock is never chosen automatically. When nothing matches, throws a
 * `TransportError` naming every signal it checked.
 */
export function selectTransport(options: RuntimeOptions = {}): Selected {
  const env = options.env ?? process.env
  const forced = options.transport ?? nonEmpty(env[ENV.TRANSPORT])
  if (typeof forced === "object")
    return { transport: forced, reason: "transport passed in options" }
  if (forced !== undefined) {
    if (!isTransportKind(forced)) {
      throw new TransportError(
        `${ENV.TRANSPORT} must be one of ${TRANSPORT_KINDS.join(", ")}, not "${forced}"`
      )
    }
    const reason =
      options.transport === undefined
        ? `${ENV.TRANSPORT}=${forced}`
        : `transport: "${forced}" in options`
    return { transport: forcedTransport(forced, options, env), reason }
  }

  const checked: string[] = []
  const socket = daemonSocket(env)
  if (socket !== undefined) {
    if (isSocket(socket))
      return { transport: botyardd(options, env), reason: `daemon socket ${socket}` }
    checked.push(`no botyardd daemon socket at ${socket}`)
  } else {
    checked.push("no botyardd socket path (BOTYARD_SOCKET, BOTYARD_HOME and HOME unset)")
  }
  const url = mcpUrl(options, env)
  if (url !== undefined) return { transport: mcp(options, url), reason: `MCP endpoint ${url}` }
  checked.push(`${ENV.MCP_URL} and MCP_PROXY_PORT unset`)
  throw new TransportError(
    `no Botyard transport found: ${checked.join("; ")}. ` +
      `Run inside a Botyard bot, or set ${ENV.TRANSPORT}=mock for tests and local development.`
  )
}

function isTransportKind(value: string): value is TransportKind {
  return TRANSPORT_KINDS.some((kind) => kind === value)
}

function forcedTransport(
  kind: TransportKind,
  options: RuntimeOptions,
  env: NodeJS.ProcessEnv
): Transport {
  switch (kind) {
    case "botyardd":
      return botyardd(options, env)
    case "mcp":
      return mcp(options, mcpUrl(options, env) ?? loopback(DEFAULT_MCP_PROXY_PORT))
    case "mock": {
      const fixtures = nonEmpty(env[ENV.MOCK_FIXTURES])
      const mock = options.mock ?? (fixtures === undefined ? {} : loadMockFixtures(fixtures))
      return createMockTransport(mock)
    }
  }
}

function botyardd(options: RuntimeOptions, env: NodeJS.ProcessEnv): Transport {
  const path =
    options.botyarddPath ??
    nonEmpty(env[ENV.BOTYARDD]) ??
    (existsSync(DEFAULT_BOTYARDD_PATH) ? DEFAULT_BOTYARDD_PATH : "botyardd")
  return createBotyarddTransport({ path, env })
}

function mcp(options: RuntimeOptions, url: string): Transport {
  return createMcpTransport({
    url,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
}

function mcpUrl(options: RuntimeOptions, env: NodeJS.ProcessEnv): string | undefined {
  // Application code may point anywhere: that is an explicit, reviewable choice.
  if (options.mcpUrl !== undefined) return options.mcpUrl
  // The environment is not trusted to send tool arguments and results
  // off-host: a URL from it must be loopback, like the bridge proxy itself.
  const fromEnv = nonEmpty(env[ENV.MCP_URL])
  if (fromEnv !== undefined) {
    if (!isLoopbackUrl(fromEnv)) {
      throw new TransportError(
        `${ENV.MCP_URL} must be a loopback URL (127.0.0.0/8, ::1 or localhost); ` +
          "to use another host, pass mcpUrl to createRuntime() from application code"
      )
    }
    return fromEnv
  }
  const port = nonEmpty(env["MCP_PROXY_PORT"])
  if (port === undefined) return undefined
  const n = Number(port)
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new TransportError(`MCP_PROXY_PORT is not a port: "${port}"`)
  return loopback(n)
}

/** True for an http(s) URL whose host is 127.0.0.0/8, ::1 or localhost. */
export function isLoopbackUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  const host = url.hostname.toLowerCase()
  if (host === "localhost" || host === "[::1]") return true
  // WHATWG URL normalises IPv4 forms (e.g. 0x7f.1, 2130706433) to dotted quads.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

function loopback(port: number): string {
  return `http://127.0.0.1:${port}/mcp`
}

/** Mirrors `socket_path` in botyard `runtime/runtime-local-protocol/src/paths.rs`. */
function daemonSocket(env: NodeJS.ProcessEnv): string | undefined {
  const socket = nonEmpty(env["BOTYARD_SOCKET"])
  if (socket !== undefined) return socket
  const home = nonEmpty(env["BOTYARD_HOME"])
  if (home !== undefined) return join(home, "daemon.sock")
  const user = nonEmpty(env["HOME"]) ?? (env === process.env ? safeHomedir() : undefined)
  return user === undefined ? undefined : join(user, ".botyard", "daemon.sock")
}

function isSocket(path: string): boolean {
  try {
    return statSync(path).isSocket()
  } catch {
    return false
  }
}

function safeHomedir(): string | undefined {
  try {
    return homedir() || undefined
  } catch {
    return undefined
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/** Refetch the tool list on a miss at most this often. */
const REFRESH_INTERVAL_MS = 5_000

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const { transport, reason } = selectTransport(options)
  const env = options.env ?? process.env
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  let tools: Promise<readonly ToolDescriptor[]> | undefined
  let fetchedAt = 0
  let identity: Identity | undefined

  const requestOptions = (opts: CallOptions | undefined): RequestOptions => {
    const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new InvalidInputError(`timeoutMs must be a positive number, not ${timeoutMs}`)
    }
    return { timeoutMs, signal: opts?.signal }
  }

  function listTools(
    opts: CallOptions & { refresh?: boolean } = {}
  ): Promise<readonly ToolDescriptor[]> {
    if (tools === undefined || opts.refresh === true) {
      const request = transport.listTools(requestOptions(opts))
      tools = request
      fetchedAt = Date.now()
      // Never cache a failure.
      request.catch(() => {
        if (tools === request) tools = undefined
      })
    }
    return tools
  }

  async function descriptor(tool: string, opts: CallOptions): Promise<ToolDescriptor> {
    if (typeof tool !== "string" || tool.trim() === "" || tool.length > 512 || /\s/.test(tool)) {
      throw new InvalidInputError("tool must be a non-empty name without whitespace", {
        tool,
        transport: transport.kind,
      })
    }
    let found = match(await listTools(opts), tool, transport.kind)
    if (found === undefined && Date.now() - fetchedAt >= REFRESH_INTERVAL_MS) {
      // Assignments change at runtime; look once more before giving up.
      found = match(await listTools({ ...opts, refresh: true }), tool, transport.kind)
    }
    if (found === undefined) {
      throw new UnknownToolError(`no tool named ${tool} is assigned to this bot`, {
        tool,
        transport: transport.kind,
      })
    }
    return found
  }

  async function call<T = unknown>(
    tool: string,
    args: Record<string, unknown> = {},
    opts: CallOptions = {}
  ): Promise<T> {
    if (!isRecord(args)) {
      throw new InvalidInputError("args must be a plain JSON object", {
        tool,
        transport: transport.kind,
      })
    }
    let serialised: unknown
    try {
      serialised = JSON.parse(JSON.stringify(args))
    } catch (err) {
      throw new InvalidInputError("args are not JSON-serialisable", {
        tool,
        transport: transport.kind,
        cause: err,
      })
    }
    // A plain object can still serialise to something else through toJSON().
    if (!isRecord(serialised)) {
      throw new InvalidInputError("args must serialise to a JSON object", {
        tool,
        transport: transport.kind,
      })
    }
    const started = Date.now()
    const base = requestOptions(opts)
    const found = await descriptor(tool, opts)
    const remaining = base.timeoutMs - (Date.now() - started)
    if (remaining <= 0) {
      throw new TransportError(
        "the deadline passed while resolving the tool name; nothing was called",
        { tool, transport: transport.kind }
      )
    }
    let result: ToolResult
    try {
      result = await transport.callTool(found.name, serialised, {
        timeoutMs: remaining,
        signal: base.signal,
      })
    } catch (err) {
      if (err instanceof BotyardError) throw retag(err, tool)
      throw new TransportError(
        `unexpected transport failure: ${err instanceof Error ? err.message : String(err)}`,
        {
          tool,
          transport: transport.kind,
          cause: err,
        }
      )
    }
    if (result.isError) throw toolFailure(result, tool, transport.kind)
    // `call<T>` is the published 0.1.0 API: T is the caller's claim about a tool
    // result that crossed the wire untyped, and the default is `unknown`. Removing
    // the parameter is a breaking change, tracked for the next minor.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return unwrap(result, found) as T
  }

  async function getIdentity(opts: CallOptions = {}): Promise<Identity> {
    if (identity !== undefined) return identity
    let value: unknown
    try {
      value = await call("get_identity", {}, opts)
    } catch (err) {
      if (!(err instanceof UnknownToolError)) throw err
    }
    const id = isRecord(value) ? value["id"] : undefined
    identity =
      isRecord(value) && typeof id === "string"
        ? fromTool(value, id, transport.kind)
        : fromEnv(env, transport.kind)
    return identity
  }

  return {
    transportKind: transport.kind,
    transportReason: reason,
    call,
    listTools,
    resolveToolName: async (tool, opts = {}) => (await descriptor(tool, opts)).name,
    getIdentity,
  }
}

/**
 * The live tool for a canonical name: the exact name, else the one tool whose
 * name ends in `__<name>` (an MCP client's `<server>__<tool>` namespacing).
 * More than one such tool is an error rather than a guess.
 */
export function match(
  tools: readonly ToolDescriptor[],
  tool: string,
  kind?: TransportKind
): ToolDescriptor | undefined {
  const exact = tools.find((t) => t.name === tool)
  if (exact !== undefined) return exact
  const suffixed = tools.filter((t) => t.name.endsWith(`__${tool}`))
  if (suffixed.length > 1) {
    throw new InvalidInputError(
      `${tool} is ambiguous: ${suffixed.map((t) => t.name).join(", ")}. Call it by its live name.`,
      {
        tool,
        transport: kind,
      }
    )
  }
  return suffixed[0]
}

/** FastMCP marks wrapped primitive results with this output-schema key. */
const WRAP_MARKER = "x-fastmcp-wrap-result"

function unwrap(result: ToolResult, tool: ToolDescriptor): unknown {
  const structured = result.structuredContent
  if (structured !== undefined && structured !== null) {
    if (
      isRecord(tool.outputSchema) &&
      tool.outputSchema[WRAP_MARKER] === true &&
      isRecord(structured) &&
      "result" in structured
    ) {
      return structured["result"]
    }
    return structured
  }
  const [only, ...rest] = result.content
  if (only === undefined) return undefined
  if (
    rest.length === 0 &&
    isRecord(only) &&
    only["type"] === "text" &&
    typeof only["text"] === "string"
  ) {
    try {
      return JSON.parse(only["text"])
    } catch {
      return only["text"]
    }
  }
  return result.content
}

/**
 * FastMCP reports argument validation as a tool error whose text starts
 * `N validation error(s) for call[<tool>]`; nothing ran, so it is invalid
 * input. An unknown tool comes back the same way as `Unknown tool: ...`.
 */
function toolFailure(result: ToolResult, tool: string, kind: TransportKind): BotyardError {
  const text = contentText(result.content).trim()
  const message = bounded(text || "the tool reported an error without a message")
  if (/^\d+ validation errors? for call\[/.test(text))
    return new InvalidInputError(message, { tool, transport: kind })
  if (/^Unknown tool:/.test(text)) return new UnknownToolError(message, { tool, transport: kind })
  return new ToolError(message, {
    tool,
    transport: kind,
    content: result.content,
    structuredContent: result.structuredContent,
  })
}

/** Report the canonical name the caller used, not the live one. */
function retag(err: BotyardError, tool: string): BotyardError {
  if (err.tool !== tool) Object.defineProperty(err, "tool", { value: tool })
  return err
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function fromTool(value: Record<string, unknown>, id: string, transport: TransportKind): Identity {
  return {
    bot: { id, slug: str(value["slug"]), name: str(value["name"]) },
    org: { id: str(value["org_id"]), slug: str(value["org_slug"]) },
    transport,
  }
}

function fromEnv(env: NodeJS.ProcessEnv, transport: TransportKind): Identity {
  const id = nonEmpty(env["BOTYARD_BOT_ID"])
  if (id === undefined) {
    throw new TransportError(
      "cannot determine the bot identity: no get_identity tool and BOTYARD_BOT_ID is unset",
      { transport }
    )
  }
  return {
    bot: { id, slug: nonEmpty(env["BOTYARD_BOT_SLUG"]), name: undefined },
    org: { id: nonEmpty(env["BOTYARD_ORG_ID"]), slug: nonEmpty(env["BOTYARD_ORG_SLUG"]) },
    transport,
  }
}
