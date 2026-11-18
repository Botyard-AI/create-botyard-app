// Where each quote's reviewer handoff stands, kept in data/handoffs.json so a
// restart picks up the tasks it was waiting on.
//
// A handoff belongs to one submission of a quote (`round`, the time it entered
// finance review). A quote sent back and resubmitted is a new round: the old
// handoff no longer applies, and the reviewer gets a new task.
//
// Kinds: `creating` is saved before the task is created, so a crash or a failed
// save after the create can't lead to a second task: a `creating` handoff found
// later is never created again (it goes manual). `task` is a task being
// watched, bound to the reviewer it was assigned to. `answered` holds the
// reviewer's recommendation for finance to confirm. `manual` means there is no
// recommendation coming: finance decides the reviewer's step without one.
import { DECISIONS } from "../../shared/domain.ts"
import { items, num, oneOf, record, str, strOrNull, type Rec } from "../../shared/narrow.ts"

const at = "handoffs"

function common(r: Rec, p: string) {
  return {
    quote_id: str(r, "quote_id", p, 40),
    round: str(r, "round", p, 40),
    /** When this state began, ISO. */
    since: str(r, "since", p, 40),
  }
}

/** The reviewer bot a task was assigned to. Only its verdict counts. */
function reviewer(value: unknown, p: string) {
  const r = record(value, p)
  return { id: str(r, "id", p, 80), slug: str(r, "slug", p, 63), name: str(r, "name", p) }
}

function handoff(value: unknown, p: string) {
  const r = record(value, p)
  const kind = oneOf(r, "kind", ["creating", "task", "answered", "manual"], p)
  if (kind === "creating") {
    return {
      ...common(r, p),
      kind,
      board: str(r, "board", p, 63),
      reviewer: reviewer(r["reviewer"], `${p}.reviewer`),
    }
  }
  if (kind === "answered") {
    return {
      ...common(r, p),
      kind,
      /** Who recommends: the reviewer the task was assigned to. */
      reviewer: str(r, "reviewer", p),
      decision: oneOf(r, "decision", DECISIONS, p),
      note: str(r, "note", p, 2000),
    }
  }
  if (kind === "manual") {
    return {
      ...common(r, p),
      kind,
      /** Why the reviewer's verdict is recorded by hand, for the quote page. */
      reason: str(r, "reason", p, 1000),
      /** What to do about it, e.g. the message to send the reviewer bot. */
      instruction: strOrNull(r, "instruction", p, 1000),
    }
  }
  return {
    ...common(r, p),
    kind,
    board: str(r, "board", p, 63),
    reviewer: reviewer(r["reviewer"], `${p}.reviewer`),
    task_id: str(r, "task_id", p, 80),
    task_number: num(r, "task_number", p),
    /** The column at the last check. */
    column: str(r, "column", p, 80),
    last_checked_at: strOrNull(r, "last_checked_at", p, 40),
    /** Not checked again before this, ISO. */
    next_check_at: str(r, "next_check_at", p, 40),
    /** The wait before the next check, doubled while nothing changes. */
    delay_ms: num(r, "delay_ms", p),
    /** Task reads refused in a row. */
    failures: num(r, "failures", p),
    /** Set while the task is moved but has no usable verdict.json yet. */
    detail: strOrNull(r, "detail", p, 1000),
  }
}

export function parseHandoffs(value: unknown) {
  return items(record(value, at), "handoffs", at, 100_000, handoff)
}

export type Handoff = ReturnType<typeof handoff>
export type TaskHandoff = Extract<Handoff, { kind: "task" }>
export type CreatingHandoff = Extract<Handoff, { kind: "creating" }>
export type Reviewer = TaskHandoff["reviewer"]
export type ManualHandoff = Extract<Handoff, { kind: "manual" }>

export class HandoffStore {
  #byQuote: ReadonlyMap<string, Handoff>
  readonly #save: (handoffs: readonly Handoff[]) => void

  constructor(
    options: { handoffs?: readonly Handoff[] | null; save?: (h: readonly Handoff[]) => void } = {}
  ) {
    this.#byQuote = new Map((options.handoffs ?? []).map((h) => [h.quote_id, h]))
    this.#save = options.save ?? (() => undefined)
  }

  get(quoteId: string): Handoff | undefined {
    return this.#byQuote.get(quoteId)
  }

  all(): Handoff[] {
    return [...this.#byQuote.values()]
  }

  /** Saves, then publishes: a failed save changes nothing. */
  set(h: Handoff): void {
    this.#commit(new Map([...this.#byQuote, [h.quote_id, h]]))
  }

  /** Forgets a quote's handoff. */
  delete(quoteId: string): void {
    if (!this.#byQuote.has(quoteId)) return
    this.#commit(new Map([...this.#byQuote].filter(([id]) => id !== quoteId)))
  }

  /** Forgets the handoffs of quotes `keep` refuses. */
  prune(keep: (h: Handoff) => boolean): void {
    const next = new Map([...this.#byQuote].filter(([, h]) => keep(h)))
    if (next.size !== this.#byQuote.size) this.#commit(next)
  }

  #commit(next: ReadonlyMap<string, Handoff>): void {
    this.#save([...next.values()])
    this.#byQuote = next
  }
}
