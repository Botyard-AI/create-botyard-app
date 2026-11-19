import { RotateCcw } from "lucide-react"
import { useEffect, useState } from "react"
import type { Meta } from "../shared/types.ts"
import { Notice } from "@/components/ui/bits"
import { Button } from "@/components/ui/button"
import { ViewerBadge, type ViewerState } from "@/components/viewer-badge"
import { BuildPage } from "@/features/build/build-page"
import { QuarterClose } from "@/features/quarter-close"
import { QuotesPage } from "@/features/quotes/quotes-page"
import { SettingsPage } from "@/features/settings/settings-page"
import { fetchViewer } from "@/lib/api"
import { getMeta, resetDemo } from "@/lib/quotes-api"
import { href, useRoute, type Route } from "@/lib/route"
import { cn } from "@/lib/utils"

const TABS: readonly { route: Route; label: string }[] = [
  { route: { tab: "build", quoteId: null }, label: "Build quote" },
  { route: { tab: "quotes", quoteId: null }, label: "Quotes & approvals" },
  { route: { tab: "quarter" }, label: "Quarter close" },
  { route: { tab: "settings" }, label: "Settings" },
]

type MetaState =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly meta: Meta }

export default function App() {
  const [viewer, setViewer] = useState<ViewerState>({ status: "loading" })
  const [meta, setMeta] = useState<MetaState>({ state: "loading" })
  const [route, go] = useRoute()
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    fetchViewer(controller.signal)
      .then((v) => {
        setViewer({ status: "ready", viewer: v })
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted)
          setViewer({ status: "error", message: err instanceof Error ? err.message : String(err) })
      })
    getMeta(controller.signal)
      .then((m) => {
        setMeta({ state: "ready", meta: m })
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted)
          setMeta({ state: "error", message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      controller.abort()
    }
  }, [])

  const viewerEmail =
    viewer.status === "ready" && viewer.viewer?.kind === "member" ? viewer.viewer.email : null

  const [confirmReset, setConfirmReset] = useState(false)

  async function reset() {
    setConfirmReset(false)
    await resetDemo()
    setGeneration((g) => g + 1)
    go({ tab: "build", quoteId: null })
  }

  return (
    <div className="bg-muted/30 min-h-svh">
      <header className="bg-background sticky top-0 z-10 border-b">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-3">
          <div className="flex items-center gap-6">
            <span className="font-semibold">Quote desk</span>
            <nav className="flex gap-1" aria-label="Sections">
              {TABS.map((t) => (
                <a
                  key={t.label}
                  href={href(t.route)}
                  aria-current={t.route.tab === route.tab ? "page" : undefined}
                  onClick={(e) => {
                    e.preventDefault()
                    go(t.route)
                  }}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm",
                    t.route.tab === route.tab
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-muted"
                  )}
                >
                  {t.label}
                </a>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-2">
            {confirmReset ? (
              <>
                <Button variant="destructive" size="sm" onClick={() => void reset()}>
                  Reset every quote?
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setConfirmReset(false)
                  }}
                >
                  Keep
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setConfirmReset(true)
                }}
              >
                <RotateCcw /> Reset demo
              </Button>
            )}
            <ViewerBadge state={viewer} />
          </div>
        </div>
      </header>
      <main key={generation} className="mx-auto max-w-7xl p-6">
        {meta.state === "loading" ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : null}
        {meta.state === "error" ? (
          <Notice tone="error" role="alert">
            Could not load the quote desk: {meta.message}
          </Notice>
        ) : null}
        {meta.state === "ready" && route.tab === "build" ? (
          <BuildPage
            // A fresh builder for each draft (or a new quote), so nothing from
            // the last one carries over.
            key={route.quoteId ?? "new"}
            meta={meta.meta}
            viewerEmail={viewerEmail}
            quoteId={route.quoteId}
            onSaved={(id) => {
              go({ tab: "quotes", quoteId: id })
            }}
            onCancel={() => {
              go({ tab: "quotes", quoteId: route.quoteId })
            }}
          />
        ) : null}
        {meta.state === "ready" && route.tab === "quotes" ? (
          <QuotesPage
            selected={route.quoteId}
            onSelect={(id) => {
              go({ tab: "quotes", quoteId: id })
            }}
            onEdit={(id) => {
              go({ tab: "build", quoteId: id })
            }}
          />
        ) : null}
        {meta.state === "ready" && route.tab === "quarter" ? <QuarterClose /> : null}
        {meta.state === "ready" && route.tab === "settings" ? <SettingsPage /> : null}
      </main>
    </div>
  )
}
