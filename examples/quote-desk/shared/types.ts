// Shapes shared by the server (server/) and the UI (src/). Types only: nothing
// here runs, so the UI bundle pulls in no server code.

// ---------- reference data (the fictional ERP and CRM seed) ----------

export type Standing = "good" | "watch" | "hold"

export type Product = {
  readonly sku: string
  readonly name: string
  readonly uom: string
  readonly list_price_eur: number
  readonly unit_cost_eur: number
  readonly supplier_lead_days: number
}

export type PriceTier = {
  readonly sku: string
  readonly min_qty: number
  readonly unit_price_eur: number
}

export type StockRow = {
  readonly sku: string
  readonly warehouse: string
  readonly on_hand: number
  readonly reserved: number
}

export type PurchaseOrder = {
  readonly po_id: string
  readonly sku: string
  readonly warehouse: string
  readonly qty: number
  readonly expected_date: string
  readonly status: string
}

export type DeliveryOption = {
  readonly code: string
  readonly label: string
  readonly cost_eur: number
}

export type DeliveryLane = {
  readonly warehouse: string
  readonly region: string
  readonly option_code: string
  readonly transit_days: number
}

export type PaymentTerms = { readonly code: string; readonly label: string }

export type Customer = {
  readonly account_id: string
  readonly name: string
  readonly credit_limit_eur: number
  readonly open_ar_eur: number
  readonly standing: Standing
  readonly default_terms: string
}

export type Budget = {
  readonly territory: string
  readonly quarter: string
  readonly budget_eur: number
  readonly committed_eur: number
}

export type ErpSettings = {
  readonly margin_floor_pct: number
  readonly discount_escalation_pct: number
  readonly sign_by_buffer_working_days: number
}

export type Erp = {
  readonly as_of: string
  readonly settings: ErpSettings
  readonly products: readonly Product[]
  readonly price_tiers: readonly PriceTier[]
  readonly stock: readonly StockRow[]
  readonly purchase_orders: readonly PurchaseOrder[]
  readonly delivery_options: readonly DeliveryOption[]
  readonly delivery_lanes: readonly DeliveryLane[]
  readonly payment_terms: readonly PaymentTerms[]
  readonly customers: readonly Customer[]
  readonly budgets: readonly Budget[]
}

export type Contact = { readonly name: string; readonly title: string; readonly email: string }

export type Account = {
  readonly account_id: string
  readonly name: string
  readonly industry: string
  readonly territory: string
  readonly contacts: readonly Contact[]
}

export type Crm = { readonly accounts: readonly Account[] }

/** What the builder needs to draw its pickers (GET /api/meta). No costs. */
export type Meta = {
  readonly as_of: string
  readonly settings: Pick<ErpSettings, "margin_floor_pct" | "discount_escalation_pct">
  readonly accounts: readonly (Pick<Account, "account_id" | "name" | "industry" | "territory"> & {
    readonly contact: Pick<Contact, "name" | "title"> | null
    readonly standing: Standing
  })[]
  readonly products: readonly (Pick<Product, "sku" | "name" | "uom" | "list_price_eur"> & {
    readonly tiers: readonly Pick<PriceTier, "min_qty" | "unit_price_eur">[]
  })[]
  readonly delivery_options: readonly DeliveryOption[]
  readonly regions: readonly string[]
  readonly payment_terms: readonly PaymentTerms[]
  readonly territories: readonly string[]
}

// ---------- pricing ----------

export type PricedLine = {
  readonly sku: string
  readonly name: string
  readonly qty: number
  readonly unit_price_eur: number
  readonly list_price_eur: number
  readonly revenue_eur: number
  readonly cost_eur: number
  readonly margin_pct: number
  /** Unit price against list, before the order discount. */
  readonly discount_pct: number
  /** Unit price after the order discount, against list. */
  readonly effective_discount_pct: number
}

export type DeliveryLine = {
  readonly sku: string
  readonly qty: number
  readonly warehouse: string
  readonly earliest_delivery: string
  readonly reason: string
}

export type DeliveryEstimate =
  | {
      readonly kind: "estimate"
      readonly option: string
      readonly delivery_cost_eur: number
      readonly earliest_delivery: string
      readonly lines: readonly DeliveryLine[]
    }
  | { readonly kind: "unavailable"; readonly option: string; readonly error: string }

export type CreditDecision = {
  readonly decision: "approve" | "refer" | "decline"
  readonly reason: string
}

export type Pricing = {
  readonly lines: readonly PricedLine[]
  readonly subtotal_eur: number
  readonly order_discount_pct: number
  readonly order_discount_eur: number
  readonly revenue_eur: number
  readonly cost_eur: number
  readonly margin_pct: number
  readonly margin_floor_pct: number
  readonly below_floor: boolean
  readonly worst_discount_pct: number
  readonly discount_escalation_pct: number
  readonly escalate: boolean
  readonly delivery: DeliveryEstimate
  readonly delivery_cost_eur: number
  readonly credit: CreditDecision
  readonly total_eur: number
  readonly slips_next_quarter: boolean
  readonly flags: readonly string[]
}

// ---------- quotes ----------

/**
 * Who approves. Finance review needs the reviewer bot and a finance person;
 * business review needs a business person. Which bot and which people fill
 * these roles is configuration, never code.
 */
export const FINANCE_ROLES = ["bot_review", "finance"] as const
export const BUSINESS_ROLES = ["business"] as const
export type ApproverRole = (typeof FINANCE_ROLES)[number] | (typeof BUSINESS_ROLES)[number]
export const APPROVER_ROLES: readonly ApproverRole[] = [...FINANCE_ROLES, ...BUSINESS_ROLES]

export type QuoteStatus =
  "draft" | "finance_review" | "business_review" | "approved" | "sent" | "signed"

export type Person = { readonly name: string; readonly email: string | null }

export type Line = {
  readonly sku: string
  readonly qty: number
  /** A price agreed by hand; null uses the list or tier price. */
  readonly unit_price_eur: number | null
}

export type Decision = "approve" | "reject"

export type Approval = {
  readonly decision: Decision
  readonly note: string
  readonly by: string
  readonly at: string
}

export type Approvals = Readonly<Record<ApproverRole, Approval | null>>

/** A record in a quote's history. `at` is the demo date, `ts` the wall clock. */
export type QuoteEvent = { readonly at: string; readonly ts: string; readonly by: string } & (
  | { readonly type: "created"; readonly on_behalf_of: string | null }
  | { readonly type: "edited" }
  | { readonly type: "status"; readonly to: QuoteStatus; readonly note: string }
  | {
      readonly type: "approval"
      readonly role: ApproverRole
      readonly decision: Decision
      readonly note: string
    }
  | { readonly type: "comment"; readonly note: string }
)

export type SentEmail = {
  readonly to: string
  readonly subject: string
  readonly body: string
  readonly recorded_at: string
  readonly recorded_by: string
}

/** What every quote has, whatever its status. */
export type QuoteBase = {
  readonly id: string
  readonly owner: Person
  readonly account_id: string
  readonly territory: string
  readonly region: string
  readonly delivery_option: string
  readonly terms: string
  readonly lines: readonly Line[]
  readonly order_discount_pct: number
  readonly order_discount_reason: string
  readonly created_at: string
  /** All empty on a draft; see the parser for what each status requires. */
  readonly approvals: Approvals
  readonly events: readonly QuoteEvent[]
}

/** The stages at which approvers decide. */
export type ReviewStage = "finance_review" | "business_review"

/** Set at submit: the demo date the numbers were frozen on, and the sign-by date. */
type Frozen = { readonly priced_on: string; readonly sign_by: string }

/** Being edited. Priced live; a rejection brings a quote back here. */
export type DraftQuote = QuoteBase & { readonly status: "draft" }

/** Submitted: in review, or approved and not yet sent. */
export type ReviewQuote = QuoteBase & Frozen & { readonly status: ReviewStage | "approved" }

export type SentQuote = QuoteBase & Frozen & { readonly status: "sent"; readonly email: SentEmail }

export type SignedQuote = QuoteBase &
  Frozen & { readonly status: "signed"; readonly email: SentEmail; readonly signed_at: string }

/** A quote as stored: one variant per status, each with the fields that status requires. */
export type QuoteRecord = DraftQuote | ReviewQuote | SentQuote | SignedQuote

export type Tone = "muted" | "info" | "warning" | "success"

/** One human-readable "what is happening now" for a quote. */
export type Progress = {
  readonly phase: string
  readonly label: string
  readonly detail: string
  readonly tone: Tone
  /** Who acts next: an approver role, the owner, the customer, or nobody. */
  readonly next: ApproverRole | "owner" | "customer" | null
}

/** GET /api/quotes/:id. Drafts are priced live; submitted quotes show the frozen numbers. */
export type QuoteView = QuoteRecord & {
  readonly account: string
  readonly pricing: Pricing
  readonly progress: Progress
}

/** A row in GET /api/quotes. */
export type QuoteSummary = {
  readonly id: string
  readonly status: QuoteStatus
  readonly progress: Progress
  readonly owner: Person
  readonly account: string
  readonly territory: string
  readonly total_eur: number
  readonly sign_by: string | null
  readonly updated: string
  readonly lines: number
}

/** The builder's input: a new quote, or the new contents of a draft. */
export type QuoteInput = {
  readonly owner_email: string | null
  readonly account_id: string
  readonly territory: string
  readonly region: string
  readonly delivery_option: string
  readonly terms: string
  readonly lines: readonly Line[]
  readonly order_discount_pct: number
  readonly order_discount_reason: string
}

/** Quarter-close numbers for one territory. */
export type QuarterRow = {
  readonly territory: string
  readonly quarter: string
  readonly budget_eur: number
  readonly signed_eur: number
  readonly pipeline_eur: number
  readonly committed_eur: number
  readonly headroom_eur: number
  readonly used_pct: number
  readonly covered_by_pipeline: boolean
  readonly quarter_end: string
  readonly days_left: number
}

/** An org member, for the owner picker (GET /api/members). */
export type MemberOption = {
  readonly user_id: string
  readonly name: string
  readonly email: string | null
}
