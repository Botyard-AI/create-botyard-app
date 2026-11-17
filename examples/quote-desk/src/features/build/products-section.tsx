import { Minus, Package, Plus, Trash2 } from "lucide-react"
import type { Meta, Pricing } from "../../../shared/types.ts"
import { Panel } from "@/components/ui/bits"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/form"
import { eur } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { DraftLine } from "./use-draft"

export function ProductsSection({
  meta,
  lines,
  pricing,
  onChange,
}: Readonly<{
  meta: Meta
  lines: readonly DraftLine[]
  pricing: Pricing | null
  onChange: (lines: readonly DraftLine[]) => void
}>) {
  const update = (sku: string, patch: Partial<DraftLine>) => {
    onChange(lines.map((l) => (l.sku === sku ? { ...l, ...patch } : l)))
  }
  const add = (sku: string) => {
    const line = lines.find((l) => l.sku === sku)
    if (line === undefined) onChange([...lines, { sku, qty: "1", unit: "" }])
    else update(sku, { qty: String((Number(line.qty) || 0) + 1) })
  }
  const bump = (line: DraftLine, by: number) => {
    update(line.sku, { qty: String(Math.max(1, (Number(line.qty) || 0) + by)) })
  }
  return (
    <Panel
      title="2 · Products"
      aside={<span className="text-muted-foreground text-xs">Tier prices apply automatically</span>}
    >
      <div className="grid gap-2 p-4 sm:grid-cols-2">
        {meta.products.map((p) => {
          const inCart = lines.find((l) => l.sku === p.sku)
          const from = p.tiers.length > 0 ? Math.min(...p.tiers.map((t) => t.unit_price_eur)) : null
          return (
            <button
              key={p.sku}
              type="button"
              onClick={() => {
                add(p.sku)
              }}
              className={cn(
                "hover:bg-muted flex items-center gap-3 rounded-lg border p-2.5 text-left transition-colors",
                inCart !== undefined && "border-emerald-300 bg-emerald-50/50"
              )}
            >
              <Package className="text-muted-foreground size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{p.name}</span>
                <span className="text-muted-foreground block text-xs tabular-nums">
                  {eur(p.list_price_eur)} / {p.uom}
                  {from === null ? "" : ` · from ${eur(from)}`}
                </span>
              </span>
              {inCart === undefined ? (
                <Plus className="text-muted-foreground size-4" aria-label={`Add ${p.name}`} />
              ) : (
                <span className="rounded-full bg-emerald-600 px-1.5 text-xs font-semibold text-white">
                  {inCart.qty}
                </span>
              )}
            </button>
          )
        })}
      </div>
      {lines.length === 0 ? (
        <p className="text-muted-foreground border-t px-4 py-6 text-center text-sm">
          No products yet. Pick from the list above.
        </p>
      ) : (
        <ul className="divide-y border-t">
          {lines.map((l) => {
            const name = meta.products.find((p) => p.sku === l.sku)?.name ?? l.sku
            const priced = pricing?.lines.find((x) => x.sku === l.sku)
            return (
              <li key={l.sku} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{name}</p>
                  <p className="text-muted-foreground font-mono text-xs">
                    {l.sku}
                    {priced === undefined ? "" : ` · ${eur(priced.unit_price_eur)} each`}
                    {priced !== undefined && priced.discount_pct > 0
                      ? ` (${String(priced.discount_pct)}% off list)`
                      : ""}
                  </p>
                </div>
                <div className="flex items-center rounded-md border">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Fewer ${name}`}
                    onClick={() => {
                      bump(l, -1)
                    }}
                  >
                    <Minus />
                  </Button>
                  <Input
                    type="number"
                    min={1}
                    value={l.qty}
                    aria-label={`Quantity of ${name}`}
                    className="h-8 w-16 border-0 text-center"
                    onChange={(e) => {
                      update(l.sku, { qty: e.target.value })
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`More ${name}`}
                    onClick={() => {
                      bump(l, 1)
                    }}
                  >
                    <Plus />
                  </Button>
                </div>
                <Input
                  type="number"
                  min={0}
                  step={0.01}
                  value={l.unit}
                  placeholder="Tier price"
                  title="Leave blank to use the list or tier price"
                  aria-label={`Agreed unit price for ${name}`}
                  className="h-8 w-28"
                  onChange={(e) => {
                    update(l.sku, { unit: e.target.value })
                  }}
                />
                <span className="w-24 text-right text-sm font-medium tabular-nums">
                  {priced === undefined ? "…" : eur(priced.revenue_eur)}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${name}`}
                  onClick={() => {
                    onChange(lines.filter((x) => x.sku !== l.sku))
                  }}
                >
                  <Trash2 />
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
