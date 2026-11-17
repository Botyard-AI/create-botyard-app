import type { MemberOption } from "../../../shared/types.ts"

type Props = Readonly<{
  label: string
  members: readonly MemberOption[]
  /** Selected members, by user id. */
  value: readonly string[]
  disabled: boolean
  onChange: (userIds: string[]) => void
}>

/** Org members as checkboxes. Approval rights follow the member (user id), not an email. */
export function ApproverPicker({ label, members, value, disabled, onChange }: Props) {
  // Someone configured earlier who has since left the org still shows, so they can be removed.
  const gone = value.filter((id) => !members.some((m) => m.user_id === id))
  const toggle = (id: string, on: boolean) => {
    onChange(on ? [...value, id] : value.filter((v) => v !== id))
  }
  return (
    <fieldset className="grid gap-1.5" disabled={disabled}>
      <legend className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">
        {label}
      </legend>
      {members.map((m) => (
        <label key={m.user_id} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.includes(m.user_id)}
            onChange={(e) => {
              toggle(m.user_id, e.target.checked)
            }}
          />
          {m.name} <span className="text-muted-foreground">{m.email ?? ""}</span>
        </label>
      ))}
      {gone.map((id) => (
        <label key={id} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked
            onChange={() => {
              toggle(id, false)
            }}
          />
          <span className="font-mono text-xs">{id}</span>{" "}
          <span className="text-destructive text-xs">no longer in the org</span>
        </label>
      ))}
    </fieldset>
  )
}
