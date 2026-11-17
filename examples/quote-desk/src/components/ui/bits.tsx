import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/** A titled section of a page. */
function Panel({
  title,
  aside,
  children,
  className,
}: Readonly<{ title: string; aside?: ReactNode; children: ReactNode; className?: string }>) {
  return (
    <section className={cn("bg-card rounded-xl border", className)}>
      <header className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  )
}

/** A label and a value on one line. */
function Row({ k, v, strong = false }: Readonly<{ k: string; v: string; strong?: boolean }>) {
  return (
    <div
      className={cn(
        "flex justify-between gap-3",
        strong && "border-t pt-2 text-base font-semibold"
      )}
    >
      <dt className={strong ? undefined : "text-muted-foreground"}>{k}</dt>
      <dd className="tabular-nums">{v}</dd>
    </div>
  )
}

/** A value against a limit, as a bar with a marker. */
function Gauge({
  label,
  value,
  limit,
  max,
  good,
  hint,
}: Readonly<{
  label: string
  value: number
  limit: number
  max: number
  good: "above" | "below"
  hint: string
}>) {
  const ok = good === "above" ? value >= limit : value <= limit
  const pos = (v: number) => `${String(Math.max(0, Math.min(100, (v / max) * 100)))}%`
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {label}
        </span>
        <span className={cn("text-lg font-semibold tabular-nums", !ok && "text-destructive")}>
          {value}%
        </span>
      </div>
      <div className="bg-muted relative h-2 rounded-full">
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full",
            ok ? "bg-emerald-600" : "bg-destructive"
          )}
          style={{ width: pos(value) }}
        />
        <div
          className="bg-foreground absolute -top-1 h-4 w-0.5 rounded"
          style={{ left: pos(limit) }}
        />
      </div>
      <p className="text-muted-foreground text-xs">{hint}</p>
    </div>
  )
}

const tones = {
  ok: "bg-emerald-50 text-emerald-900 ring-emerald-200",
  warn: "bg-amber-50 text-amber-950 ring-amber-200",
  error: "bg-red-50 text-red-900 ring-red-200",
  muted: "bg-muted text-muted-foreground ring-border",
} as const

/** A short message box. */
function Notice({
  tone,
  children,
  role,
}: Readonly<{ tone: keyof typeof tones; children: ReactNode; role?: "alert" | "status" }>) {
  return (
    <div role={role} className={cn("rounded-lg px-3 py-2 text-sm ring-1 ring-inset", tones[tone])}>
      {children}
    </div>
  )
}

export { Gauge, Notice, Panel, Row }
