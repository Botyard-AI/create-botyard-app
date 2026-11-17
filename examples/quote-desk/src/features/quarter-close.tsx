import { useEffect, useState } from "react"
import type { QuarterRow } from "../../shared/types.ts"
import { Notice, Panel } from "@/components/ui/bits"
import { eur } from "@/lib/format"
import { getQuarter } from "@/lib/quotes-api"

type State =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly quarter: string; readonly rows: readonly QuarterRow[] }

/** Budget, committed, pipeline and headroom per territory for the current quarter. */
export function QuarterClose() {
  const [s, setS] = useState<State>({ state: "loading" })
  useEffect(() => {
    const controller = new AbortController()
    getQuarter(null, controller.signal)
      .then((q) => {
        setS({ state: "ready", quarter: q.quarter, rows: q.territories })
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted)
          setS({ state: "error", message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      controller.abort()
    }
  }, [])
  if (s.state === "loading") return <p className="text-muted-foreground text-sm">Loading…</p>
  if (s.state === "error") return <Notice tone="error">{s.message}</Notice>
  const daysLeft = s.rows[0]?.days_left
  return (
    <Panel
      title={`Quarter close · ${s.quarter}`}
      aside={
        daysLeft === undefined ? null : (
          <span className="text-muted-foreground text-xs">{daysLeft} days left</span>
        )
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="text-muted-foreground border-b text-xs uppercase">
              <th className="px-4 py-2 text-left font-medium">Territory</th>
              <th className="px-2 py-2 text-right font-medium">Budget</th>
              <th className="px-2 py-2 text-right font-medium">Committed</th>
              <th className="px-2 py-2 text-right font-medium">Pipeline</th>
              <th className="px-2 py-2 text-right font-medium">Headroom</th>
              <th className="px-4 py-2 text-right font-medium">Used</th>
            </tr>
          </thead>
          <tbody>
            {s.rows.map((r) => (
              <tr key={r.territory} className="border-b last:border-0">
                <td className="px-4 py-2 font-medium">{r.territory}</td>
                <td className="px-2 py-2 text-right">{eur(r.budget_eur)}</td>
                <td className="px-2 py-2 text-right">{eur(r.committed_eur)}</td>
                <td className="px-2 py-2 text-right">{eur(r.pipeline_eur)}</td>
                <td className="px-2 py-2 text-right">{eur(r.headroom_eur)}</td>
                <td className="px-4 py-2 text-right">{r.used_pct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
