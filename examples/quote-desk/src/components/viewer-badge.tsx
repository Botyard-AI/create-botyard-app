import { Bot, UserRound, UserX } from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import type { Viewer } from "@/lib/api"
import { initials } from "@/lib/initials"

export type ViewerState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly viewer: Viewer | null }

const pill = "flex min-w-0 items-center gap-2 rounded-full border bg-card py-1 pr-3 pl-1 text-sm"

/** Who is looking at this page, as the Bot Page proxy and your org's member list say. */
export function ViewerBadge({ state }: Readonly<{ state: ViewerState }>) {
  if (state.status === "loading") {
    return (
      <div className={`${pill} text-muted-foreground animate-pulse`} aria-busy="true">
        <Avatar>
          <AvatarFallback />
        </Avatar>
        Checking who you are…
      </div>
    )
  }
  if (state.status === "error") {
    return (
      <div className={`${pill} text-destructive`} role="alert">
        <UserX className="ml-1 size-4" aria-hidden />
        Could not check who you are: {state.message}
      </div>
    )
  }

  const { viewer } = state
  if (viewer === null) {
    return (
      <div
        className={`${pill} text-muted-foreground border-dashed`}
        title="No Botyard sign-in reached the app. Open it through its Bot Page URL."
      >
        <UserX className="ml-1 size-4" aria-hidden />
        Not signed in
      </div>
    )
  }
  switch (viewer.kind) {
    case "member": {
      const name = viewer.name ?? viewer.email ?? viewer.userId
      return (
        <div className={pill} title={viewer.email ?? undefined}>
          <Avatar>
            {viewer.avatarUrl !== null && <AvatarImage src={viewer.avatarUrl} alt="" />}
            <AvatarFallback>{initials(name)}</AvatarFallback>
          </Avatar>
          <span className="text-muted-foreground">Signed in as</span>
          <span className="truncate font-medium">{name}</span>
          {viewer.role !== null && (
            <Badge variant="secondary" className="capitalize">
              {viewer.role}
            </Badge>
          )}
        </div>
      )
    }
    case "unknown":
      return (
        <div className={pill}>
          <UserRound className="ml-1 size-4" aria-hidden />
          <span className="truncate font-medium">{viewer.email ?? viewer.subject}</span>
          <Badge variant="outline">Not in this org</Badge>
        </div>
      )
    case "bot":
      return (
        <div className={pill}>
          <Bot className="ml-1 size-4" aria-hidden />
          <span className="truncate font-medium">A bot</span>
          <Badge variant="outline">{viewer.botId}</Badge>
        </div>
      )
  }
}
