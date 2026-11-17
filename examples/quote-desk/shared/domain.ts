// The quote desk's vocabulary: fixed lists of values, and the shape of the
// fictional ERP/CRM seed. Nothing here crosses the network as its own type;
// the API's types are derived from its parsers (see types.ts).

// ---------- closed sets ----------

export const STATUSES = [
  "draft",
  "finance_review",
  "business_review",
  "approved",
  "sent",
  "signed",
] as const
export type QuoteStatus = (typeof STATUSES)[number]

/** The stages at which approvers decide. */
export type ReviewStage = "finance_review" | "business_review"

/**
 * Who approves. Finance review needs the reviewer bot and a finance person;
 * business review needs a business person. Which bot and which people fill
 * these roles is configuration, never code.
 */
export const FINANCE_ROLES = ["bot_review", "finance"] as const
export const BUSINESS_ROLES = ["business"] as const
export const APPROVER_ROLES = [...FINANCE_ROLES, ...BUSINESS_ROLES] as const
export type ApproverRole = (typeof APPROVER_ROLES)[number]

/** Who decides at each review stage. A Record, so a new stage must say. */
export const STAGE_ROLES: Readonly<Record<ReviewStage, readonly ApproverRole[]>> = {
  finance_review: FINANCE_ROLES,
  business_review: BUSINESS_ROLES,
}

export const DECISIONS = ["approve", "reject"] as const
export type Decision = (typeof DECISIONS)[number]

export const TONES = ["muted", "info", "warning", "success"] as const
export type Tone = (typeof TONES)[number]

/** Who acts next on a quote. */
export const NEXT_ACTORS = [...APPROVER_ROLES, "owner", "customer"] as const

export const STANDINGS = ["good", "watch", "hold"] as const
export type Standing = (typeof STANDINGS)[number]

export const CREDIT_DECISIONS = ["approve", "refer", "decline"] as const

export const EVENT_TYPES = ["created", "edited", "status", "approval", "comment"] as const

// ---------- the ERP and CRM seed (server only) ----------

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
