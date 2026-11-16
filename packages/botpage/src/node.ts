/**
 * Adapter for Node's `http` module (and anything built on it, such as
 * Express or `@hono/node-server`).
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

import type { BotPage, Logger, MemberViewer, RequireMemberOptions, Viewer } from "./botpage.ts"
import { BotPageConfigError } from "./errors.ts"
import { isLoopbackAddress } from "./loopback.ts"
import { guardFailure, type GuardFailure } from "./responses.ts"

export type NodeHandler<V> = (
  req: IncomingMessage,
  res: ServerResponse,
  viewer: V
) => void | Promise<void>

/** Write a guard failure as a JSON response. */
export function sendGuardFailure(res: ServerResponse, failure: GuardFailure): void {
  const body = JSON.stringify(failure.body)
  res.writeHead(failure.status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  })
  res.end(body)
}

/** Wrap a handler so it receives the viewer, or `null` when none was identified. */
export function withViewer(
  botpage: BotPage,
  handler: NodeHandler<Viewer | null>
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    let viewer: Viewer | null
    try {
      viewer = await botpage.viewer(req)
    } catch (error) {
      const failure = guardFailure(error)
      if (failure === null) throw error
      sendGuardFailure(res, failure)
      return
    }
    await handler(req, res, viewer)
  }
}

/**
 * Wrap a handler so it runs only for org members. Others get 401, 403, or
 * 503 when the directory is unavailable, as JSON.
 */
export function requireMember(
  botpage: BotPage,
  handler: NodeHandler<MemberViewer>,
  options?: RequireMemberOptions
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    let viewer: MemberViewer
    try {
      viewer = await botpage.requireMember(req, options)
    } catch (error) {
      const failure = guardFailure(error)
      if (failure === null) throw error
      sendGuardFailure(res, failure)
      return
    }
    await handler(req, res, viewer)
  }
}

export interface GuardListenOptions {
  /** Records the bound address so the dev viewer override can check it. */
  botpage?: BotPage
  /** Where the warning goes when `botpage` is not given. Default `console`. */
  logger?: Logger
}

function addressOf(server: Server): string | null {
  const address = server.address()
  if (address === null) return null
  return typeof address === "string" ? address : address.address
}

/**
 * Warn when `server` listens on anything but loopback. Call it before or
 * after `server.listen(...)`.
 */
export function guardListen(server: Server, options: GuardListenOptions = {}): void {
  const check = (): void => {
    const address = addressOf(server)
    if (address === null) return
    if (options.botpage !== undefined) {
      options.botpage.noteBind(address)
    } else if (!isLoopbackAddress(address) && !address.startsWith("/")) {
      ;(options.logger ?? console).warn(
        `@botyard/botpage: the server is bound to ${address}, not loopback. Listen on 127.0.0.1.`
      )
    }
  }
  if (server.listening) check()
  else server.once("listening", check)
}

export interface ListenLoopbackOptions {
  /** Loopback host to bind. Default `127.0.0.1`. Anything else is refused. */
  host?: string
  botpage?: BotPage
}

/**
 * `server.listen(port, host)` that refuses, before binding, any host that is
 * not loopback. Resolves with the bound address.
 */
export async function listenLoopback(
  server: Server,
  port: number,
  options: ListenLoopbackOptions = {}
): Promise<AddressInfo> {
  const host = options.host ?? "127.0.0.1"
  if (!isLoopbackAddress(host)) {
    throw new BotPageConfigError(
      `@botyard/botpage: refusing to listen on ${host}. Bot Page apps must listen on loopback (127.0.0.1).`
    )
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once("error", onError)
    server.listen(port, host, () => {
      server.off("error", onError)
      resolve()
    })
  })
  if (options.botpage !== undefined) guardListen(server, { botpage: options.botpage })
  return server.address() as AddressInfo
}
