// Where each quote's reviewer handoff stands, kept in data/handoffs.json so a
// restart picks up the tasks it was waiting on.
//
// A handoff belongs to one submission of a quote (`round`, the time it entered
// finance review). A quote sent back and resubmitted is a new round: the old
// handoff no longer applies, and the reviewer gets a new task.
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

function handoff(value: unknown, p: string) {
  const r = record(value, p)
  const kind = oneOf(r, "kind", ["task", "manual"], p)
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
