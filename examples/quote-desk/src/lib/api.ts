// The viewer as /api/me returns it. Types come from @botyard/botpage (type
// imports only: nothing from the server package is bundled into the UI).
import type { BotViewer, MemberViewer, UnknownViewer, Viewer } from "@botyard/botpage"

export type { Viewer }

/** Reads /api/me. Throws when the request fails or the answer is malformed. */
export async function fetchViewer(signal?: AbortSignal): Promise<Viewer | null> {
  const res = await fetch("/api/me", {
    signal: signal ?? null,
    headers: { accept: "application/json" },
  })
  if (!res.ok) throw new Error(`/api/me answered ${String(res.status)}`)
  const body: unknown = await res.json()
  if (!isRecord(body) || !("viewer" in body)) throw new Error("/api/me: no viewer field")
  return parseViewer(body["viewer"])
}

/** Narrows untrusted JSON to a Viewer, or null for "nobody identified". */
export function parseViewer(value: unknown): Viewer | null {
  if (value === null) return null
  if (!isRecord(value)) throw new Error("viewer: not an object")
  const subject = str(value, "subject")
  const source = str(value, "source")
  switch (value["kind"]) {
    case "member": {
      const viewer: MemberViewer = {
        kind: "member",
        viewerType: "user",
        subject,
        source,
        userId: str(value, "userId"),
        email: strOrNull(value, "email"),
        name: strOrNull(value, "name"),
        role: strOrNull(value, "role"),
        avatarUrl: strOrNull(value, "avatarUrl"),
      }
      return viewer
    }
    case "unknown": {
      const viewerType = value["viewerType"] === "user" ? "user" : "unknown"
      const viewer: UnknownViewer = {
        kind: "unknown",
        viewerType,
        subject,
        source,
        email: strOrNull(value, "email"),
      }
      return viewer
    }
    case "bot": {
      const viewer: BotViewer = {
        kind: "bot",
        viewerType: "bot",
        subject,
        source,
        botId: str(value, "botId"),
      }
      return viewer
    }
    default:
      throw new Error("viewer: unknown kind")
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function str(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== "string") throw new Error(`viewer.${key}: not a string`)
  return value
}

function strOrNull(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  if (value === null || value === undefined) return null
  if (typeof value !== "string") throw new Error(`viewer.${key}: not a string`)
  return value
}
