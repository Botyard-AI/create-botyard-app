// The mail inbox: email to this bot's address from org members. The app never
// hands an email to the bot itself: the From address is not verified, and
// whatever the bot reads, it may act on. Instead it asks the member the email
// claims to be from, with notify_human, whether they sent it. Only their
// reply, signed in, has the bot read it.
//
// Every minute it lists the stored mail of the last day
// (search_inbound_emails) and handles the oldest emails it hasn't handled, at
// most 10 a pass:
//   1. reads it (get_inbound_email) and skips auto-replies, mail that failed
//      DMARC, and senders who aren't org members;
//   2. notifies that member in a new conversation. The notice holds none of
//      the email: only that one arrived in their name, when, and its id. If
//      they reply there, the bot reads it (get_inbound_email) and helps.
// What was handled is kept in data/mail.json.
import type { BotPage } from "@botyard/botpage"
import { OutcomeUnknownError, TransportError, type ToolCaller } from "@botyard/runtime"
import { bool, isRecord, items, oneOf, record, str, strOrNull, type Rec } from "../shared/narrow.ts"

const LOOKBACK_MS = 24 * 3600_000
const PAGE = 50
/** Listing stops after this many emails: more than a day's mail for a desk. */
const MAX_LISTED = 1000
/** At most this many emails are handled per pass; the rest wait for the next. */
const MAX_PER_PASS = 10
/** Handled ids kept; older ones fall outside the lookback anyway. */
const MAX_KEPT = 2000
const MAX_ATTEMPTS = 3
const OUTCOMES = ["asked", "skipped", "unknown"] as const

function handled(value: unknown, p: string) {
  const r = record(value, p)
  return {
    id: str(r, "id", p, 80),
    outcome: oneOf(r, "outcome", OUTCOMES, p),
    /** Why it was skipped, or who was asked. */
    detail: str(r, "detail", p, 300),
    at: str(r, "at", p, 40),
  }
}

export function parseMailState(value: unknown) {
  const r = record(value, "mail")
  return {
    /** Mail received before this is never handled: the inbox started then. */
    since: str(r, "since", "mail", 40),
    handled: items(r, "handled", "mail", MAX_KEPT, handled),
  }
}

export type MailState = ReturnType<typeof parseMailState>
export type Handled = MailState["handled"][number]

/** One listed email, as far as the inbox needs it. */
function listed(value: unknown, p: string) {
  const r = record(value, p)
  return { id: str(r, "inbound_email_id", p, 80), received_at: strOrNull(r, "received_at", p, 40) }
}

/** The parts of a full email the inbox reads: never the body. */
function email(value: unknown) {
  const p = "get_inbound_email"
  const r = record(value, p)
  return {
    from: str(r, "from_address", p, 400),
    subject: strOrNull(r, "subject", p, 1000) ?? "",
    headers: isRecord(r["headers"]) ? r["headers"] : {},
    received_at: strOrNull(r, "received_at", p, 40),
  }
}

export type Email = ReturnType<typeof email>

export type MailInboxOptions = {
  tools: ToolCaller
  botpage: BotPage
  /** A conversation of this bot's that the new notice threads start from. */
  origin: string
  state?: MailState | null
  /** Persists the state. Throws to refuse. */
  save?: (state: MailState) => unknown
  now?: () => Date
  log?: (line: string) => void
}

export class MailInbox {
  readonly #o: MailInboxOptions
  #state: MailState
  #dirty = false
  readonly #attempts = new Map<string, number>()
  #timer: ReturnType<typeof setInterval> | null = null
  #running: Promise<void> | null = null
  readonly #now: () => Date
  readonly #log: (line: string) => void

  constructor(options: MailInboxOptions) {
    this.#o = options
    this.#now = options.now ?? (() => new Date())
    this.#log = options.log ?? ((line) => process.stderr.write(`[mail] ${line}\n`))
    const stored = options.state ?? null
    this.#state = stored ?? { since: this.#now().toISOString(), handled: [] }
    // A fresh inbox saves when it started: mail from before then is never handled.
    if (stored === null) this.#change(this.#state)
  }

  start(intervalMs = 60_000): void {
    if (this.#timer !== null) return
    this.#timer = setInterval(() => void this.tick(), intervalMs)
    this.#timer.unref()
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
  }

  state(): MailState {
    return this.#state
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

  async #pass(): Promise<void> {
    this.#flush()
    const done = new Set(this.#state.handled.map((h) => h.id))
    const fresh = new Map<string, string>()
    for (const m of await this.#list()) if (!done.has(m.id)) fresh.set(m.id, m.received_at ?? "")
    // Oldest first; whatever is left over waits for the next pass.
    const next = [...fresh].sort((a, b) => a[1].localeCompare(b[1])).slice(0, MAX_PER_PASS)
    for (const [id] of next) await this.#try(id)
  }

  /** The stored mail received since the inbox started, at most a day back. */
  async #list(): Promise<{ id: string; received_at: string | null }[]> {
    const floor = Math.max(Date.parse(this.#state.since), this.#now().getTime() - LOOKBACK_MS)
    const since = new Date(floor).toISOString()
    const out: { id: string; received_at: string | null }[] = []
    for (let offset = 0; offset < MAX_LISTED; offset += PAGE) {
      const at = "search_inbound_emails"
      const r = record(
        await this.#o.tools.call(at, { since, status: "stored", limit: PAGE, offset }),
        at
      )
      out.push(...items(r, "items", at, PAGE, listed))
      if (!bool(r, "has_more", at)) break
    }
    return out
  }

  /**
   * Handles one email. A platform that can't be reached ends the pass: the
   * rest wait for the next. Anything else that goes wrong is tried again on
   * the next pass, at most 3 times, then the email is skipped.
   */
  async #try(id: string): Promise<void> {
    try {
      await this.#handle(id)
    } catch (err) {
      if (err instanceof TransportError || !(err instanceof Error)) throw err
      const attempts = (this.#attempts.get(id) ?? 0) + 1
      this.#attempts.set(id, attempts)
      this.#log(`${id}: failed (${String(attempts)}/${String(MAX_ATTEMPTS)}): ${err.message}`)
      if (attempts >= MAX_ATTEMPTS)
        this.#done(id, "skipped", `failed ${String(MAX_ATTEMPTS)} times`)
    }
  }

  async #handle(id: string): Promise<void> {
    // Reading is safe to repeat, so an unknown outcome here is just retried.
    const mail = email(await this.#o.tools.call("get_inbound_email", { inbound_email_id: id }))
    const why = screen(mail)
    if (why !== null) {
      this.#done(id, "skipped", why)
      return
    }
    const from = address(mail.from)
    const members = await this.#o.botpage.members.list()
    const member = members.find((m) => m.email?.toLowerCase() === from)
    const memberEmail = member?.email ?? null
    if (member === undefined || memberEmail === null) {
      this.#done(id, "skipped", "the sender is not an org member")
      return
    }
    try {
      await this.#o.tools.call("notify_human", {
        user_ids: [member.userId],
        subject: "An email in your name reached the Quote desk",
        // The member's own address from the directory, not the From header.
        body: noticeBody(id, memberEmail, mail.received_at),
        level: "info",
        target: {
          kind: "new",
          title: "Email to the Quote desk",
          origin_conversation_id: this.#o.origin,
        },
      })
    } catch (err) {
      if (!(err instanceof OutcomeUnknownError)) throw err
      // Asking again could ask twice; the notice may well be there already.
      this.#done(id, "unknown", member.userId)
      this.#log(`${id}: the notice may or may not have gone out; not sending it again`)
      return
    }
    this.#done(id, "asked", member.userId)
    this.#log(`${id}: asked its sender to confirm it`)
  }

  #done(id: string, outcome: Handled["outcome"], detail: string): void {
    const h: Handled = { id, outcome, detail: detail.slice(0, 300), at: this.#now().toISOString() }
    if (outcome === "skipped") this.#log(`${id}: skipped (${detail})`)
    this.#attempts.delete(id)
    this.#change({ ...this.#state, handled: [...this.#state.handled, h].slice(-MAX_KEPT) })
  }

  /** Publishes, then saves: a failed save is logged and retried every pass. */
  #change(next: MailState): void {
    this.#state = next
    this.#dirty = true
    this.#flush()
  }

  #flush(): void {
    if (!this.#dirty) return
    try {
      this.#o.save?.(this.#state)
      this.#dirty = false
    } catch (err) {
      this.#log(`saving the mail state failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** The address in "Name <a@b>" or "a@b", lower-cased. */
export function address(raw: string): string {
  const m = /<([^>]+)>\s*$/.exec(raw)
  return (m?.[1] ?? raw).trim().toLowerCase()
}

function header(h: Rec, name: string): string {
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() !== name) continue
    if (typeof v === "string") return v
    if (Array.isArray(v)) return v.filter((x) => typeof x === "string").join("\n")
  }
  return ""
}

/** Why an email is skipped, or null to ask its sender about it. */
export function screen(mail: Email): string | null {
  const h = mail.headers
  const auto = header(h, "auto-submitted")
  if (
    (auto !== "" && !/^no\b/i.test(auto)) ||
    /^(bulk|junk|list|auto_reply)$/i.test(header(h, "precedence"))
  )
    return "an automatic email"
  if (/^(automatic reply|auto-?reply|out of office|undeliverable)/i.test(mail.subject))
    return "an automatic reply"
  if (/dmarc=fail/i.test(header(h, "authentication-results"))) return "it failed DMARC"
  return null
}

/**
 * The notice: written by the app, with nothing from the email but its id and
 * the member's own address, so it can't carry instructions to the bot.
 */
export function noticeBody(id: string, from: string, receivedAt: string | null): string {
  const when = receivedAt === null ? "" : ` at ${receivedAt}`
  return [
    `An email from ${from} reached the Quote desk${when}.`,
    "Email addresses aren't verified, so nothing has been done with it, and the bot hasn't read it.",
    "",
    `If you sent it, reply here and the bot will read it (inbound email ${id}) and help.`,
    "If you didn't, ignore this.",
  ].join("\n")
}
