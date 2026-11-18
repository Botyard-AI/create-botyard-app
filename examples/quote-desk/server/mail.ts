// The mail inbox: email to this bot's address from org members. The app never
// hands an email to the bot itself: the From address is not verified, and
// whatever the bot reads, it may act on. Instead it asks the member the email
// claims to be from, with notify_human, whether they sent it. Only their
// reply, signed in, has the bot read it.
//
// Every minute it walks the stored mail oldest first, from where it got to
// (`cursor`, never before the inbox started or more than a day back), and
// handles up to 10 emails it hasn't handled:
//   1. reads it (get_inbound_email) and skips auto-replies, mail that failed
//      DMARC, and senders who aren't org members;
//   2. notifies that member in a new conversation, at most once an hour per
//      member: more mail from them in that hour is covered by that notice
//      ("batched"). The notice holds none of the email: only the member's own
//      address and when the mail started. If they reply there, the bot reads
//      their mail from that time on and helps.
// What was handled is kept in data/mail.json.
import type { BotPage } from "@botyard/botpage"
import { OutcomeUnknownError, TransportError, type ToolCaller } from "@botyard/runtime"
import {
  ParseError,
  isRecord,
  items,
  num,
  oneOf,
  record,
  str,
  strOrNull,
  type Rec,
} from "../shared/narrow.ts"

const LOOKBACK_MS = 24 * 3600_000
const PAGE = 50
/** Pages listed per pass at most; a backlog continues on the next pass. */
const MAX_PAGES = 20
/** How far back each pass relists from the cursor, for mail stored late. */
const OVERLAP_MS = 10 * 60_000
/** One notice per member per hour at most. */
const NOTICE_EVERY_MS = 3600_000
/** At most this many emails are handled per pass; the rest wait for the next. */
const MAX_PER_PASS = 10
/** Handled ids kept; older ones fall outside the lookback anyway. */
const MAX_KEPT = 2000
const MAX_ATTEMPTS = 3
const OUTCOMES = ["asked", "batched", "skipped", "unknown"] as const

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
    /** Every email received up to here is handled; the next pass starts here. */
    cursor: strOrNull(r, "cursor", "mail", 40),
    handled: items(r, "handled", "mail", MAX_KEPT, handled),
    /** Member user id to when they were last asked, ISO. */
    asked: askedTimes(record(r["asked"], "mail.asked")),
  }
}

function askedTimes(r: Rec): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [userId, at] of Object.entries(r)) {
    if (typeof at !== "string" || at.length > 40)
      throw new ParseError(`mail.asked.${userId}: not a time`)
    out[userId.slice(0, 80)] = at
  }
  return out
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
    this.#state = stored ?? {
      since: this.#now().toISOString(),
      cursor: null,
      handled: [],
      asked: {},
    }
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
    const todo: string[] = []
    // The newest time up to which everything listed is handled.
    let handledTo: string | null = null
    let gap = false
    for await (const m of this.#oldestFirst()) {
      if (done.has(m.id)) {
        if (!gap && m.received_at !== null) handledTo = m.received_at
        continue
      }
      done.add(m.id) // listed twice when new mail shifts the pages
      gap = true
      todo.push(m.id)
      if (todo.length >= MAX_PER_PASS) break
    }
    if (handledTo !== null && handledTo > (this.#state.cursor ?? ""))
      this.#change({ ...this.#state, cursor: handledTo })
    for (const id of todo) await this.#try(id)
  }

  /**
   * The stored mail from the cursor on (a little before it, for mail stored
   * late), oldest first. The platform lists newest first, so the pages are
   * read from the last one back.
   */
  async *#oldestFirst(): AsyncGenerator<{ id: string; received_at: string | null }> {
    const floors = [Date.parse(this.#state.since), this.#now().getTime() - LOOKBACK_MS]
    if (this.#state.cursor !== null) floors.push(Date.parse(this.#state.cursor) - OVERLAP_MS)
    const since = new Date(Math.max(...floors)).toISOString()
    const at = "search_inbound_emails"
    const page = async (offset: number) => {
      const r = record(
        await this.#o.tools.call(at, { since, status: "stored", limit: PAGE, offset }),
        at
      )
      return { list: items(r, "items", at, PAGE, listed), total: num(r, "total", at) }
    }
    const first = await page(0)
    let offset = Math.max(0, first.total - PAGE)
    for (let n = 0; n < MAX_PAGES; n++) {
      const { list } = offset === 0 ? first : await page(offset)
      // The last page may overlap the one before it; duplicates are skipped.
      yield* [...list].reverse()
      if (offset === 0) return
      offset = Math.max(0, offset - PAGE)
    }
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
    const last = this.#state.asked[member.userId]
    if (last !== undefined && this.#now().getTime() - Date.parse(last) < NOTICE_EVERY_MS) {
      this.#done(id, "batched", member.userId) // that notice covers mail from then on
      return
    }
    try {
      await this.#o.tools.call("notify_human", {
        user_ids: [member.userId],
        subject: "An email in your name reached the Quote desk",
        // The member's own address from the directory, not the From header.
        body: noticeBody(memberEmail, mail.received_at ?? this.#now().toISOString()),
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
      this.#asked(member.userId)
      this.#done(id, "unknown", member.userId)
      this.#log(`${id}: the notice may or may not have gone out; not sending it again`)
      return
    }
    this.#asked(member.userId)
    this.#done(id, "asked", member.userId)
    this.#log(`${id}: asked its sender to confirm it`)
  }

  #asked(userId: string): void {
    const asked = { ...this.#state.asked, [userId]: this.#now().toISOString() }
    this.#change({ ...this.#state, asked })
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
 * The notice: written by the app, with nothing from the email but the
 * member's own address and a time, so it can't carry instructions to the bot.
 */
export function noticeBody(from: string, since: string): string {
  return [
    `Mail from ${from} reached the Quote desk, starting ${since}.`,
    "Email addresses aren't verified, so nothing has been done with it, and the bot hasn't read it.",
    "You get at most one of these an hour; more mail from your address in that hour is covered by this one.",
    "",
    `If you sent it, reply here and the bot will read the mail from ${from} received since ${since}`,
    "(search_inbound_emails) and help. If you didn't, ignore this.",
  ].join("\n")
}
