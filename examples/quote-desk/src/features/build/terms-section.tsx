import type { Meta } from "../../../shared/types.ts"
import { Panel } from "@/components/ui/bits"
import { Choice, Field, Input, Select } from "@/components/ui/form"
import { eur } from "@/lib/format"
import type { Draft } from "./use-draft"

type Props = Readonly<{
  meta: Meta
  draft: Draft
  usualTerritory: string | null
  onChange: (patch: Partial<Draft>) => void
}>

export function TermsSection({ meta, draft, usualTerritory, onChange }: Props) {
  const discount = Number(draft.discount) || 0
  return (
    <Panel title="3 · Delivery, terms and discount">
      <div className="grid gap-5 p-4 md:grid-cols-2">
        <Choice
          label="Delivery"
          value={draft.deliveryOption}
          options={meta.delivery_options.map((o) => ({
            value: o.code,
            label: o.label,
            hint: eur(o.cost_eur),
          }))}
          onChange={(deliveryOption) => {
            onChange({ deliveryOption })
          }}
        />
        <Choice
          label="Payment terms"
          value={draft.terms}
          options={meta.payment_terms.map((t) => ({ value: t.code, label: t.label }))}
          onChange={(terms) => {
            onChange({ terms })
          }}
        />
        <Field
          label="Territory"
          htmlFor="territory"
          hint={
            usualTerritory !== null && usualTerritory !== draft.territory ? (
              <p className="text-xs text-amber-800">
                This customer usually sits in {usualTerritory}.
              </p>
            ) : null
          }
        >
          <Select
            id="territory"
            value={draft.territory}
            onChange={(e) => {
              onChange({ territory: e.target.value })
            }}
          >
            {meta.territories.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        </Field>
        <Field label="Delivery region" htmlFor="region">
          <Select
            id="region"
            value={draft.region}
            onChange={(e) => {
              onChange({ region: e.target.value })
            }}
          >
            {meta.regions.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
        </Field>
        <Field
          label="Order discount (%)"
          htmlFor="discount"
          hint={
            <p className="text-muted-foreground text-xs">
              Applied before delivery. An effective discount over{" "}
              {meta.settings.discount_escalation_pct}% off list escalates to finance.
            </p>
          }
        >
          <Input
            id="discount"
            type="number"
            min={0}
            max={50}
            step={0.5}
            value={draft.discount}
            onChange={(e) => {
              onChange({ discount: e.target.value })
            }}
          />
        </Field>
        {discount > 0 ? (
          <Field
            label="Reason for finance"
            htmlFor="reason"
            hint={
              draft.reason.trim() === "" ? (
                <p className="text-xs text-amber-800">
                  Finance always asks why. Adding a reason saves a round trip.
                </p>
              ) : null
            }
          >
            <Input
              id="reason"
              maxLength={200}
              value={draft.reason}
              placeholder="e.g. multi-year contract, competitor match"
              onChange={(e) => {
                onChange({ reason: e.target.value })
              }}
            />
          </Field>
        ) : null}
      </div>
    </Panel>
  )
}
