/** Header values as Node's `IncomingMessage` exposes them. */
export type NodeHeaderBag = Readonly<Record<string, string | readonly string[] | undefined>>

/** Anything with headers: a Web `Request`, or Node's `IncomingMessage`. */
export type RequestLike = {
  readonly headers: Headers | NodeHeaderBag
  /**
   * The TCP socket, when the request came straight from Node's HTTP server.
   * Used to check that the peer and the bound address are loopback.
   */
  readonly socket?:
    | {
        readonly localAddress?: string | undefined
        readonly remoteAddress?: string | undefined
      }
    | undefined
}

function isWebHeaders(headers: Headers | NodeHeaderBag): headers is Headers {
  return typeof (headers as { get?: unknown }).get === "function"
}

/**
 * Raw value(s) of one header. Node gives an array when a header repeats; a
 * Web `Headers` joins repeats with ", ". Callers must treat both as suspect.
 */
export function readHeader(req: RequestLike, name: string): string | readonly string[] | null {
  const lower = name.toLowerCase()
  if (isWebHeaders(req.headers)) {
    return req.headers.get(lower)
  }
  return req.headers[lower] ?? null
}
