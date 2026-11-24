import { useSyncExternalStore } from "react"
import {
  isSessionExpiredNow,
  SESSION_EXPIRED_MESSAGE,
  subscribeSessionExpired,
} from "@/lib/api-fetch"

// Tells the user their Botyard sign-in ran out, with a button to reload. It
// shows only in "prompt" mode (see configureApiFetch in src/lib/api-fetch.ts),
// or when a reload just now did not sign them back in. Render it once, near
// the top of the app.

export function SessionExpiredBanner() {
  const expired = useSyncExternalStore(subscribeSessionExpired, isSessionExpiredNow, () => false)
  if (!expired) return null
  return (
    <SessionExpiredNotice
      onReload={() => {
        window.location.reload()
      }}
    />
  )
}

/** The banner itself, without the state behind it. */
export function SessionExpiredNotice({ onReload }: { readonly onReload: () => void }) {
  return (
    <div
      role="alert"
      className="bg-destructive/10 text-destructive flex flex-wrap items-center justify-between gap-3 border-b px-6 py-3 text-sm"
    >
      <span>{SESSION_EXPIRED_MESSAGE}</span>
      <button
        type="button"
        onClick={onReload}
        className="bg-destructive hover:bg-destructive/90 focus-visible:ring-ring rounded-md px-3 py-1.5 font-medium text-white focus-visible:ring-2 focus-visible:outline-none"
      >
        Reload
      </button>
    </div>
  )
}
