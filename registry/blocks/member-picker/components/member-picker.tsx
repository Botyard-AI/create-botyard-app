// Pick one member of the org. Pair it with useOrgMembers():
//
//   const members = useOrgMembers()
//   const [userId, setUserId] = useState<string | null>(null)
//   <MemberPicker members={members} value={userId} onChange={setUserId} />
//
// It is a search box over a list of radio buttons, so the keyboard and
// screen readers work the way they do for any radio group.
import { useId, useState } from "react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { initials } from "@/lib/initials"
import { filterMembers, memberLabel, type MembersState } from "@/lib/org-members"

/** At most this many matches are listed; typing narrows the rest. */
const MAX_SHOWN = 50

export type MemberPickerProps = {
  readonly members: MembersState
  /** The chosen member's user id, or null for nobody. */
  readonly value: string | null
  readonly onChange: (userId: string) => void
  readonly label?: string
}

export function MemberPicker({ members, value, onChange, label = "Member" }: MemberPickerProps) {
  const [query, setQuery] = useState("")
  const id = useId()

  if (members.status === "loading") {
    return (
      <p className="text-muted-foreground animate-pulse text-sm" aria-busy="true">
        Loading members…
      </p>
    )
  }
  if (members.status === "error") {
    return (
      <p className="text-destructive text-sm" role="alert">
        Could not load members: {members.message}
      </p>
    )
  }

  const matches = filterMembers(members.members, query)
  const shown = matches.slice(0, MAX_SHOWN)
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 text-sm font-medium">{label}</legend>
      <input
        type="search"
        aria-label={`Search ${label.toLowerCase()}`}
        placeholder="Search by name or email"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
        }}
        className="border-input bg-background h-9 rounded-md border px-3 text-sm"
      />
      <div className="grid max-h-72 gap-1 overflow-y-auto">
        {shown.map((member) => {
          const name = memberLabel(member)
          return (
            <label
              key={member.userId}
              className="hover:bg-accent has-checked:bg-accent has-focus-visible:ring-ring flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm has-focus-visible:ring-2"
            >
              <input
                type="radio"
                name={id}
                value={member.userId}
                checked={member.userId === value}
                onChange={() => {
                  onChange(member.userId)
                }}
                className="sr-only"
              />
              <Avatar className="size-7">
                <AvatarFallback className="text-xs">{initials(name)}</AvatarFallback>
              </Avatar>
              <span className="grid min-w-0">
                <span className="truncate font-medium">{name}</span>
                {member.email !== null && member.email !== name && (
                  <span className="text-muted-foreground truncate text-xs">{member.email}</span>
                )}
              </span>
              {member.role !== null && (
                <Badge variant="outline" className="ml-auto capitalize">
                  {member.role}
                </Badge>
              )}
            </label>
          )
        })}
      </div>
      <p className="text-muted-foreground text-xs" aria-live="polite">
        {summary(matches.length, shown.length)}
      </p>
    </fieldset>
  )
}

function summary(matched: number, shown: number): string {
  if (matched === 0) return "No member matches."
  if (matched > shown) return `Showing ${String(shown)} of ${String(matched)}. Type to narrow.`
  return `${String(matched)} ${matched === 1 ? "member" : "members"}`
}
