// The quote desk API, with every response narrowed by the shared parsers:
// nothing from the network reaches the UI as an unchecked type.
import type {
  MemberOption,
  Meta,
  Pricing,
  QuarterRow,
  QuoteInput,
  QuoteSummary,
  QuoteView,
} from "../../shared/types.ts"
import { isRecord } from "../../shared/narrow.ts"
import {
  parseMembers,
  parseMeta,
  parsePricing,
  parseQuarter,
  parseQuoteSummaries,
  parseQuoteView,
} from "../../shared/parse.ts"

/** The API refused a request; `message` is its explanation, for the person. */
export class ApiError extends Error {
  override name = "ApiError"
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(
  path: string,
  parse: (value: unknown) => T,
  init: { method?: "GET" | "POST" | "PUT"; body?: unknown; signal?: AbortSignal } = {}
): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: { accept: "application/json", "content-type": "application/json" },
    signal: init.signal ?? null,
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  })
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const message = isRecord(body) && typeof body["error"] === "string" ? body["error"] : null
    throw new ApiError(res.status, message ?? `${path} answered ${String(res.status)}`)
  }
  return parse(body)
}

export const getMeta = (signal?: AbortSignal): Promise<Meta> =>
  request("/api/meta", (v) => parseMeta(v), signal ? { signal } : {})

export const getMembers = (signal?: AbortSignal): Promise<MemberOption[]> =>
  request("/api/members", (v) => parseMembers(v), signal ? { signal } : {})

export const preview = (input: QuoteInput, signal?: AbortSignal): Promise<Pricing> =>
  request("/api/preview", (v) => parsePricing(v), {
    method: "POST",
    body: input,
    ...(signal && { signal }),
  })

export const listQuotes = (signal?: AbortSignal): Promise<QuoteSummary[]> =>
  request("/api/quotes", (v) => parseQuoteSummaries(v), signal ? { signal } : {})

export const getQuote = (id: string, signal?: AbortSignal): Promise<QuoteView> =>
  request(
    `/api/quotes/${encodeURIComponent(id)}`,
    (v) => parseQuoteView(v),
    signal ? { signal } : {}
  )

export const saveQuote = (id: string | null, input: QuoteInput): Promise<QuoteView> =>
  id === null
    ? request("/api/quotes", (v) => parseQuoteView(v), { method: "POST", body: input })
    : request(`/api/quotes/${encodeURIComponent(id)}`, (v) => parseQuoteView(v), {
        method: "PUT",
        body: input,
      })

export type QuoteAction = "submit" | "send" | "sign"

export const act = (id: string, action: QuoteAction): Promise<QuoteView> =>
  request(`/api/quotes/${encodeURIComponent(id)}/${action}`, (v) => parseQuoteView(v), {
    method: "POST",
  })

export const getQuarter = (
  signal?: AbortSignal
): Promise<{ quarter: string; territories: QuarterRow[] }> =>
  request("/api/quarter", (v) => parseQuarter(v), signal ? { signal } : {})

export const resetDemo = (): Promise<unknown> => request("/api/reset", (v) => v, { method: "POST" })
