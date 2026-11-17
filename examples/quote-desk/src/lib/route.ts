// The URL is the source of truth for the tab and the selected quote:
//   /build · /build/Q-2026-0202 (edit a draft) · /quotes · /quotes/Q-2026-0202 · /quarter
import { useCallback, useEffect, useState } from "react"

export type Route =
  | { readonly tab: "build"; readonly quoteId: string | null }
  | { readonly tab: "quotes"; readonly quoteId: string | null }
  | { readonly tab: "quarter" }

const ID = "(Q-\\d{4}-\\d{4})"

export function parseRoute(pathname: string): Route {
  const p = pathname.replace(/\/+$/, "") || "/"
  const build = new RegExp(`^/build(?:/${ID})?$`).exec(p)
  if (build) return { tab: "build", quoteId: build[1] ?? null }
  const quotes = new RegExp(`^/quotes(?:/${ID})?$`).exec(p)
  if (quotes) return { tab: "quotes", quoteId: quotes[1] ?? null }
  if (p === "/quarter") return { tab: "quarter" }
  return { tab: "build", quoteId: null }
}

export function href(route: Route): string {
  if (route.tab === "quarter") return "/quarter"
  const suffix = route.quoteId === null ? "" : `/${route.quoteId}`
  return `/${route.tab}${suffix}`
}

export function useRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname))
  useEffect(() => {
    const onPop = () => {
      setRoute(parseRoute(window.location.pathname))
    }
    window.addEventListener("popstate", onPop)
    return () => {
      window.removeEventListener("popstate", onPop)
    }
  }, [])
  const go = useCallback((next: Route) => {
    const path = href(next)
    if (path !== window.location.pathname) window.history.pushState(null, "", path)
    setRoute(parseRoute(path))
  }, [])
  return [route, go]
}
