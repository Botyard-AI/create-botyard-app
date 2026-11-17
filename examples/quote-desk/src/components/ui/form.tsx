import type { ComponentProps, ReactNode } from "react"
import { cn } from "@/lib/utils"

const control =
  "h-9 w-full rounded-md border bg-card px-3 text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"

function Input({ className, ...props }: Readonly<ComponentProps<"input">>) {
  return <input data-slot="input" className={cn(control, className)} {...props} />
}

function Select({ className, ...props }: Readonly<ComponentProps<"select">>) {
  return <select data-slot="select" className={cn(control, "pr-8", className)} {...props} />
}

/** A labelled form control. */
function Field({
  label,
  htmlFor,
  hint,
  children,
}: Readonly<{ label: string; htmlFor: string; hint?: ReactNode; children: ReactNode }>) {
  return (
    <div className="grid gap-1.5">
      <label
        htmlFor={htmlFor}
        className="text-muted-foreground text-xs font-medium tracking-wide uppercase"
      >
        {label}
      </label>
      {children}
      {hint}
    </div>
  )
}

/** A row of mutually exclusive choices, as buttons. */
function Choice({
  label,
  value,
  options,
  onChange,
}: Readonly<{
  label: string
  value: string
  options: readonly { value: string; label: string; hint?: string }[]
  onChange: (value: string) => void
}>) {
  return (
    <div className="grid gap-1.5">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</p>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => {
              onChange(o.value)
            }}
            className={cn(
              "rounded-md border px-3 py-1.5 text-sm transition-colors",
              value === o.value
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-card hover:bg-muted"
            )}
          >
            {o.label}
            {o.hint === undefined ? null : (
              <span className="ml-1.5 text-xs opacity-70">{o.hint}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

export { Choice, Field, Input, Select }
