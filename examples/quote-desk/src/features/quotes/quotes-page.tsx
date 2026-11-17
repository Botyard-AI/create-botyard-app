import { useEffect, useState } from "react"
import type { HandoffView, QuoteSummary, QuoteView, SettingsView } from "../../../shared/types.ts"
import { Notice, Panel } from "@/components/ui/bits"
import { getHandoff, getQuote, getSettings, listQuotes } from "@/lib/quotes-api"
import { QuoteDetail } from "./quote-detail"
import { QuoteList } from "./quote-list"

type Loaded<T> =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly value: T }

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** The list of quotes beside the selected one. Refreshes every 10 s while open. */
export function QuotesPage({
  selected,
  onSelect,
  onEdit,
}: Readonly<{
  selected: string | null
  onSelect: (id: string) => void
  onEdit: (id: string) => void
}>) {
  const [list, setList] = useState<Loaded<readonly QuoteSummary[]>>({ state: "loading" })
  const [quote, setQuote] = useState<Loaded<QuoteView> | null>(null)
  const [tick, setTick] = useState(0)
  // Who may decide what. Without it nobody gets decision buttons; the server checks anyway.
  const [settings, setSettings] = useState<SettingsView | null>(null)
  // The reviewer bot's part of the selected quote; null until read, or if it could not be.
  const [handoff, setHandoff] = useState<{ id: string; value: HandoffView } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    getSettings(controller.signal)
      .then(setSettings)
      .catch(() => {
        // Leave the buttons out; the quotes still show.
      })
    return () => {
      controller.abort()
    }
  }, [])

  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => t + 1)
    }, 10_000)
    return () => {
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    listQuotes(controller.signal)
      .then((value) => {
        setList({ state: "ready", value })
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setList({ state: "error", message: message(err) })
      })
    return () => {
      controller.abort()
    }
  }, [tick])

  useEffect(() => {
    if (selected === null) {
      setQuote(null)
      return undefined
    }
    const controller = new AbortController()
    setQuote((q) => (q?.state === "ready" && q.value.id === selected ? q : { state: "loading" }))
    getQuote(selected, controller.signal)
      .then((value) => {
        setQuote({ state: "ready", value })
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setQuote({ state: "error", message: message(err) })
      })
    getHandoff(selected, controller.signal)
      .then((value) => {
        setHandoff({ id: selected, value })
      })
      .catch(() => {
        // The panel is left out; the quote still shows.
        if (!controller.signal.aborted) setHandoff(null)
      })
    return () => {
      controller.abort()
    }
  }, [selected, tick])

  return (
    <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <Panel title="Quotes" className="h-fit">
        {list.state === "loading" ? (
          <p className="text-muted-foreground p-4 text-sm">Loading…</p>
        ) : null}
        {list.state === "error" ? (
          <div className="p-4">
            <Notice tone="error">{list.message}</Notice>
          </div>
        ) : null}
        {list.state === "ready" ? (
          <QuoteList quotes={list.value} selected={selected} onSelect={onSelect} />
        ) : null}
      </Panel>
      <div className="min-w-0">
        {quote === null ? (
          <p className="text-muted-foreground p-4 text-sm">
            Pick a quote to see its numbers, approvals and history.
          </p>
        ) : null}
        {quote?.state === "loading" ? (
          <p className="text-muted-foreground p-4 text-sm">Loading…</p>
        ) : null}
        {quote?.state === "error" ? <Notice tone="error">{quote.message}</Notice> : null}
        {quote?.state === "ready" ? (
          <QuoteDetail
            quote={quote.value}
            settings={settings}
            handoff={handoff?.id === quote.value.id ? handoff.value : null}
            now={new Date()}
            onEdit={onEdit}
            onChanged={(value) => {
              setQuote({ state: "ready", value })
              setTick((t) => t + 1)
            }}
          />
        ) : null}
      </div>
    </div>
  )
}
