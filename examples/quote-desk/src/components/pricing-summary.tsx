import { AlertTriangle, CheckCircle2, ShieldCheck, Truck } from "lucide-react"
import type { Pricing } from "../../shared/types.ts"
import { Gauge, Notice, Row } from "@/components/ui/bits"
import { eur } from "@/lib/format"

/** Totals, margin and discount against their limits, and the finance flags. */
export function PricingSummary({ p }: Readonly<{ p: Pricing }>) {
  const delivery =
    p.delivery.kind === "estimate" ? `Earliest ${p.delivery.earliest_delivery}` : p.delivery.error
  return (
    <div className="grid gap-4">
      <dl className="grid gap-1.5 text-sm">
        {p.order_discount_pct > 0 ? (
          <>
            <Row k="Subtotal" v={eur(p.subtotal_eur)} />
            <Row
              k={`Order discount · ${String(p.order_discount_pct)}%`}
              v={`−${eur(p.order_discount_eur)}`}
            />
          </>
        ) : null}
        <Row k="Net revenue" v={eur(p.revenue_eur)} />
        <Row k={`Delivery · ${p.delivery.option}`} v={eur(p.delivery_cost_eur)} />
        <Row k="Total" v={eur(p.total_eur)} strong />
      </dl>
      <Gauge
        label="Margin"
        value={p.margin_pct}
        limit={p.margin_floor_pct}
        max={Math.max(50, p.margin_pct + 5)}
        good="above"
        hint={`Floor ${String(p.margin_floor_pct)}%`}
      />
      <Gauge
        label="Worst discount"
        value={p.worst_discount_pct}
        limit={p.discount_escalation_pct}
        max={Math.max(30, p.worst_discount_pct + 5)}
        good="below"
        hint={`Escalates over ${String(p.discount_escalation_pct)}%`}
      />
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="bg-muted inline-flex items-center gap-1.5 rounded-full px-2.5 py-1">
          <Truck className="size-3.5" aria-hidden /> {delivery}
        </span>
        <span className="bg-muted inline-flex items-center gap-1.5 rounded-full px-2.5 py-1">
          <ShieldCheck className="size-3.5" aria-hidden /> Credit: {p.credit.decision}
        </span>
      </div>
      {p.flags.length === 0 ? (
        <Notice tone="ok">
          <span className="flex items-center gap-2">
            <CheckCircle2 className="size-4" aria-hidden /> Inside the rules: margin, discount,
            credit and delivery all pass.
          </span>
        </Notice>
      ) : (
        <Notice tone="warn" role="status">
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangle className="size-4" aria-hidden /> Finance will look closely
          </p>
          <ul className="mt-1 list-disc pl-6">
            {p.flags.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </Notice>
      )}
    </div>
  )
}
