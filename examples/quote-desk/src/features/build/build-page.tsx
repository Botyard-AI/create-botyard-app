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
  // The last draft read, kept with its id: whether it is still loading is
  // worked out below from quoteId, not set from the effect.
  const [loaded, setLoaded] = useState<{ id: string; value: QuoteView | Error } | null>(null)
  let editing: QuoteView | Error | "loading" | null = null
  if (quoteId !== null) editing = loaded?.id === quoteId ? loaded.value : "loading"
  useEffect(() => {
    if (quoteId === null) return undefined
    const controller = new AbortController()
    getQuote(quoteId, controller.signal)
      .then((q) => {
        const value = q.status === "draft" ? q : new Error(`${q.id} is no longer a draft.`)
        setLoaded({ id: quoteId, value })
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setLoaded({ id: quoteId, value: err instanceof Error ? err : new Error(String(err)) })
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
