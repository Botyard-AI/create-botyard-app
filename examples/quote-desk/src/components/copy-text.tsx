import { Check, Copy } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"

/** Text to pass on to someone, with a button that copies it. */
export function CopyText({ text, label = "Copy" }: Readonly<{ text: string; label?: string }>) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="grid gap-1.5">
      <pre className="bg-card rounded-md border px-3 py-2 text-xs whitespace-pre-wrap">{text}</pre>
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true)
            })
          }}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? "Copied" : label}
        </Button>
      </div>
    </div>
  )
}
