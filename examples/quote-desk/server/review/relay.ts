// Hands quotes in finance review to the reviewer bot as workforce tasks, and
// records its verdict when it answers.
//
// Each tick looks only at the quotes waiting for the reviewer bot: never at
// every task on the board. A quote with no handoff yet gets one: a task, if
// the setup checks pass, or a manual handoff saying why not. A task is read
// again only when its check is due, with the wait doubling (to 5 minutes)
// while nothing changes. When the task moves to Approved or Changes requested,
// verdict.json is read and recorded as the reviewer bot's decision.
//
// Anything that cannot work falls back to manual: a finance approver then
// records the reviewer bot's verdict on the quote page. The relay never
// creates a task nobody will pick up, and never retries a create whose outcome
// is unknown.
import { BotyardError, OutcomeUnknownError, ToolError, type ToolCaller } from "@botyard/runtime"
import { ParseError } from "../../shared/narrow.ts"
import type { HandoffView, QuoteView } from "../../shared/types.ts"
import { listOrgBots } from "../org.ts"
import { DeskError, type QuoteDesk } from "../quotes/desk.ts"
import { ERP_SEED } from "../quotes/erp-seed.ts"
import type { SettingsStore } from "../quotes/settings.ts"
import { brief } from "./brief.ts"
import type { Handoff, HandoffStore, TaskHandoff } from "./handoffs.ts"
import {
  FileFetchError,
  VERDICT_FILE,
  fetchSmallFile,
  parseVerdict,
  type Fetch,
} from "./verdict.ts"
import {
  boardBotIds,
  createReviewTask,
  missingColumns,
  myBoards,
  readTask,
  taskFilesNamed,
  type ReviewColumn,
} from "./workforce.ts"

const FIRST_DELAY_MS = 15_000
const MAX_DELAY_MS = 5 * 60_000
/** At most this many quotes are handled per tick; the rest wait for the next. */
const MAX_PER_TICK = 10
/** Task reads refused in a row before the task counts as gone. */
const MAX_FAILURES = 3
/** How the relay signs what it writes in a quote's history. */
const DESK = "Quote desk"

export const NOT_SET_UP =
  "Reviewer bot handoff isn't set up: ask an admin to pick a board in Settings."

/** The reviewer handoff can run: the board and the reviewer bot on it. */
export type ReviewSetup =
  | {
      readonly kind: "ready"
      readonly board: string
      readonly reviewer: { readonly id: string; readonly slug: string; readonly name: string }
    }
  | { readonly kind: "off"; readonly reason: string; readonly instruction: string | null }

/** What a reviewer bot is asked to do to join a board. */
export function joinInstruction(reviewer: string, board: string): string {
  return (
    `Ask ${reviewer} to join the board: "Please join the workforce board ${board} ` +
    `(join_workforce) and check it for Quote desk finance reviews."`
  )
}

/**
 * Whether a handoff can go out now. Every check that fails says why, for the
 * quote page and Settings.
 */
export async function checkSetup(
  tools: ToolCaller,
  settings: { reviewer_bot: string | null; review_board: string | null }
): Promise<ReviewSetup> {
  const off = (reason: string, instruction: string | null = null): ReviewSetup => ({
    kind: "off",
    reason,
    instruction,
  })
  if (settings.review_board === null) return off(NOT_SET_UP)
  if (settings.reviewer_bot === null) return off("No reviewer bot is picked in Settings.")
  const slug = settings.review_board
  const board = (await myBoards(tools)).find((b) => b.slug === slug)
  if (board === undefined)
    return off(`Board ${slug} doesn't exist, or this bot is no longer a member of it.`)
  const missing = missingColumns(board)
  if (missing.length > 0) return off(`Board ${slug} is missing the columns ${missing.join(", ")}.`)
  const reviewer = (await listOrgBots(tools)).find((b) => b.slug === settings.reviewer_bot)
  if (reviewer === undefined) return off(`${settings.reviewer_bot} is not a bot in this org.`)
  if (!(await boardBotIds(tools, slug)).has(reviewer.id))
    return off(
      `${reviewer.name} is not a member of board ${slug}.`,
      joinInstruction(reviewer.name, slug)
    )
  return { kind: "ready", board: slug, reviewer }
}

/**
 * The submission a quote is in: how many times it has entered finance review,
 * and when it last did. The count keeps rounds apart even within one clock tick.
 */
export function reviewRound(q: QuoteView): string | null {
  const entered = q.events.filter((e) => e.type === "status" && e.to === "finance_review")
  const last = entered.at(-1)
  return last === undefined ? null : `${String(entered.length)}@${last.ts}`
}

/** A quote waiting for the reviewer bot, with its round. */
function awaiting(q: QuoteView): string | null {
  if (q.status !== "finance_review" || q.approvals.bot_review !== null) return null
  return reviewRound(q)
}

function answerInstructions(quoteId: string): string {
  const example = JSON.stringify({
    quote_id: quoteId,
    decision: "approve or reject",
    note: "one or two sentences for the approval card",
    analysis: "optional: a longer analysis for the quote history",
  })
  return [
    "**How to answer**",
    `1. Attach a file named \`${VERDICT_FILE}\` to this task, with exactly these fields:`,
    "",
    "```json",
    example,
    "```",
    "",
    "2. Then move this task to **Approved** (decision `approve`) or **Changes requested** " +
      "(decision `reject`). Attach the file first: the Quote desk reads it when the task moves.",
    "",
    "Changes requested sends the quote back to its owner with your note, so say what " +
      "would make it acceptable.",
  ].join("\n")
}

export type RelayOptions = {
  readonly desk: QuoteDesk
  readonly settings: SettingsStore
  readonly handoffs: HandoffStore
  readonly tools: ToolCaller
  /** Hosts verdict.json links may point at (QUOTE_DESK_FILE_HOSTS). */
  readonly fileHosts: ReadonlySet<string>
  readonly fetch?: Fetch
  readonly now?: () => Date
  readonly log?: (line: string) => void
}

export class ReviewRelay {
  readonly #o: RelayOptions
  readonly #now: () => Date
  readonly #log: (line: string) => void
  #running: Promise<void> | null = null
  #timer: NodeJS.Timeout | null = null

  constructor(options: RelayOptions) {
    this.#o = options
    this.#now = options.now ?? (() => new Date())
    this.#log = options.log ?? ((line) => process.stderr.write(`[review] ${line}\n`))
  }

  start(intervalMs = 10_000): void {
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

  /** The handoff of a quote waiting for the reviewer bot, for the quote page. */
  state(quote: QuoteView): HandoffView {
    const round = awaiting(quote)
    if (round === null) return { kind: "none" }
    const h = this.#o.handoffs.get(quote.id)
    if (h?.round !== round) return { kind: "pending" }
    if (h.kind === "manual")
      return { kind: h.kind, since: h.since, reason: h.reason, instruction: h.instruction }
    return {
      kind: h.kind,
      since: h.since,
      board: h.board,
      task_number: h.task_number,
      column: h.column,
      last_checked_at: h.last_checked_at,
      detail: h.detail,
    }
  }

  /** Whether the reviewer bot's verdict on this quote is recorded by hand now. */
  isManual(quote: QuoteView): boolean {
    return this.state(quote).kind === "manual"
  }

  async #pass(): Promise<void> {
    const { desk, handoffs } = this.#o
    const waiting = desk
      .list()
      .filter((s) => s.status === "finance_review")
      .map((s) => desk.get(s.id))
      .flatMap((q) => {
        const round = awaiting(q)
        return round === null ? [] : [{ quote: q, round }]
      })
    const current = new Map(waiting.map((w) => [w.quote.id, w.round]))
    handoffs.prune((h) => current.get(h.quote_id) === h.round)

    const now = this.#now().getTime()
    const work = waiting.filter(({ quote }) => {
      const h = handoffs.get(quote.id)
      return h === undefined || (h.kind === "task" && Date.parse(h.next_check_at) <= now)
    })
    let setup: Promise<ReviewSetup> | null = null
    for (const { quote, round } of work.slice(0, MAX_PER_TICK)) {
      const h = handoffs.get(quote.id)
      if (h?.kind === "task") {
        await this.#check(h)
      } else {
        setup ??= checkSetup(this.#o.tools, this.#o.settings.get())
        await this.#handOff(quote, round, await setup)
      }
    }
  }

  // ---------- handing off ----------

  async #handOff(quote: QuoteView, round: string, setup: ReviewSetup): Promise<void> {
    if (setup.kind === "off") {
      this.#manual({ quote_id: quote.id, round }, setup.reason, setup.instruction)
      return
    }
    const { board, reviewer } = setup
    let task
    try {
      task = await createReviewTask(this.#o.tools, {
        board,
        title: `Finance review: ${quote.id} (${quote.account})`,
        description: this.#brief(quote),
        reviewerBotId: reviewer.id,
      })
    } catch (err) {
      this.#createFailed(quote, round, board, err)
      return
    }
    const at = this.#now()
    this.#o.handoffs.set({
      kind: "task",
      quote_id: quote.id,
      round,
      since: at.toISOString(),
      board,
      task_id: task.id,
      task_number: task.number,
      column: task.column_id,
      last_checked_at: null,
      next_check_at: new Date(at.getTime() + FIRST_DELAY_MS).toISOString(),
      delay_ms: FIRST_DELAY_MS,
      failures: 0,
      detail: null,
    })
    this.#note(
      quote.id,
      `Sent to ${reviewer.name} for finance review: task #${String(task.number)} on board ${board}.`
    )
    await this.#nudge(reviewer.slug, board, task.number)
  }

  #createFailed(quote: QuoteView, round: string, board: string, err: unknown): void {
    if (err instanceof OutcomeUnknownError) {
      // The task may exist. Creating another could hand the quote over twice.
      this.#manual(
        { quote_id: quote.id, round },
        `Creating the review task on board ${board} may or may not have worked.`,
        `Check board ${board} for a task on ${quote.id}, and record the reviewer's verdict here.`
      )
      return
    }
    if (err instanceof BotyardError && !(err instanceof ToolError)) {
      // Refused before the tool ran (transport): nothing was created; try next tick.
      this.#log(`${quote.id}: could not reach the platform to create the task`)
      return
    }
    this.#manual(
      { quote_id: quote.id, round },
      `The review task could not be created on board ${board}: ${message(err)}`
    )
  }

  #brief(quote: QuoteView): string {
    const budget = this.#o.desk.quarter().territories.find((t) => t.territory === quote.territory)
    const customer = ERP_SEED.customers.find((c) => c.account_id === quote.account_id)
    return brief({ quote, customer, budget, answer: answerInstructions(quote.id) })
  }

  /** Tells the reviewer a task is waiting, if a handoff thread is set. Silent otherwise. */
  async #nudge(reviewer: string, board: string, number: number): Promise<void> {
    const thread = this.#o.settings.get().handoff_thread
    if (thread === null) return
    try {
      await this.#o.tools.call("send_message_to_bot", {
        bot_slug: reviewer,
        origin_conversation_id: thread,
        message:
          `A Quote desk finance review is waiting for you: task #${String(number)} on ` +
          `board ${board}. The task has the brief and says how to answer.`,
      })
    } catch (err) {
      this.#log(`nudging ${reviewer} failed: ${message(err)}`)
    }
  }

  // ---------- checking a task ----------

  async #check(h: TaskHandoff): Promise<void> {
    let column: string
    try {
      column = (await readTask(this.#o.tools, h.board, h.task_number)).column_id
    } catch (err) {
      await this.#readFailed(h, err)
      return
    }
    if (column !== "approved" && column !== "changes-requested") {
      this.#later(h, { column, detail: null })
      return
    }
    await this.#verdict(h, column)
  }

  async #readFailed(h: TaskHandoff, err: unknown): Promise<void> {
    if (!(err instanceof ToolError)) {
      // Transport trouble or an unknown outcome: the task may be fine. Wait.
      this.#later(h, {})
      return
    }
    const boardGone = await myBoards(this.#o.tools).then(
      (boards) => !boards.some((b) => b.slug === h.board),
      () => false
    )
    if (boardGone) {
      this.#lost(h, `Board ${h.board} is gone, or this bot was removed from it.`)
      return
    }
    if (h.failures + 1 >= MAX_FAILURES) {
      this.#lost(h, `Task #${String(h.task_number)} on board ${h.board} can't be read any more.`)
      return
    }
    this.#later(h, { failures: h.failures + 1 })
  }

  async #verdict(h: TaskHandoff, column: ReviewColumn): Promise<void> {
    const moved = column === "approved" ? "Approved" : "Changes requested"
    const waitForFile = (detail: string) => {
      this.#later(h, { column, detail })
    }
    let text: string
    try {
      const files = await taskFilesNamed(this.#o.tools, h.board, h.task_id, VERDICT_FILE)
      const file = files.at(-1)
      if (file === undefined) {
        waitForFile(`Moved to ${moved}; waiting for ${VERDICT_FILE}.`)
        return
      }
      text = await fetchSmallFile(file.download_url, this.#o.fileHosts, this.#o.fetch)
    } catch (err) {
      if (err instanceof FileFetchError && err.kind === "refused") {
        this.#lost(h, `${VERDICT_FILE} can't be read: ${err.message}.`)
        return
      }
      waitForFile(`Moved to ${moved}; ${VERDICT_FILE} could not be read yet (${message(err)}).`)
      return
    }
    this.#record(h, column, text)
  }

  #record(h: TaskHandoff, column: ReviewColumn, text: string): void {
    const { desk, settings } = this.#o
    let verdict
    try {
      verdict = parseVerdict(text, h.quote_id, column)
    } catch (err) {
      this.#lost(h, err instanceof ParseError ? err.message : message(err))
      return
    }
    const quote = desk.get(h.quote_id)
    if (awaiting(quote) !== h.round) return // decided or sent back meanwhile; the next pass prunes
    const reviewer = settings.get().reviewer_bot ?? "reviewer bot"
    const by = `${reviewer} (bot)`
    try {
      if (verdict.analysis !== "") desk.comment(h.quote_id, by, verdict.analysis)
      desk.decide(h.quote_id, "bot_review", verdict.decision, verdict.note, by)
    } catch (err) {
      if (!(err instanceof DeskError)) throw err
      this.#log(`${h.quote_id}: verdict not recorded: ${err.message}`)
    }
  }

  // ---------- state changes ----------

  #later(
    h: TaskHandoff,
    change: Partial<Pick<TaskHandoff, "column" | "detail" | "failures">>
  ): void {
    const at = this.#now()
    const delay = Math.min(h.delay_ms * 2, MAX_DELAY_MS)
    this.#o.handoffs.set({
      ...h,
      failures: 0,
      ...change,
      last_checked_at: at.toISOString(),
      next_check_at: new Date(at.getTime() + delay).toISOString(),
      delay_ms: delay,
    })
  }

  /** A handoff that stopped working mid-review: manual from now, and said so in the history. */
  #lost(h: TaskHandoff, reason: string): void {
    this.#manual(h, reason, null)
    this.#note(
      h.quote_id,
      `Reviewer handoff stopped (task #${String(h.task_number)} on board ${h.board}): ${reason} ` +
        "A finance approver records the reviewer bot's verdict here instead."
    )
  }

  #manual(
    h: Pick<Handoff, "quote_id" | "round">,
    reason: string,
    instruction: string | null = null
  ): void {
    this.#o.handoffs.set({
      kind: "manual",
      quote_id: h.quote_id,
      round: h.round,
      since: this.#now().toISOString(),
      reason,
      instruction,
    })
  }

  #note(quoteId: string, text: string): void {
    try {
      this.#o.desk.comment(quoteId, DESK, text)
    } catch (err) {
      if (!(err instanceof DeskError)) throw err
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
