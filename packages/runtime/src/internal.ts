/** Small helpers shared by the transports. Not exported from the package. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const MAX_MESSAGE_CHARS = 2000

/** Clamp an external string before it goes into an error message. */
export function bounded(value: string, max = MAX_MESSAGE_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/** The text blocks of an MCP `content` array, joined. */
export function contentText(content: readonly unknown[]): string {
  return content
    .filter((block): block is { type: "text"; text: string } => {
      return isRecord(block) && block["type"] === "text" && typeof block["text"] === "string"
    })
    .map((block) => block.text)
    .join("\n")
}

/** A deadline merged with the caller's signal. Call `dispose()` when done. */
export interface Deadline {
  readonly signal: AbortSignal
  /** True when the deadline, not the caller, ended the request. */
  timedOut(): boolean
  dispose(): void
}

export function deadline(timeoutMs: number, callerSignal: AbortSignal | undefined): Deadline {
  const controller = new AbortController()
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    controller.abort(new DOMException("deadline exceeded", "TimeoutError"))
  }, timeoutMs)
  const onAbort = (): void => controller.abort(callerSignal?.reason)
  if (callerSignal?.aborted) {
    onAbort()
  } else {
    callerSignal?.addEventListener("abort", onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose: () => {
      clearTimeout(timer)
      callerSignal?.removeEventListener("abort", onAbort)
    },
  }
}

export function describeEnd(d: Deadline): string {
  return d.timedOut() ? "the deadline passed" : "the call was aborted"
}
