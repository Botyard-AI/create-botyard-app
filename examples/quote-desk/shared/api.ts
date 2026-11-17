// The API, in one table. Each endpoint names its method, its path, and the
// parsers for what crosses the wire: the request body, the query, and the
// response. The server registers its handlers against these entries
// (server/endpoint.ts), and the UI calls them through one function
// (src/lib/quotes-api.ts). So no path, method or parser is paired by hand
// anywhere else, and the types come from the parsers.
import {
  noBody,
  parseBotList,
  parseCommentInput,
  parseDecisionInput,
  parseMemberList,
  parseMeta,
  parsePricing,
  parseQuarter,
  parseQuarterQuery,
  parseQuoteInput,
  parseQuoteList,
  parseQuoteView,
  parseResetResult,
  parseSavedSettings,
  parseSettingsInput,
  parseSettingsView,
} from "./parse.ts"

export type Method = "GET" | "POST" | "PUT"

/** A parsed query: named values, absent ones null. Null for endpoints that take none. */
export type Query = Readonly<Record<string, string | null>> | null

/**
 * One endpoint. `P` is the path, with `:name` for a path parameter; `B` the
 * parsed request body (null when it takes none); `R` the parsed response;
 * `Q` the parsed query.
 */
export type Endpoint<
  P extends string = string,
  B = unknown,
  R = unknown,
  Q extends Query = Query,
> = {
  readonly method: Method
  readonly path: P
  /**
   * Whether a request carries a JSON body. False exactly when `body` is
   * `noBody`; the helpers below set both together.
   */
  readonly sendsBody: boolean
  /** The request body's parser. `noBody` for endpoints that take none. */
  readonly body: (value: unknown) => B
  /** The query's parser. */
  readonly query: (query: URLSearchParams) => Q
  /** The response's parser. The server's handler must return this type. */
  readonly response: (value: unknown) => R
  /** The status a success answers with. */
  readonly status: 200 | 201
}

const noQuery = () => null

/** Reads something; no body. */
const get = <P extends string, R>(path: P, response: (value: unknown) => R) => ({
  method: "GET" as const,
  path,
  sendsBody: false,
  body: noBody,
  query: noQuery,
  response,
  status: 200 as const,
})

/** Sends a JSON body. */
const post = <P extends string, B, R>(
  path: P,
  body: (value: unknown) => B,
  response: (value: unknown) => R,
  status: 200 | 201 = 200
) => ({ method: "POST" as const, path, sendsBody: true, body, query: noQuery, response, status })

/** Does something to a resource; no body. */
const action = <P extends string, R>(path: P, response: (value: unknown) => R) => ({
  method: "POST" as const,
  path,
  sendsBody: false,
  body: noBody,
  query: noQuery,
  response,
  status: 200 as const,
})

export const API = {
  meta: get("/api/meta", parseMeta),
  members: get("/api/members", parseMemberList),
  preview: post("/api/preview", parseQuoteInput, parsePricing),
  listQuotes: get("/api/quotes", parseQuoteList),
  createQuote: post("/api/quotes", parseQuoteInput, parseQuoteView, 201),
  getQuote: get("/api/quotes/:id", parseQuoteView),
  updateQuote: {
    ...post("/api/quotes/:id", parseQuoteInput, parseQuoteView),
    method: "PUT" as const,
  },
  submitQuote: action("/api/quotes/:id/submit", parseQuoteView),
  sendQuote: action("/api/quotes/:id/send", parseQuoteView),
  signQuote: action("/api/quotes/:id/sign", parseQuoteView),
  quarter: { ...get("/api/quarter", parseQuarter), query: parseQuarterQuery },
  reset: action("/api/reset", parseResetResult),
  decideQuote: post("/api/quotes/:id/decide", parseDecisionInput, parseQuoteView),
  commentQuote: post("/api/quotes/:id/comments", parseCommentInput, parseQuoteView),
  settings: get("/api/settings", parseSettingsView),
  saveSettings: {
    ...post("/api/settings", parseSettingsInput, parseSavedSettings),
    method: "PUT" as const,
  },
  bots: get("/api/bots", parseBotList),
} as const satisfies Record<string, Endpoint>

// ---------- path parameters, typed from the path ----------

type Segments<P extends string> = P extends `${infer Head}/${infer Rest}`
  ? Head | Segments<Rest>
  : P
/** The `:name` segments of a path: `"id"` for "/api/quotes/:id". */
export type ParamName<P extends string> =
  Segments<P> extends infer S ? (S extends `:${infer Name}` ? Name : never) : never

/** `{ id: string }` for "/api/quotes/:id". */
export type PathParams<P extends string> = Readonly<Record<ParamName<P>, string>>
