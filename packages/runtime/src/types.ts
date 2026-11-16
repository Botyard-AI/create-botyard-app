/** Which way calls reach Botyard. */
export type TransportKind = "botyardd" | "mcp" | "mock"

export const TRANSPORT_KINDS: readonly TransportKind[] = ["botyardd", "mcp", "mock"]

export interface CallOptions {
  /** Whole-call deadline in milliseconds. Defaults to the runtime's `defaultTimeoutMs` (60 s). */
  timeoutMs?: number
  /** Cancels the call. Cancelling after dispatch throws `OutcomeUnknownError`. */
  signal?: AbortSignal
}

/** The one thing app code needs: call a tool by its canonical name. */
export interface ToolCaller {
  /**
   * Call a Botyard tool.
   *
   * @param tool The canonical, unprefixed tool name, e.g. `list_org_members`.
   *   It is matched against the live tool list, so no org or server prefix is
   *   ever hardcoded.
   * @param args The tool's arguments, a JSON object. Defaults to `{}`.
   * @returns The tool's structured result, or its parsed JSON text, or its
   *   plain text.
   */
  call<T = unknown>(tool: string, args?: Record<string, unknown>, opts?: CallOptions): Promise<T>
}

/** One tool from the live tool list. */
export interface ToolDescriptor {
  /** The live name, exactly as a call must name it. */
  readonly name: string
  readonly description?: string | undefined
  readonly inputSchema: unknown
  readonly outputSchema?: unknown
}

/** A raw tool result, as MCP shapes it. */
export interface ToolResult {
  readonly content: readonly unknown[]
  readonly structuredContent?: unknown
  readonly isError: boolean
}

/** Options a transport receives for one request. Both are always set. */
export interface RequestOptions {
  readonly timeoutMs: number
  readonly signal: AbortSignal | undefined
}

/**
 * A way to reach Botyard. The runtime resolves names, unwraps results and
 * maps `isError`; a transport only moves requests and classifies failures
 * into the error types.
 */
export interface Transport {
  readonly kind: TransportKind
  listTools(opts: RequestOptions): Promise<readonly ToolDescriptor[]>
  /** `name` is the live name. Throws a `BotyardError` subclass on failure. */
  callTool(name: string, args: Record<string, unknown>, opts: RequestOptions): Promise<ToolResult>
}

export interface Identity {
  readonly bot: {
    readonly id: string
    readonly slug: string | undefined
    readonly name: string | undefined
  }
  readonly org: { readonly id: string | undefined; readonly slug: string | undefined }
  /** The transport this runtime chose. */
  readonly transport: TransportKind
}
