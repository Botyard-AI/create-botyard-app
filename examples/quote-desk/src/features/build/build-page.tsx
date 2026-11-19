import { useEffect, useState } from "react"
import type { Meta, QuoteView } from "../../../shared/types.ts"
import { Notice } from "@/components/ui/bits"
import { getQuote } from "@/lib/quotes-api"
import { BuildQuote } from "./build-quote"

type Props = Readonly<{
  meta: Meta
  viewerEmail: string | null
  /** The draft to edit, or null for a new quote. */
  quoteId: string | null
  onSaved: (id: string, submitted: boolean) => void
  onCancel: () => void
}>

/** The builder, with the draft loaded first when one is being edited. */
export function BuildPage({ meta, viewerEmail, quoteId, onSaved, onCancel }: Props) {
  // The parent gives each draft its own BuildPage (key={quoteId}), so this
  // only ever holds the draft named by quoteId.
  const [loaded, setLoaded] = useState<QuoteView | Error | null>(null)
  const editing = quoteId === null ? null : (loaded ?? "loading")
  useEffect(() => {
    if (quoteId === null) return undefined
    const controller = new AbortController()
    getQuote(quoteId, controller.signal)
      .then((q) => {
        setLoaded(q.status === "draft" ? q : new Error(`${q.id} is no longer a draft.`))
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setLoaded(err instanceof Error ? err : new Error(String(err)))
      })
    return () => {
      controller.abort()
    }
  }, [quoteId])
  if (editing === "loading")
    return <p className="text-muted-foreground text-sm">Loading {quoteId}…</p>
  if (editing instanceof Error) return <Notice tone="error">{editing.message}</Notice>
  return (
    <BuildQuote
      key={editing?.id ?? "new"}
      meta={meta}
      viewerEmail={viewerEmail}
      editing={editing}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  )
}
