import type { QuoteEvent } from "../../shared/types.ts"
import { ROLE_LABEL, STATUS_LABEL, when } from "@/lib/format"

function describe(e: QuoteEvent): { what: string; note: string } {
  switch (e.type) {
    case "created":
      return {
        what: "created the quote",
        note: e.on_behalf_of === null ? "" : `on behalf of ${e.on_behalf_of}`,
      }
    case "edited":
      return { what: "edited the draft", note: "" }
    case "status":
      return { what: `moved it to ${STATUS_LABEL[e.to]}`, note: e.note }
    case "approval":
      return {
        what: `${e.decision === "approve" ? "approved" : "requested changes"} as ${ROLE_LABEL[e.role]}`,
        note: e.note,
      }
    case "comment":
      return { what: "commented", note: e.note }
  }
}

/** A quote's history, newest first. */
export function QuoteHistory({ events }: Readonly<{ events: readonly QuoteEvent[] }>) {
  return (
    <ol className="grid gap-3">
      {events
        .map((e, i) => ({ e, i, ...describe(e) }))
        .reverse()
        .map(({ e, i, what, note }) => (
          <li key={`${e.ts}-${String(i)}`} className="text-sm">
            <p>
              <span className="font-medium">{e.by}</span> {what}
              <span className="text-muted-foreground ml-2 text-xs">{when(e.ts)}</span>
            </p>
            {note === "" ? null : (
              <p className="text-muted-foreground mt-0.5 whitespace-pre-wrap">{note}</p>
            )}
          </li>
        ))}
    </ol>
  )
}
