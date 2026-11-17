import { Notice } from "@/components/ui/bits"

/** Where verdict files may be read from: QUOTE_DESK_FILE_HOSTS. */
export function FileHostsNote({ hosts }: Readonly<{ hosts: readonly string[] }>) {
  if (hosts.length === 0)
    return (
      <Notice tone="warn">
        QUOTE_DESK_FILE_HOSTS is not set, so the app can&apos;t read the reviewer bot&apos;s
        verdict.json: every review comes back to a finance approver.
      </Notice>
    )
  return (
    <p className="text-muted-foreground text-xs">
      Verdict files are read from {hosts.join(", ")} (QUOTE_DESK_FILE_HOSTS).
    </p>
  )
}
