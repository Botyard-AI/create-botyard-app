import { MessageSquarePlus } from "lucide-react"
import { useId, useState } from "react"
import type { QuoteView } from "../../shared/types.ts"
import { Button } from "@/components/ui/button"
import { addComment } from "@/lib/quotes-api"

/** Add a note to a quote's history, as the signed-in viewer. */
export function CommentBox({
  quote,
  onAdded,
}: Readonly<{ quote: QuoteView; onAdded: (quote: QuoteView) => void }>) {
  const id = useId()
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      onAdded(await addComment(quote.id, text.trim()))
      setText("")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <label htmlFor={id} className="sr-only">
        Comment
      </label>
      <textarea
        id={id}
        rows={2}
        maxLength={2000}
        placeholder="Add a comment"
        className="bg-card focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
        }}
      />
      <div>
        <Button type="submit" size="sm" variant="outline" disabled={busy || text.trim() === ""}>
          <MessageSquarePlus aria-hidden />
          Comment
        </Button>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </form>
  )
}
