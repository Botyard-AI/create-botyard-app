// The UI's side of the API table (shared/api.ts): one function calls any
// entry, with the entry's method and path, and checks the answer with the
// entry's parser. Nothing from the network reaches the UI unchecked, and no
// path, method or parser is paired by hand here.
import { API, type Endpoint, type PathParams, type Query } from "../../shared/api.ts"
import type { DeepReadonly } from "../../shared/narrow.ts"
import { isRecord } from "../../shared/narrow.ts"
import type { QuoteInput } from "../../shared/types.ts"

/** The API refused a request; `message` is its explanation, for the person. */
export class ApiError extends Error {
  override name = "ApiError"
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * What calling an entry takes: its path parameters, body and query, each typed
 * from the entry. Entries without one take `{}` or null there (see NONE).
 */
export type CallArgs<P extends string, B, Q extends Query> = {
  readonly params: PathParams<P>
  readonly body: DeepReadonly<B>
  readonly query: Q
  readonly signal?: AbortSignal | undefined
}

/** The arguments of an entry with no path parameters, body or query. */
const NONE = { params: {}, body: null, query: null } as const

/** Fills a path's `:name` segments, each encoded as one segment. */
export function fillPath(path: string, params: Readonly<Record<string, string>>): string {
  return path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment
      const value = params[segment.slice(1)]
      if (value === undefined) throw new Error(`${path}: no value for ${segment}`)
      return encodeURIComponent(value)
    })
    .join("/")
}

/** The query string for a parsed query; null values are left out. */
export function queryString(query: Query): string {
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value !== null) search.set(name, value)
  }
  return search.size === 0 ? "" : `?${search.toString()}`
}

/** Calls one API entry and returns its parsed answer. */
export async function call<P extends string, B, R, Q extends Query>(
  def: Endpoint<P, B, R, Q>,
  args: NoInfer<CallArgs<P, B, Q>>
): Promise<R> {
  const path = fillPath(def.path, args.params)
  const res = await fetch(`${path}${queryString(args.query)}`, {
    method: def.method,
    headers: { accept: "application/json", "content-type": "application/json" },
    signal: args.signal ?? null,
    // Entries without a body send none, which the server reads as {}.
    ...(def.sendsBody && { body: JSON.stringify(args.body) }),
  })
  const answer: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const message = isRecord(answer) && typeof answer["error"] === "string" ? answer["error"] : null
    throw new ApiError(res.status, message ?? `${path} answered ${String(res.status)}`)
  }
  return def.response(answer)
}

// Named calls for the pages. Each is one entry of the table.

export const getMeta = (signal?: AbortSignal) => call(API.meta, { ...NONE, signal })

export const getMembers = async (signal?: AbortSignal) =>
  (await call(API.members, { ...NONE, signal })).members

export const preview = (input: QuoteInput, signal?: AbortSignal) =>
  call(API.preview, { ...NONE, body: input, signal })

export const listQuotes = async (signal?: AbortSignal) =>
  (await call(API.listQuotes, { ...NONE, signal })).quotes

export const getQuote = (id: string, signal?: AbortSignal) =>
  call(API.getQuote, { ...NONE, params: { id }, signal })

export const saveQuote = (id: string | null, input: QuoteInput) =>
  id === null
    ? call(API.createQuote, { ...NONE, body: input })
    : call(API.updateQuote, { ...NONE, params: { id }, body: input })

export type QuoteAction = "submit" | "send" | "sign"

const ACTIONS = { submit: API.submitQuote, send: API.sendQuote, sign: API.signQuote } as const

export const act = (id: string, action: QuoteAction) =>
  call(ACTIONS[action], { ...NONE, params: { id } })

/** A quarter's close numbers; no quarter is the current one. */
export const getQuarter = (quarter: string | null, signal?: AbortSignal) =>
  call(API.quarter, { ...NONE, query: { quarter }, signal })

export const resetDemo = () => call(API.reset, NONE)
