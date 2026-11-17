// The UI's side of the API table (shared/api.ts): one function calls any
// entry, with the entry's method and path, and checks the answer with the
// entry's parser. Nothing from the network reaches the UI unchecked, and no
// path, method or parser is paired by hand here.
import { API, type Endpoint, type ParamName, type PathParams } from "../../shared/api.ts"
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

/** What calling an entry takes: its path parameters and its body, when it has them. */
export type CallArgs<P extends string, B> = { readonly signal?: AbortSignal | undefined } & ([
  ParamName<P>,
] extends [never]
  ? unknown
  : { readonly params: PathParams<P> }) &
  ([B] extends [null] ? unknown : { readonly body: DeepReadonly<B> })

/** Fills a path's `:name` segments, each encoded as one segment. */
function fillPath(path: string, params: unknown): string {
  return path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment
      const value = isRecord(params) ? params[segment.slice(1)] : undefined
      if (typeof value !== "string") throw new Error(`${path}: no value for ${segment}`)
      return encodeURIComponent(value)
    })
    .join("/")
}

/** Calls one API entry and returns its parsed answer. */
export async function call<P extends string, B, R, Q>(
  def: Endpoint<P, B, R, Q>,
  args: CallArgs<P, B>
): Promise<R> {
  const path = fillPath(def.path, Reflect.get(args, "params"))
  const body: unknown = Reflect.get(args, "body")
  const res = await fetch(path, {
    method: def.method,
    headers: { accept: "application/json", "content-type": "application/json" },
    signal: args.signal ?? null,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  const answer: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const message = isRecord(answer) && typeof answer["error"] === "string" ? answer["error"] : null
    throw new ApiError(res.status, message ?? `${path} answered ${String(res.status)}`)
  }
  return def.response(answer)
}

// Named calls for the pages. Each is one entry of the table.

export const getMeta = (signal?: AbortSignal) => call(API.meta, { signal })

export const getMembers = async (signal?: AbortSignal) =>
  (await call(API.members, { signal })).members

export const preview = (input: QuoteInput, signal?: AbortSignal) =>
  call(API.preview, { body: input, signal })

export const listQuotes = async (signal?: AbortSignal) =>
  (await call(API.listQuotes, { signal })).quotes

export const getQuote = (id: string, signal?: AbortSignal) =>
  call(API.getQuote, { params: { id }, signal })

export const saveQuote = (id: string | null, input: QuoteInput) =>
  id === null
    ? call(API.createQuote, { body: input })
    : call(API.updateQuote, { params: { id }, body: input })

export type QuoteAction = "submit" | "send" | "sign"

const ACTIONS = { submit: API.submitQuote, send: API.sendQuote, sign: API.signQuote } as const

export const act = (id: string, action: QuoteAction) => call(ACTIONS[action], { params: { id } })

export const getQuarter = (signal?: AbortSignal) => call(API.quarter, { signal })

export const resetDemo = () => call(API.reset, {})
