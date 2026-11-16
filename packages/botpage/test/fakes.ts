import type { CallOptions, ToolCaller } from "../src/index.ts"

export interface Call {
  tool: string
  args: Record<string, unknown> | undefined
  opts: CallOptions | undefined
}

export type Handler = (args: Record<string, unknown> | undefined) => unknown

/** A ToolCaller that answers from a table and records every call. */
export class FakeTools implements ToolCaller {
  readonly calls: Call[] = []
  readonly handlers = new Map<string, Handler>()

  on(tool: string, handler: Handler): this {
    this.handlers.set(tool, handler)
    return this
  }

  count(tool: string): number {
    return this.calls.filter((call) => call.tool === tool).length
  }

  async call<T = unknown>(
    tool: string,
    args?: Record<string, unknown>,
    opts?: CallOptions
  ): Promise<T> {
    this.calls.push({ tool, args, opts })
    const handler = this.handlers.get(tool)
    if (handler === undefined) throw new Error(`unexpected tool ${tool}`)
    return (await handler(args)) as T
  }
}

export const MEMBERS = [
  {
    user_id: "u-jakob",
    role_id: "owner",
    user: { user_id: "u-jakob", email: "Jakob@Botyard.io", name: "Jakob" },
  },
  {
    user_id: "u-vera",
    role_id: "viewer",
    user: { user_id: "u-vera", email: "vera@botyard.io", name: "Vera" },
  },
]

/** `list_org_members` over a fixed list, honouring limit/offset like the real tool. */
export function membersHandler(members: readonly unknown[] = MEMBERS): Handler {
  return (args) => {
    const limit = Number(args?.["limit"] ?? 50)
    const offset = Number(args?.["offset"] ?? 0)
    return { total: members.length, members: members.slice(offset, offset + limit) }
  }
}

export function fakeTools(): FakeTools {
  return new FakeTools().on("list_org_members", membersHandler())
}

export interface CapturedLogger {
  warnings: string[]
  warn(message: string): void
}

export function captureLogger(): CapturedLogger {
  const warnings: string[] = []
  return { warnings, warn: (message) => warnings.push(message) }
}

/** A Node-shaped request. */
export function nodeReq(
  headers: Record<string, string | string[]>,
  socket: { localAddress?: string; remoteAddress?: string } = {
    localAddress: "127.0.0.1",
    remoteAddress: "127.0.0.1",
  }
) {
  return { headers, socket }
}
