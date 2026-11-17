// The quote desk: quote state and workflow rules. No I/O: persistence is the
// `save` callback, so tests run against memory.
import type {
  ApproverRole,
  Approvals,
  Decision,
  DraftQuote,
  Erp,
  Crm,
  Meta,
  Person,
  Progress,
  QuarterRow,
  QuoteEvent,
  QuoteInput,
  QuoteBase,
  QuoteRecord,
  QuoteSummary,
  QuoteView,
  ReviewQuote,
  Pricing,
} from "../../shared/types.ts"
import {
  MAX_ORDER_DISCOUNT_PCT,
  emptyApprovals,
  nextStatus,
  priceQuote,
  quarterOf,
  quarterPanel,
  rolesAt,
  signBy,
} from "./engine.ts"
import type { DeepReadonly } from "../../shared/narrow.ts"
import type { parseDeskState } from "./parse.ts"

/** A request the desk refuses. `status` is the HTTP status to answer with. */
export class DeskError extends Error {
  override name = "DeskError"
  readonly status: 400 | 404 | 409

  constructor(status: 400 | 404 | 409, message: string) {
    super(message)
    this.status = status
  }
}

export type DeskState = DeepReadonly<ReturnType<typeof parseDeskState>>

export type DeskOptions = {
  erp: Erp
  crm: Crm
  /** The demo's "today". Default: the seed's as_of date. */
  today?: string
  /** Saved state, or null for a fresh, seeded desk. */
  state?: DeskState | null
  /** Called with the whole state after every change. */
  save?: (state: DeskState) => void
  /** Wall clock for event timestamps. */
  now?: () => Date
}

const ROLE_LABEL: Readonly<Record<ApproverRole, string>> = {
  bot_review: "the reviewer bot",
  finance: "finance",
  business: "business",
}

export class QuoteDesk {
  readonly erp: Erp
  readonly crm: Crm
  readonly today: string
  #state: DeskState
  readonly #save: (state: DeskState) => void
  readonly #now: () => Date

  constructor(options: DeskOptions) {
    this.erp = options.erp
    this.crm = options.crm
    this.today = options.today ?? options.erp.as_of
    this.#save = options.save ?? (() => undefined)
    this.#now = options.now ?? (() => new Date())
    const stored = options.state ?? null
    const initial = stored ?? this.#fresh()
    // A fresh desk is saved before it is used, so a desk that cannot save fails at start.
    if (stored === null) this.#save(initial)
    this.#state = initial
  }

  // ---------- reads ----------

  meta(): Meta {
    const { erp, crm } = this
    return {
      as_of: this.today,
      settings: {
        margin_floor_pct: erp.settings.margin_floor_pct,
        discount_escalation_pct: erp.settings.discount_escalation_pct,
      },
      accounts: crm.accounts.map((a) => {
        const contact = a.contacts[0]
        return {
          account_id: a.account_id,
          name: a.name,
          industry: a.industry,
          territory: a.territory,
          contact: contact === undefined ? null : { name: contact.name, title: contact.title },
          standing: erp.customers.find((c) => c.account_id === a.account_id)?.standing ?? "good",
        }
      }),
      products: erp.products.map((p) => ({
        sku: p.sku,
        name: p.name,
        uom: p.uom,
        list_price_eur: p.list_price_eur,
        tiers: erp.price_tiers
          .filter((t) => t.sku === p.sku)
          .sort((a, b) => a.min_qty - b.min_qty)
          .map((t) => ({ min_qty: t.min_qty, unit_price_eur: t.unit_price_eur })),
      })),
      delivery_options: erp.delivery_options,
      regions: [...new Set(erp.delivery_lanes.map((l) => l.region))],
      payment_terms: erp.payment_terms,
      territories: [...new Set(erp.budgets.map((b) => b.territory))],
    }
  }

  /** Live pricing for builder input that has not been saved. */
  preview(input: QuoteInput): Pricing {
    this.#validate(input)
    return priceQuote(this.erp, { ...input }, this.today)
  }

  list(): QuoteSummary[] {
    return this.#state.quotes
      .map((q) => {
        const last = q.events[q.events.length - 1]
        return {
          id: q.id,
          status: q.status,
          progress: progress(q),
          owner: q.owner,
          account: this.#accountName(q.account_id),
          territory: q.territory,
          total_eur: this.#pricing(q).total_eur,
          sign_by: q.status === "draft" ? null : q.sign_by,
          updated: last?.ts ?? q.created_at,
          lines: q.lines.length,
        }
      })
      .reverse()
  }

  get(id: string): QuoteView {
    const q = this.#find(id)
    return {
      ...q,
      account: this.#accountName(q.account_id),
      pricing: this.#pricing(q),
      progress: progress(q),
    }
  }

  quarter(quarter: string = quarterOf(this.today)): { quarter: string; territories: QuarterRow[] } {
    const quotes = this.#state.quotes.map((record) => ({
      record,
      total_eur: this.#pricing(record).total_eur,
    }))
    return { quarter, territories: quarterPanel(this.erp, quotes, quarter, this.today) }
  }

  state(): DeskState {
    return this.#state
  }

  // ---------- changes ----------

  create(input: QuoteInput, owner: Person, by: string): QuoteView {
    this.#validate(input)
    const counter = this.#state.counter + 1
    const id = `Q-${this.today.slice(0, 4)}-${String(counter).padStart(4, "0")}`
    const record = this.#newRecord(id, input, owner, by)
    this.#commit({ counter, quotes: [...this.#state.quotes, record] })
    return this.get(id)
  }

  /** Replaces a draft's contents; a null owner keeps the current one. */
  update(id: string, input: QuoteInput, owner: Person | null, by: string): QuoteView {
    const q = this.#find(id)
    if (q.status !== "draft")
      throw new DeskError(409, `${id} is ${q.status}; only drafts can be edited`)
    this.#validate(input)
    this.#replace({
      ...q,
      ...fields(input),
      owner: owner ?? q.owner,
      events: [...q.events, this.#event(by, { type: "edited" })],
    })
    return this.get(id)
  }

  submit(id: string, by: string): QuoteView {
    const q = this.#find(id)
    if (q.status !== "draft")
      throw new DeskError(409, `${id} is ${q.status}; only drafts can be submitted`)
    this.#replace(this.#submitted(q, by))
    return this.get(id)
  }

  /** Record one approver's decision and move the quote along. */
  decide(id: string, role: ApproverRole, decision: Decision, note: string, by: string): QuoteView {
    const q = this.#find(id)
    if (q.status !== "finance_review" && q.status !== "business_review") {
      throw new DeskError(
        409,
        `${id} is ${q.status}; approvals are only open in finance or business review`
      )
    }
    if (!rolesAt(q.status).includes(role))
      throw new DeskError(409, `${ROLE_LABEL[role]} does not decide at ${q.status}`)
    if (q.approvals[role] !== null)
      throw new DeskError(409, `${ROLE_LABEL[role]} has already decided ${id}`)
    const clean = note.trim().slice(0, 2000)
    const events = [...q.events, this.#event(by, { type: "approval", role, decision, note: clean })]
    if (decision === "reject") {
      events.push(
        this.#event("system", {
          type: "status",
          to: "draft",
          note: `${ROLE_LABEL[role]} requested changes`,
        })
      )
      // Back to a draft: the frozen numbers and every approval are dropped.
      this.#replace({ ...base(q), status: "draft", approvals: emptyApprovals(), events })
      return this.get(id)
    }
    const approvals: Approvals = {
      ...q.approvals,
      [role]: { decision, note: clean, by, at: this.today },
    }
    const status = nextStatus(q.status, approvals)
    if (status !== q.status)
      events.push(this.#event("system", { type: "status", to: status, note: "" }))
    this.#replace({ ...q, approvals, status, events })
    return this.get(id)
  }

  comment(id: string, by: string, text: string): QuoteView {
    const q = this.#find(id)
    const note = text.trim().slice(0, 2000)
    if (note === "") throw new DeskError(400, "a comment needs text")
    this.#replace({ ...q, events: [...q.events, this.#event(by, { type: "comment", note })] })
    return this.get(id)
  }

  /** Record the customer email. Demo only: it is recorded, never delivered. */
  send(id: string, by: string): QuoteView {
    const q = this.#find(id)
    if (q.status !== "approved")
      throw new DeskError(409, `${id} is ${q.status}; it must be approved before it is sent`)
    const account = this.crm.accounts.find((a) => a.account_id === q.account_id)
    const contact = account?.contacts[0]
    if (contact === undefined) throw new DeskError(409, `${q.account_id} has no contact to send to`)
    const p = this.#pricing(q)
    const email = {
      to: contact.email,
      subject: `Quote ${id} (fictional demo)`,
      body:
        `Hello ${contact.name},\n\nPlease find quote ${id} for ${String(p.lines.length)} line(s), ` +
        `total EUR ${p.total_eur.toFixed(2)}. Please sign by ${q.sign_by}.\n\nThis is demo data.`,
      recorded_at: this.today,
      recorded_by: by,
    }
    const event = this.#event(by, {
      type: "status",
      to: "sent",
      note: "demo email recorded, not delivered",
    })
    this.#replace({ ...q, status: "sent", email, events: [...q.events, event] })
    return this.get(id)
  }

  sign(id: string, by: string): QuoteView {
    const q = this.#find(id)
    if (q.status !== "sent")
      throw new DeskError(409, `${id} is ${q.status}; only sent quotes can be signed`)
    const event = this.#event(by, { type: "status", to: "signed", note: "mock e-signature" })
    this.#replace({ ...q, status: "signed", signed_at: this.today, events: [...q.events, event] })
    return this.get(id)
  }

  /** Back to the seeded demo data. */
  reset(): { quotes: number } {
    this.#commit(this.#fresh())
    return { quotes: this.#state.quotes.length }
  }

  // ---------- internals ----------

  #fresh(): DeskState {
    const jim: Person = { name: "Jim Halpert", email: null }
    const base = {
      owner_email: null,
      region: "Northeast",
      order_discount_pct: 0,
      order_discount_reason: "",
    }
    const a = this.#newRecord(
      `Q-${this.today.slice(0, 4)}-0200`,
      {
        ...base,
        account_id: "ACC-1001",
        territory: "Scranton",
        delivery_option: "STD",
        terms: "NET30",
        lines: [
          { sku: "PPR-A4-80", qty: 120, unit_price_eur: null },
          { sku: "TNR-BLK-HY", qty: 6, unit_price_eur: null },
        ],
      },
      jim,
      jim.name
    )
    const b = this.#newRecord(
      `Q-${this.today.slice(0, 4)}-0201`,
      {
        ...base,
        account_id: "ACC-1003",
        territory: "Stamford",
        delivery_option: "EXP",
        terms: "NET45",
        lines: [{ sku: "PRN-MFP-400", qty: 6, unit_price_eur: 355 }],
      },
      jim,
      jim.name
    )
    return { counter: 201, quotes: [this.#submitted(a, jim.name), b] }
  }

  #newRecord(id: string, input: QuoteInput, owner: Person, by: string): DraftQuote {
    return {
      id,
      ...fields(input),
      owner,
      status: "draft",
      created_at: this.today,
      approvals: emptyApprovals(),
      events: [
        this.#event(by, { type: "created", on_behalf_of: by === owner.name ? null : owner.name }),
      ],
    }
  }

  #submitted(q: DraftQuote, by: string): ReviewQuote {
    return {
      ...base(q),
      status: "finance_review",
      priced_on: this.today,
      sign_by: signBy(this.today, this.erp.settings.sign_by_buffer_working_days),
      approvals: emptyApprovals(),
      events: [...q.events, this.#event(by, { type: "status", to: "finance_review", note: "" })],
    }
  }

  #event(by: string, body: DistributiveOmit<QuoteEvent, "at" | "ts" | "by">): QuoteEvent {
    return { at: this.today, ts: this.#now().toISOString(), by: by.slice(0, 120), ...body }
  }

  /** Drafts are priced as of today; submitted quotes keep the numbers they were frozen with. */
  #pricing(q: QuoteRecord): Pricing {
    return priceQuote(this.erp, q, q.status === "draft" ? this.today : q.priced_on)
  }

  #find(id: string): QuoteRecord {
    const q = this.#state.quotes.find((x) => x.id === id)
    if (q === undefined) throw new DeskError(404, `no quote ${id}`)
    return q
  }

  #accountName(accountId: string): string {
    return this.crm.accounts.find((a) => a.account_id === accountId)?.name ?? accountId
  }

  #replace(q: QuoteRecord): void {
    this.#commit({ ...this.#state, quotes: this.#state.quotes.map((x) => (x.id === q.id ? q : x)) })
  }

  /**
   * Saves, then publishes. When the save throws, the change is not applied:
   * memory keeps matching what is on disk, and the request can be retried.
   */
  #commit(state: DeskState): void {
    this.#save(state)
    this.#state = state
  }

  /** Domain checks: the input is well-formed (see input.ts), but does it name real things? */
  #validate(input: QuoteInput): void {
    const { erp, crm } = this
    if (!crm.accounts.some((a) => a.account_id === input.account_id))
      throw new DeskError(400, "unknown account")
    if (!erp.payment_terms.some((t) => t.code === input.terms))
      throw new DeskError(400, "unknown payment terms")
    if (!erp.delivery_options.some((o) => o.code === input.delivery_option)) {
      throw new DeskError(400, "unknown delivery option")
    }
    if (!erp.delivery_lanes.some((l) => l.region === input.region))
      throw new DeskError(400, "unknown region")
    if (!erp.budgets.some((b) => b.territory === input.territory))
      throw new DeskError(400, "unknown territory")
    if (input.lines.length === 0) throw new DeskError(400, "a quote needs at least one line")
    for (const l of input.lines) {
      if (!erp.products.some((p) => p.sku === l.sku))
        throw new DeskError(400, `unknown sku ${l.sku}`)
    }
    if (input.order_discount_pct < 0 || input.order_discount_pct > MAX_ORDER_DISCOUNT_PCT) {
      throw new DeskError(
        400,
        `order discount must be between 0% and ${String(MAX_ORDER_DISCOUNT_PCT)}%`
      )
    }
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** The fields every status shares, without the ones a status adds. */
function base(q: QuoteRecord): QuoteBase {
  return {
    id: q.id,
    owner: q.owner,
    account_id: q.account_id,
    territory: q.territory,
    region: q.region,
    delivery_option: q.delivery_option,
    terms: q.terms,
    lines: q.lines,
    order_discount_pct: q.order_discount_pct,
    order_discount_reason: q.order_discount_reason,
    created_at: q.created_at,
    approvals: q.approvals,
    events: q.events,
  }
}

function fields(input: QuoteInput) {
  return {
    account_id: input.account_id,
    territory: input.territory,
    region: input.region,
    delivery_option: input.delivery_option,
    terms: input.terms,
    lines: input.lines,
    order_discount_pct: Math.round(input.order_discount_pct * 10) / 10,
    order_discount_reason: input.order_discount_reason.trim().slice(0, 200),
  }
}

function lastIndex(events: readonly QuoteEvent[], match: (e: QuoteEvent) => boolean): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e !== undefined && match(e)) return i
  }
  return -1
}

/** What is happening with a quote now, and who acts next. */
export function progress(q: QuoteRecord): Progress {
  switch (q.status) {
    case "draft":
      return draftProgress(q)
    case "finance_review": {
      const waiting = financeWaiting(q.approvals)
      return {
        phase: `${waiting}_waiting`,
        label:
          waiting === "bot_review"
            ? "Waiting for the reviewer bot"
            : "Waiting for finance sign-off",
        detail: waiting === "bot_review" ? "" : "The reviewer bot approved",
        tone: "info",
        next: waiting,
      }
    }
    case "business_review":
      return {
        phase: "business_waiting",
        label: "Waiting for business sign-off",
        detail: "Finance approved",
        tone: "info",
        next: "business",
      }
    case "approved":
      return {
        phase: "approved",
        label: "Approved, ready to send",
        detail: "",
        tone: "success",
        next: "owner",
      }
    case "sent":
      return {
        phase: "sent",
        label: "Sent, awaiting customer signature",
        detail: `Sign by ${q.sign_by}`,
        tone: "info",
        next: "customer",
      }
    case "signed":
      return {
        phase: "signed",
        label: "Signed",
        detail: `Signed ${q.signed_at}`,
        tone: "success",
        next: null,
      }
  }
}

function financeWaiting(approvals: Approvals): "bot_review" | "finance" {
  return approvals.bot_review === null ? "bot_review" : "finance"
}

function draftProgress(q: QuoteRecord): Progress {
  const lastSubmit = lastIndex(q.events, (e) => e.type === "status" && e.to === "finance_review")
  const lastReject = lastIndex(q.events, (e) => e.type === "approval" && e.decision === "reject")
  const reject = q.events[lastReject]
  if (reject?.type === "approval" && lastReject > lastSubmit) {
    return {
      phase: "changes_requested",
      label: `Changes requested by ${ROLE_LABEL[reject.role]}`,
      detail: reject.note,
      tone: "warning",
      next: "owner",
    }
  }
  return {
    phase: "draft",
    label: "Draft",
    detail: "Not submitted yet",
    tone: "muted",
    next: "owner",
  }
}
