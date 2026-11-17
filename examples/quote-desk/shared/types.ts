// The API's types, shared by the server (server/) and the UI (src/).
//
// Every request and response type here is derived from the parser that
// checks it at runtime (parse.ts): the parser is the contract, and its type is
// what it returns. To change the API, change the parser. Nothing is declared
// twice, so the server, the UI and the checks cannot disagree.
//
// The closed sets (statuses, roles, ...) and the ERP/CRM seed shapes live in
// domain.ts and are re-exported here.
import type { DeepReadonly } from "./narrow.ts"
import type * as P from "./parse.ts"
import type { ReviewStage } from "./domain.ts"

export * from "./domain.ts"

/** A parser's result as the rest of the app sees it: read-only. */
type Wire<F extends (...args: never[]) => unknown> = DeepReadonly<ReturnType<F>>

// ---------- quotes (stored, and in responses) ----------

/** A quote as stored: one variant per status, each with the fields it requires. */
export type QuoteRecord = Wire<typeof P.parseQuoteRecord>
/** What every quote has, whatever its status. */
export type QuoteBase = Wire<typeof P.parseQuoteBase>

/** Being edited. Priced live; a rejection brings a quote back here. */
export type DraftQuote = Extract<QuoteRecord, { status: "draft" }>
/** Submitted: in review, or approved and not yet sent. */
export type ReviewQuote = Extract<QuoteRecord, { status: ReviewStage | "approved" }>
export type SentQuote = Extract<QuoteRecord, { status: "sent" }>
export type SignedQuote = Extract<QuoteRecord, { status: "signed" }>

export type Line = Wire<typeof P.parseLine>
export type Person = QuoteBase["owner"]
export type Approvals = QuoteBase["approvals"]
export type Approval = NonNullable<Approvals["finance"]>
/** A record in a quote's history. `at` is the demo date, `ts` the wall clock. */
export type QuoteEvent = QuoteBase["events"][number]
export type SentEmail = SentQuote["email"]

// ---------- responses ----------

export type Pricing = Wire<typeof P.parsePricing>
export type PricedLine = Pricing["lines"][number]
export type DeliveryEstimate = Pricing["delivery"]
export type DeliveryLine = Extract<DeliveryEstimate, { kind: "estimate" }>["lines"][number]
export type CreditDecision = Pricing["credit"]

/** GET /api/quotes/:id. Drafts are priced live; submitted quotes show the frozen numbers. */
export type QuoteView = Wire<typeof P.parseQuoteView>
/** One human-readable "what is happening now" for a quote. */
export type Progress = QuoteView["progress"]
/** GET /api/quotes. */
export type QuoteList = Wire<typeof P.parseQuoteList>
/** A row in GET /api/quotes. */
export type QuoteSummary = QuoteList["quotes"][number]
/** GET /api/meta: what the builder needs to draw its pickers. No costs. */
export type Meta = Wire<typeof P.parseMeta>
/** GET /api/quarter. */
export type Quarter = Wire<typeof P.parseQuarter>
/** Quarter-close numbers for one territory. */
export type QuarterRow = Quarter["territories"][number]
/** GET /api/members. */
export type MemberList = Wire<typeof P.parseMemberList>
/** An org member, for the owner picker. */
export type MemberOption = MemberList["members"][number]
/** POST /api/reset. */
export type ResetResult = Wire<typeof P.parseResetResult>

// ---------- requests ----------

/** The builder's input: a new quote, or the new contents of a draft. */
export type QuoteInput = Wire<typeof P.parseQuoteInput>

// ---------- settings ----------

/** Who approves. Kept apart from the quotes, so "Reset demo" leaves it alone. */
export type DeskSettings = Wire<typeof P.parseSettings>
/** GET /api/settings. */
export type SettingsView = Wire<typeof P.parseSettingsView>
/** A bot in the org, for the reviewer picker (GET /api/bots). */
export type BotList = Wire<typeof P.parseBotList>
export type BotOption = BotList["bots"][number]

// ---------- reviewer handoff ----------

/** Where the reviewer bot's part of a quote stands. */
export type HandoffView = Wire<typeof P.parseHandoffView>["handoff"]
/** Whether the reviewer handoff can run, for Settings. */
export type ReviewStatus = Wire<typeof P.parseReviewStatus>
