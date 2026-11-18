// Tells people when a quote needs them, with notify_human. Each notice starts
// its own conversation (target "new"), so the person has somewhere to answer.
//
// Who is told, and when:
// - finance approvers: a quote in finance review once the reviewer bot has
//   answered, or no answer is coming (its handoff is manual);
// - business approvers: a quote in business review;
// - the quote's owner: changes were requested, or the quote is approved.
//
// Every 30 seconds the notifier works out what is due from the quotes and
// sends what has not been sent. Each notice has a key: the quote, who, and
// which event made it due (how many, and the latest's time), so a resubmission (or a reset demo)
// is a new notice. The keys sent are kept in data/notifications.json.
//
// A failed send is tried again on the next pass, at most 3 times. A send whose
// outcome is unknown is not repeated: a missed notice is better than a
// duplicate. A crash between the send and the save can still send one twice.
import type { BotPage } from "@botyard/botpage"
import { BotyardError, OutcomeUnknownError, type ToolCaller } from "@botyard/runtime"
import { items, oneOf, record, str } from "../shared/narrow.ts"
import { eur } from "../shared/money.ts"
import type { QuoteEvent, QuoteView } from "../shared/types.ts"
import type { QuoteDesk } from "./quotes/desk.ts"
import type { SettingsStore } from "./quotes/settings.ts"
import type { HandoffStore } from "./review/handoffs.ts"
import { reviewRound } from "./review/relay.ts"

const MAX_ATTEMPTS = 3
const OUTCOMES = ["sent", "unknown", "failed"] as const

function notice(value: unknown, p: string) {
  const r = record(value, p)
  return {
    key: str(r, "key", p, 200),
    outcome: oneOf(r, "outcome", OUTCOMES, p),
    at: str(r, "at", p, 40),
  }
}

export function parseNotices(value: unknown) {
  return items(record(value, "notifications"), "notices", "notifications", 100_000, notice)
}

export type Notice = ReturnType<typeof notice>

/** A notice due now: who to tell, and what. */
export type Due = {
  readonly key: string
  readonly userIds: readonly string[]
  readonly subject: string
  readonly action: string
}

export type NotifierOptions = {
  desk: QuoteDesk
  settings: SettingsStore
  handoffs: HandoffStore
  botpage: BotPage
  tools: ToolCaller
  /** A conversation of this bot's that new notice threads start from. */
  origin: string
  /** The published Bot Page, for a link to the quote. Null: no link. */
  pageUrl: string | null
  notices?: readonly Notice[] | null
  /** Persists the notices sent. Throws to refuse. */
  save?: (notices: readonly Notice[]) => unknown
  now?: () => Date
  log?: (line: string) => void
}

export class Notifier {
  readonly #o: NotifierOptions
  #done: ReadonlyMap<string, Notice>
  readonly #attempts = new Map<string, number>()
  /** Due notices with nobody to tell, logged once. */
  readonly #unaddressed = new Set<string>()
  /** The notices changed, and the last save of them failed. */
  #dirty = false
  #timer: ReturnType<typeof setInterval> | null = null
  #running: Promise<void> | null = null
  readonly #now: () => Date
  readonly #log: (line: string) => void

  constructor(options: NotifierOptions) {
    this.#o = options
    this.#done = new Map((options.notices ?? []).map((n) => [n.key, n]))
    this.#now = options.now ?? (() => new Date())
    this.#log = options.log ?? ((line) => process.stderr.write(`[notify] ${line}\n`))
  }

  start(intervalMs = 30_000): void {
    if (this.#timer !== null) return
    this.#timer = setInterval(() => void this.tick(), intervalMs)
    this.#timer.unref()
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
  }

  /** One pass. Overlapping calls share the pass already running. */
  tick(): Promise<void> {
    this.#running ??= this.#pass()
      .catch((err: unknown) => {
        this.#log(`pass failed: ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => {
        this.#running = null
      })
    return this.#running
  }

  /** What is due for each quote, sent or not. */
  async due(): Promise<{ quote: QuoteView; due: Due }[]> {
    const { desk } = this.#o
    const out: { quote: QuoteView; due: Due }[] = []
    for (const { id } of desk.list()) {
      const quote = desk.get(id)
      const d = await this.#dueFor(quote)
      if (d !== null) out.push({ quote, due: d })
    }
    return out
  }

  async #pass(): Promise<void> {
    this.#flush()
    for (const { quote, due } of await this.due()) {
      if (this.#done.has(due.key)) continue
      if (due.userIds.length === 0) {
        // Not recorded: approvers picked in Settings later still get it.
        if (!this.#unaddressed.has(due.key))
          this.#log(`${quote.id}: nobody to tell (${due.subject})`)
        this.#unaddressed.add(due.key)
        continue
      }
      await this.#send(quote, due)
    }
  }

  async #dueFor(q: QuoteView): Promise<Due | null> {
    const { settings, handoffs } = this.#o
    const approvers = settings.get().approvers
    if (q.status === "finance_review") {
      const h = handoffs.get(q.id)
      const round = reviewRound(q)
      const ready =
        h !== undefined && h.round === round && (h.kind === "answered" || h.kind === "manual")
      // Finance is needed once the reviewer step is decided or ready to be
      // decided, whichever card was signed first. One notice per round.
      if (!ready && q.approvals.bot_review === null) return null
      return {
        key: `${q.id}:finance:${round ?? ""}`,
        userIds: await this.#members(approvers.finance),
        subject: `${q.id} needs your finance sign-off`,
        action: financeAction(h?.kind === "answered" ? h.decision : null, q),
      }
    }
    if (q.status === "business_review") {
      return {
        key: `${q.id}:business:${lastTs(q.events, (e) => e.type === "status" && e.to === "business_review")}`,
        userIds: await this.#members(approvers.business),
        subject: `${q.id} needs your business sign-off`,
        action: "approve it or request changes as business",
      }
    }
    if (q.status === "approved") {
      return {
        key: `${q.id}:owner:${lastTs(q.events, (e) => e.type === "status" && e.to === "approved")}`,
        userIds: await this.#owner(q),
        subject: `${q.id} is approved`,
        action: "send it to the customer",
      }
    }
    if (q.status === "draft" && q.progress.phase === "changes_requested") {
      return {
        key: `${q.id}:owner:${lastTs(q.events, (e) => e.type === "approval" && e.decision === "reject")}`,
        userIds: await this.#owner(q),
        subject: `${q.id}: changes requested`,
        action: `revise it and submit it again (${q.progress.detail || "no note"})`,
      }
    }
    return null
  }

  /** The user ids that are still org members. */
  async #members(userIds: readonly string[]): Promise<string[]> {
    const members = await this.#o.botpage.members.list()
    return userIds.filter((id) => members.some((m) => m.userId === id))
  }

  /** The owner's user id, found by email. Notices are not authority, so an email is enough. */
  async #owner(q: QuoteView): Promise<string[]> {
    const email = q.owner.email?.toLowerCase()
    if (email === undefined) return []
    const members = await this.#o.botpage.members.list()
    const m = members.find((x) => x.email?.toLowerCase() === email)
    return m === undefined ? [] : [m.userId]
  }

  async #send(q: QuoteView, due: Due): Promise<void> {
    const { tools, origin } = this.#o
    try {
      await tools.call("notify_human", {
        user_ids: due.userIds,
        subject: due.subject,
        body: this.body(q, due),
        level: "info",
        target: { kind: "new", title: `Quote desk · ${q.id}`, origin_conversation_id: origin },
      })
      this.#record(due.key, "sent")
      const n = due.userIds.length
      this.#log(`${q.id}: told ${String(n)} ${n === 1 ? "person" : "people"}: ${due.subject}`)
    } catch (err) {
      if (err instanceof OutcomeUnknownError) {
        this.#log(`${q.id}: the notice may or may not have gone out; not sending it again`)
        this.#record(due.key, "unknown")
        return
      }
      if (!(err instanceof BotyardError)) throw err
      const attempts = (this.#attempts.get(due.key) ?? 0) + 1
      this.#attempts.set(due.key, attempts)
      this.#log(
        `${q.id}: notify_human failed (${String(attempts)}/${String(MAX_ATTEMPTS)}): ${err.message}`
      )
      if (attempts >= MAX_ATTEMPTS) this.#record(due.key, "failed")
    }
  }

  /** The notice's text. It stands on its own: the person sees nothing else. */
  body(q: QuoteView, due: Due): string {
    const p = q.pricing
    const link =
      this.#o.pageUrl === null
        ? "Open it in the Quote desk."
        : `Open it: ${this.#o.pageUrl}/quotes/${q.id}`
    return [
      `${q.id} for ${q.account} (owner ${q.owner.name}) is waiting for you to ${due.action}.`,
      "",
      `Total ${eur(p.total_eur)}, margin ${String(p.margin_pct)}%, terms ${q.terms}.`,
      "",
      link,
    ].join("\n")
  }

  /**
   * Remembers a notice, then saves. Memory comes first: a save that fails
   * must not send the notice again. It is logged and retried every pass;
   * only a restart before the next good save can repeat the notice.
   */
  #record(key: string, outcome: Notice["outcome"]): void {
    const n: Notice = { key, outcome, at: this.#now().toISOString() }
    this.#done = new Map([...this.#done, [key, n]])
    this.#attempts.delete(key)
    this.#dirty = true
    this.#flush()
  }

  /** Saves the notices if they changed since the last good save; a failure is retried next pass. */
  #flush(): void {
    if (!this.#dirty) return
    try {
      this.#o.save?.([...this.#done.values()])
      this.#dirty = false
    } catch (err) {
      this.#log(`saving notices failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** What finance is asked to do: both cards are theirs (the reviewer bot only advises). */
function financeAction(recommends: string | null, q: QuoteView): string {
  if (q.approvals.bot_review !== null) return "sign off as finance (the reviewer step is recorded)"
  if (q.approvals.finance !== null) return "record the reviewer step (finance has signed off)"
  if (recommends !== null)
    return `confirm or overrule the reviewer bot's recommendation (${recommends}), then sign off as finance`
  return "record the reviewer step and sign off as finance (no recommendation is coming)"
}

/** Which of the matching events is the latest, and when: "2@2026-11-10T09:00:00Z". */
function lastTs(events: readonly QuoteEvent[], match: (e: QuoteEvent) => boolean): string {
  const found = events.filter(match)
  return `${String(found.length)}@${found.at(-1)?.ts ?? ""}`
}

/** QUOTE_DESK_PAGE_URL: the published page, https, without a trailing slash. */
export function pageUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("QUOTE_DESK_PAGE_URL is not a URL") // without the value: it may hold a secret
  }
  if (url.protocol !== "https:") throw new Error("QUOTE_DESK_PAGE_URL must be an https URL")
  // It goes into every notice: no credentials, and nothing after the path.
  // A bare "?" or "#" leaves search and hash empty, so check the text too.
  if (url.username !== "" || url.password !== "" || /[?#]/.test(raw))
    throw new Error("QUOTE_DESK_PAGE_URL must not have a user, password, query or fragment")
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "")
}
