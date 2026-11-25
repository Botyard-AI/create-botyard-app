import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { SessionExpiredBanner } from "@/components/session-expired-banner"
import { ViewerBadge, type ViewerState } from "@/components/viewer-badge"
import { fetchViewer } from "@/lib/api"

export default function App() {
  const [state, setState] = useState<ViewerState>({ status: "loading" })

  useEffect(() => {
    const controller = new AbortController()
    fetchViewer(controller.signal)
      .then((viewer) => {
        setState({ status: "ready", viewer })
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({ status: "error", message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      controller.abort()
    }
  }, [])

  return (
    <div className="min-h-svh">
      <SessionExpiredBanner />
      <header className="flex items-center justify-between gap-4 border-b px-6 py-3">
        <span className="font-semibold">Botyard app</span>
        <ViewerBadge state={state} />
      </header>
      <main className="mx-auto grid max-w-3xl gap-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle>It works</CardTitle>
            <CardDescription>
              A Node API and a React UI, served from your bot as a Bot Page.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-muted-foreground grid gap-2 text-sm">
            <p>
              Edit <code>src/App.tsx</code> for the UI and <code>server/app.ts</code> for the API.
              The badge above comes from <code>/api/me</code>, which asks{" "}
              <code>@botyard/botpage</code> who is viewing.
            </p>
            <p>
              Call Botyard tools from the server with <code>@botyard/runtime</code>.
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
